// Perception: turns the filtered per-player observation stream into memory, goal candidates and feature vectors.
// Used by bots (to act) and by the server to record imitation samples from human players.
import { DT, ITEM_KEYS } from '../shared/constants.js';

export const G_SIZE = 24;
export const C_SIZE = 14;

const waypointCache = new Map();
export function waypoints(map) {
  if (!waypointCache.has(map.id)) {
    const out = [];
    for (let y = 1; y < map.h - 1; y += 2) {
      for (let x = 1; x < map.w - 1; x += 2) {
        const t = map.tile(x, y);
        if (t.solid || t.name === 'water') continue;
        if (map.collides(x + 0.5, y + 0.5)) continue;
        out.push({ x: x + 0.5, y: y + 0.5, bush: !!t.bush, lit: map.isLit(x + 0.5, y + 0.5) });
      }
    }
    waypointCache.set(map.id, out);
  }
  return waypointCache.get(map.id);
}

export class Perception {
  constructor(map, id) {
    this.map = map;
    this.id = id;
    this.enemies = new Map(); // id -> {x,y,t}
    this.ripples = new Map(); // id -> {x,y,r,kind,t}
    this.hints = []; // {x,y,t} echoes, markers
    this.visited = new Float64Array(Math.ceil(map.w / 3) * Math.ceil(map.h / 3)).fill(-1e9);
    this.time = 0;
    this.lastInfo = 0;
    this.obs = null;
  }

  update(obs) {
    this.obs = obs;
    this.time = obs.tick * DT;
    const me = obs.you;
    for (const p of obs.players) {
      if (p.role !== me.role) {
        this.enemies.set(p.id, { x: p.x, y: p.y, t: this.time });
        this.lastInfo = this.time;
      } else this.enemies.delete(p.id); // a former enemy (caught hider) now on my team
    }
    for (const r of obs.ripples) {
      if (!this.ripples.has(r.id)) {
        this.ripples.set(r.id, { x: r.x, y: r.y, r: r.r, kind: r.kind, t: this.time - r.age });
        this.lastInfo = this.time;
      }
    }
    for (const e of obs.echoes || []) this.hints.push({ x: e.x, y: e.y, t: this.time });
    for (const m of obs.markers || []) if (m.by !== this.id) this.hints.push({ x: m.x, y: m.y, t: this.time - (6 - m.left) });
    for (const [k, r] of this.ripples) if (this.time - r.t > 10) this.ripples.delete(k);
    for (const [k, e] of this.enemies) if (this.time - e.t > 15) this.enemies.delete(k);
    this.hints = this.hints.filter((h) => this.time - h.t < 6).slice(-12);
    const cw = Math.ceil(this.map.w / 3);
    this.visited[Math.floor(me.y / 3) * cw + Math.floor(me.x / 3)] = this.time;
  }

  visitedRecency(x, y) {
    const cw = Math.ceil(this.map.w / 3);
    const t = this.visited[Math.floor(y / 3) * cw + Math.floor(x / 3)] ?? -1e9;
    return Math.max(0, 1 - (this.time - t) / 45);
  }

  // Known threats for a hider: visible/remembered seekers + loud seeker ripples.
  threats() {
    const out = [];
    for (const e of this.enemies.values()) out.push({ x: e.x, y: e.y, fresh: Math.max(0, 1 - (this.time - e.t) / 12) });
    if (this.obs?.you.role === 'hider') {
      for (const r of this.ripples.values()) out.push({ x: r.x, y: r.y, fresh: Math.max(0, 1 - (this.time - r.t) / 8) * 0.8 });
    }
    return out.filter((t) => t.fresh > 0);
  }

  threatDistance(x, y, threats = this.threats()) {
    let best = 30;
    for (const t of threats) {
      const d = Math.hypot(t.x - x, t.y - y) / Math.max(0.3, t.fresh);
      if (d < best) best = d;
    }
    return best;
  }

  candidates() {
    const obs = this.obs;
    const me = obs.you;
    const map = this.map;
    const out = [{ kind: 'stay', x: me.x, y: me.y }];
    const wps = waypoints(map);
    // 8 directional waypoints at ~6 tiles
    const best = new Array(8).fill(null);
    const bestScore = new Array(8).fill(Infinity);
    for (const w of wps) {
      const dx = w.x - me.x, dy = w.y - me.y;
      const d = Math.hypot(dx, dy);
      if (d < 3 || d > 10) continue;
      const oct = (Math.round((Math.atan2(dy, dx) / (Math.PI * 2)) * 8) + 8) % 8;
      const s = Math.abs(d - 6);
      if (s < bestScore[oct]) {
        bestScore[oct] = s;
        best[oct] = w;
      }
    }
    for (const w of best) if (w) out.push({ kind: 'wp', x: w.x, y: w.y });
    // far waypoints
    const threats = this.threats();
    const far = [];
    for (const w of wps) {
      const d = Math.hypot(w.x - me.x, w.y - me.y);
      if (d < 8 || d > 24) continue;
      const v = me.role === 'seeker'
        ? 1 - this.visitedRecency(w.x, w.y) + (w.x * 7 + w.y * 13 + Math.floor(this.time / 20)) % 10 / 40
        : this.threatDistance(w.x, w.y, threats) / 30 + (w.bush ? 0.3 : 0) - (w.lit ? 0.4 : 0);
      far.push([v, w]);
    }
    far.sort((a, b) => b[0] - a[0]);
    for (const [, w] of far.slice(0, 3)) out.push({ kind: 'far', x: w.x, y: w.y });
    // item pads
    if (!me.item) {
      const pads = obs.pads
        .filter((p) => p.side === me.role)
        .map((p) => ({ p, d: Math.hypot(p.x - me.x, p.y - me.y) }))
        .filter(({ p, d }) => p.readyIn <= d / 3 + 1)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      for (const { p } of pads) out.push({ kind: 'pad', x: p.x, y: p.y, item: p.item });
    }
    if (me.role === 'seeker') {
      for (const p of obs.players) if (p.role === 'hider') out.push({ kind: 'enemy', x: p.x, y: p.y, fresh: 1 });
      const rips = [...this.ripples.values()].sort((a, b) => b.t - a.t).slice(0, 3);
      for (const r of rips) out.push({ kind: 'ripple', x: r.x, y: r.y, fresh: Math.max(0, 1 - (this.time - r.t) / 8), heart: r.kind === 'heart' });
      for (const e of this.enemies.values()) {
        if (this.time - e.t > 0.2 && this.time - e.t < 10) out.push({ kind: 'memory', x: e.x, y: e.y, fresh: 1 - (this.time - e.t) / 10 });
      }
      for (const h of this.hints.slice(-3)) out.push({ kind: 'hint', x: h.x, y: h.y, fresh: Math.max(0, 1 - (this.time - h.t) / 6) });
    }
    for (const c of out) {
      c.dist = Math.hypot(c.x - me.x, c.y - me.y);
      c.threat = this.threatDistance(c.x, c.y, threats);
      c.lit = map.isLit(c.x, c.y, obs.flares) ? 1 : 0;
      c.bush = map.tileAtPos(c.x, c.y).bush ? 1 : 0;
      c.visited = this.visitedRecency(c.x, c.y);
      c.fresh = c.fresh ?? 0;
    }
    return out.slice(0, 24);
  }

  globalFeatures() {
    const obs = this.obs;
    const me = obs.you;
    const g = new Float64Array(G_SIZE);
    g[0] = me.role === 'seeker' ? 1 : 0;
    g[1] = obs.timeLeft / 300;
    g[2] = obs.phase === 'headstart' ? 1 : 0;
    g[3] = me.stamina / 100;
    g[4] = me.item ? 1 : 0;
    if (me.item) g[5 + ITEM_KEYS.indexOf(me.item)] = 1; // 5..12
    g[13] = Math.min(1.5, me.still / 20);
    g[14] = me.heart;
    const enemies = obs.players.filter((p) => p.role !== me.role);
    g[15] = Math.min(1, enemies.length / 3);
    let nd = 10;
    for (const e of enemies) nd = Math.min(nd, Math.hypot(e.x - me.x, e.y - me.y));
    g[16] = nd / 10;
    g[17] = Math.min(1, [...this.ripples.values()].filter((r) => this.time - r.t < 3).length / 3);
    const total = obs.counts.hiders + obs.counts.seekers;
    g[18] = total ? obs.counts.seekers / total : 0;
    g[19] = this.map.isLit(me.x, me.y, obs.flares) ? 1 : 0;
    g[20] = this.map.tileAtPos(me.x, me.y).bush ? 1 : 0;
    g[21] = obs.finalHush ? 1 : 0;
    g[22] = me.slowLeft > 0 ? 1 : 0;
    g[23] = Math.min(1, (this.time - this.lastInfo) / 20);
    return g;
  }

  candidateFeatures(c) {
    const me = this.obs.you;
    const f = new Float64Array(C_SIZE);
    f[0] = (c.x - me.x) / 15;
    f[1] = (c.y - me.y) / 15;
    f[2] = c.dist / 20;
    f[3] = c.kind === 'pad' ? 1 : 0;
    f[4] = c.kind === 'ripple' ? 1 : 0;
    f[5] = c.fresh;
    f[6] = c.kind === 'enemy' ? 1 : 0;
    f[7] = c.kind === 'memory' ? 1 : 0;
    f[8] = Math.min(1, c.threat / 15);
    f[9] = c.lit;
    f[10] = c.bush;
    f[11] = c.visited;
    f[12] = c.kind === 'stay' ? 1 : 0;
    f[13] = c.kind === 'hint' || c.kind === 'far' ? (c.kind === 'hint' ? 1 : 0.5) : 0;
    return f;
  }
}
