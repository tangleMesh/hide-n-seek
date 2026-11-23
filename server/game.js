// Pure, deterministic game simulation. No I/O, no timers, no randomness.
// The session layer feeds inputs and calls step(); state is fully serializable for snapshots.
import {
  DT, ROUND_SECONDS, HEADSTART_SECONDS, FINAL_HUSH_SECONDS, CATCH_DISTANCE, NOISE_BASE, NOISE_INTERVAL,
  NOISE_MIN, RIPPLE_TTL, HEARTBEAT, ITEMS, ITEM_PICKUP_RADIUS, PAD_RESPAWN, MARKER_TTL, STAMINA,
} from '../shared/constants.js';
import { stepMovement } from '../shared/physics.js';

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function clampToRange(from, x, y, range) {
  const dx = x - from.x, dy = y - from.y;
  const d = Math.hypot(dx, dy);
  if (!Number.isFinite(d)) return { x: from.x, y: from.y };
  if (d <= range) return { x, y };
  return { x: from.x + (dx / d) * range, y: from.y + (dy / d) * range };
}

export class Game {
  /**
   * @param {import('../shared/map.js').GameMap} map
   * @param {object} opts { id, playerIds, seekerIds, roundSeconds, headstart }
   */
  constructor(map, opts) {
    this.map = map;
    this.events = [];
    this.inputs = new Map();
    this.actions = [];
    if (opts.state) {
      this.state = opts.state;
      return;
    }
    const seekerSet = new Set(opts.seekerIds);
    const players = {};
    let hi = 0, si = 0;
    for (const id of opts.playerIds) {
      const seeker = seekerSet.has(id);
      const sp = seeker
        ? map.spawns.seekers[si++ % map.spawns.seekers.length]
        : map.spawns.hiders[hi++ % map.spawns.hiders.length];
      players[id] = {
        id, role: seeker ? 'seeker' : 'hider', startRole: seeker ? 'seeker' : 'hider',
        x: sp.x, y: sp.y, aim: seeker ? -Math.PI / 2 : 0, stamina: STAMINA.max, mode: 'idle', lastMode: 'idle',
        item: null, caughtAt: null, caughtBy: null, catches: 0,
        slowLeft: 0, softLeft: 0, calmLeft: 0, wideLeft: 0,
        anchorX: sp.x, anchorY: sp.y, stillTime: 0, heartCd: 0, finalCd: 0, noiseCd: 0,
        tileKey: -1, lastSeq: 0,
      };
    }
    this.state = {
      id: opts.id,
      mapId: map.id,
      roundSeconds: opts.roundSeconds ?? ROUND_SECONDS,
      headstart: opts.headstart ?? HEADSTART_SECONDS,
      tick: 0,
      time: 0,
      phase: 'headstart',
      winner: null,
      initialHiders: opts.playerIds.length - seekerSet.size,
      lastHiderBonus: false,
      players,
      pads: map.pads.map((p) => ({ ...p, side: ITEMS[p.item].side, readyIn: 0 })),
      ripples: [],
      pending: [],
      smokes: [],
      flares: [],
      traps: [],
      markers: [],
      echoes: [],
      nextId: 1,
    };
  }

  static fromSnapshot(map, state) {
    return new Game(map, { state: structuredClone(state) });
  }

  serialize() {
    return structuredClone(this.state);
  }

  get endTime() {
    return this.state.headstart + this.state.roundSeconds;
  }
  get timeLeft() {
    return Math.max(0, this.endTime - this.state.time);
  }
  get headstartLeft() {
    return Math.max(0, this.state.headstart - this.state.time);
  }
  get finalHush() {
    return this.state.phase === 'play' && this.timeLeft <= FINAL_HUSH_SECONDS;
  }

  hiders() {
    return Object.values(this.state.players).filter((p) => p.role === 'hider');
  }
  seekers() {
    return Object.values(this.state.players).filter((p) => p.role === 'seeker');
  }

  setInput(id, input) {
    if (!this.state.players[id]) return;
    this.inputs.set(id, input);
  }
  queueAction(id, action) {
    if (!this.state.players[id]) return;
    this.actions.push({ id, ...action });
  }

  addRipple(x, y, r, kind, src, by) {
    this.state.ripples.push({ id: this.state.nextId++, x, y, r, age: 0, ttl: RIPPLE_TTL, kind, src, by });
  }

  step(dt = DT) {
    const s = this.state;
    if (s.phase === 'ended') return;
    this.events = [];
    s.tick++;
    s.time += dt;

    if (s.phase === 'headstart' && s.time >= s.headstart) {
      s.phase = 'play';
      this.events.push({ type: 'phase', phase: 'play' });
    }

    // timers & ephemeral objects
    for (const list of ['ripples', 'smokes', 'flares', 'markers', 'echoes', 'traps']) {
      s[list] = s[list].filter((o) => {
        if ('ttl' in o) {
          o.age += dt;
          return o.age < o.ttl;
        }
        o.left -= dt;
        return o.left > 0;
      });
    }
    s.pending = s.pending.filter((pe) => {
      pe.at -= dt;
      if (pe.at > 0) return true;
      this.addRipple(pe.x, pe.y, pe.r, pe.kind, pe.src, pe.by);
      return false;
    });
    for (const pad of s.pads) if (pad.readyIn > 0) pad.readyIn = Math.max(0, pad.readyIn - dt);

    // movement + noise
    for (const p of Object.values(s.players)) {
      for (const k of ['slowLeft', 'softLeft', 'calmLeft', 'wideLeft']) if (p[k] > 0) p[k] = Math.max(0, p[k] - dt);
      const input = this.inputs.get(p.id) || { dx: 0, dy: 0, mode: 'walk' };
      if (Number.isFinite(input.aim)) p.aim = input.aim;
      if (input.seq) p.lastSeq = input.seq;
      p.frozen = p.role === 'seeker' && s.phase === 'headstart';
      p.mode = stepMovement(this.map, p, input, dt);
      this.noise(p, dt);
    }

    // actions (item use, markers)
    const actions = this.actions;
    this.actions = [];
    for (const a of actions) this.applyAction(a);

    if (s.phase === 'play') {
      this.pickups();
      this.trapsCheck();
      this.heartbeats(dt);
      this.catches();
      this.checkEnd();
    } else {
      this.pickups();
    }
  }

  noise(p, dt) {
    const s = this.state;
    p.noiseCd = Math.max(0, p.noiseCd - dt);
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    const key = ty * this.map.w + tx;
    const tile = this.map.tile(tx, ty);
    if (key !== p.tileKey) {
      if (p.tileKey !== -1 && tile.door && p.mode !== 'idle' && !(p.frozen)) {
        this.addRipple(tx + 0.5, ty + 0.5, 3, 'door', p.role, p.id);
      }
      p.tileKey = key;
    }
    if (p.mode === 'idle' || p.frozen) return;
    if (p.mode === 'sprint' && p.softLeft > 0) return;
    const loud = NOISE_BASE[p.mode] * (tile.noiseMul ?? 1) + (tile.noiseAdd ?? 0) * (p.mode === 'sneak' ? 0.6 : 1);
    if (loud >= NOISE_MIN && p.noiseCd <= 0) {
      this.addRipple(p.x, p.y, loud, 'step', p.role, p.id);
      p.noiseCd = NOISE_INTERVAL;
    }
    if (s.phase === 'headstart') return;
  }

  applyAction(a) {
    const s = this.state;
    const p = s.players[a.id];
    if (!p) return;
    if (a.type === 'marker') {
      if (p.role !== 'seeker' || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return;
      s.markers = s.markers.filter((m) => m.by !== p.id);
      s.markers.push({ by: p.id, x: a.x, y: a.y, left: MARKER_TTL });
      return;
    }
    if (a.type !== 'use' || !p.item || p.frozen) return;
    const def = ITEMS[p.item];
    if (def.side !== p.role) return;
    const tx = Number.isFinite(a.x) ? a.x : p.x;
    const ty = Number.isFinite(a.y) ? a.y : p.y;
    const item = p.item;
    p.item = null;
    switch (item) {
      case 'decoy': {
        const t = clampToRange(p, tx, ty, def.range);
        for (let i = 0; i < 3; i++) {
          s.pending.push({ at: i * 0.55, x: t.x + (i - 1) * 0.6, y: t.y + (i % 2) * 0.4, r: 4.5, kind: 'step', src: 'hider', by: null });
        }
        break;
      }
      case 'smoke': {
        const t = clampToRange(p, tx, ty, def.range);
        s.smokes.push({ id: s.nextId++, x: t.x, y: t.y, r: def.radius, left: def.duration });
        break;
      }
      case 'softshoes':
        p.softLeft = def.duration;
        break;
      case 'calm':
        p.calmLeft = def.duration;
        p.stillTime = 0;
        p.heartCd = 0;
        break;
      case 'flare': {
        const t = clampToRange(p, tx, ty, def.range);
        s.flares.push({ id: s.nextId++, x: t.x, y: t.y, r: def.radius, left: def.duration });
        break;
      }
      case 'trap':
        s.traps.push({ id: s.nextId++, x: p.x, y: p.y, left: def.lifetime, owner: p.id });
        break;
      case 'widebeam':
        p.wideLeft = def.duration;
        break;
      case 'echo':
        for (const h of this.hiders()) {
          if (h.calmLeft > 0) continue;
          if (dist2(h, p) <= def.radius ** 2) s.echoes.push({ x: h.x, y: h.y, left: def.duration });
        }
        this.addRipple(p.x, p.y, def.radius, 'echo', 'seeker', p.id);
        break;
    }
    this.events.push({ type: 'use', id: p.id, item });
  }

  pickups() {
    const s = this.state;
    for (const pad of s.pads) {
      if (pad.readyIn > 0) continue;
      for (const p of Object.values(s.players)) {
        if (p.item || p.role !== pad.side || p.frozen) continue;
        if (dist2(p, pad) <= ITEM_PICKUP_RADIUS ** 2) {
          p.item = pad.item;
          pad.readyIn = PAD_RESPAWN;
          this.events.push({ type: 'pickup', id: p.id, item: pad.item, pad: pad.id });
          break;
        }
      }
    }
  }

  trapsCheck() {
    const s = this.state;
    s.traps = s.traps.filter((t) => {
      for (const h of this.hiders()) {
        if (dist2(h, t) <= ITEMS.trap.radius ** 2) {
          h.slowLeft = 3;
          this.addRipple(h.x, h.y, 8, 'trap', 'hider', h.id);
          this.events.push({ type: 'trap', id: h.id, owner: t.owner });
          return false;
        }
      }
      return true;
    });
  }

  heartbeats(dt) {
    const final = this.finalHush;
    for (const h of this.hiders()) {
      if ((h.x - h.anchorX) ** 2 + (h.y - h.anchorY) ** 2 > HEARTBEAT.anchorRadius ** 2) {
        h.anchorX = h.x;
        h.anchorY = h.y;
        h.stillTime = 0;
      } else {
        h.stillTime += dt;
      }
      if (final) {
        h.finalCd -= dt;
        if (h.finalCd <= 0) {
          this.addRipple(h.x, h.y, HEARTBEAT.finalRadius, 'heart', 'hider', h.id);
          h.finalCd = HEARTBEAT.finalInterval;
        }
        continue;
      }
      if (h.calmLeft > 0) continue;
      if (h.stillTime >= HEARTBEAT.stillAfter) {
        h.heartCd -= dt;
        if (h.heartCd <= 0) {
          this.addRipple(h.x, h.y, HEARTBEAT.radius, 'heart', 'hider', h.id);
          h.heartCd = HEARTBEAT.interval;
        }
      } else {
        h.heartCd = 0;
      }
    }
  }

  catches() {
    const s = this.state;
    const seekers = this.seekers();
    for (const h of this.hiders()) {
      for (const k of seekers) {
        if (dist2(h, k) > CATCH_DISTANCE ** 2) continue;
        if (!this.map.los(k.x, k.y, h.x, h.y)) continue;
        h.role = 'seeker';
        h.caughtAt = s.time;
        h.caughtBy = k.id;
        h.item = null;
        h.calmLeft = 0;
        h.softLeft = 0;
        k.catches++;
        this.events.push({ type: 'caught', id: h.id, by: k.id });
        break;
      }
    }
    const left = this.hiders();
    if (left.length === 1 && s.initialHiders > 1 && !s.lastHiderBonus) {
      s.lastHiderBonus = true;
      left[0].calmLeft = ITEMS.calm.duration;
      left[0].stillTime = 0;
      this.events.push({ type: 'lastHider', id: left[0].id });
    }
  }

  checkEnd() {
    const s = this.state;
    if (this.hiders().length === 0) this.end('seekers');
    else if (s.time >= this.endTime) this.end('hiders');
  }

  end(winner) {
    this.state.phase = 'ended';
    this.state.winner = winner;
    this.events.push({ type: 'end', winner });
  }

  // Match score per player in [0,1] used for ELO and bot fitness.
  scores() {
    const s = this.state;
    const out = {};
    const caught = Object.values(s.players).filter((p) => p.startRole === 'hider' && p.caughtAt !== null).length;
    const frac = s.initialHiders ? caught / s.initialHiders : 0;
    for (const p of Object.values(s.players)) {
      if (p.startRole === 'seeker') out[p.id] = frac;
      else if (p.caughtAt === null) out[p.id] = 1;
      else {
        const survived = Math.max(0, p.caughtAt - s.headstart) / s.roundSeconds;
        out[p.id] = Math.min(0.6, 0.4 * Math.min(1, survived) + 0.1 * p.catches);
      }
    }
    return out;
  }
}
