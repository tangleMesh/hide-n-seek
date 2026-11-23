// Bot controller: perception → brain (prior + residual) → goal → A* path → per-tick input.
// Bots only ever receive the same filtered observation a human client gets.
import { DT, ITEMS } from '../shared/constants.js';
import { findPath } from '../shared/map.js';
import { Perception } from './features.js';
import { candidatePrior, modePrior, scoreCandidates, headOutputs, softmax, MODES, DEFAULT_TRAITS } from './brain.js';
import { mulberry32, gaussian } from './rng.js';

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export class BotController {
  constructor(map, id, brain, { traits = {}, seed = 1, tilt = 0 } = {}) {
    this.map = map;
    this.id = id;
    this.brain = brain;
    this.traits = { ...DEFAULT_TRAITS, ...traits };
    this.tilt = tilt;
    this.rnd = mulberry32(seed);
    this.perception = new Perception(map, id);
    this.buffer = [];
    this.goal = null;
    this.path = [];
    this.nextDecision = 0;
    this.nextPath = 0;
    this.mode = 'walk';
    this.hesitateUntil = 0;
    this.lastPos = null;
    this.stuckTime = 0;
    this.seq = 0;
    this.lastEnemyCount = 0;
    this.role = null;
  }

  get delayTicks() {
    return Math.max(0, Math.round(this.traits.reactionMs / 1000 / DT));
  }

  act(obs) {
    this.buffer.push(obs);
    if (this.buffer.length > 30) this.buffer.shift();
    const delayed = this.buffer[Math.max(0, this.buffer.length - 1 - this.delayTicks)];
    const view = { ...delayed, you: obs.you, pads: obs.pads, tick: obs.tick, timeLeft: obs.timeLeft, phase: obs.phase, counts: obs.counts };
    const p = this.perception;
    p.update(view);
    const me = obs.you;
    const t = p.time;
    if (this.role !== me.role) {
      // role switched (caught) → forget goal
      this.role = me.role;
      this.goal = null;
      this.nextDecision = 0;
    }
    const actions = [];
    const enemyCount = view.players.filter((q) => q.role !== me.role).length;
    const newThreat = enemyCount > this.lastEnemyCount;
    this.lastEnemyCount = enemyCount;

    if (me.frozen) return { input: { dx: 0, dy: 0, mode: 'walk', aim: me.aim, seq: ++this.seq }, actions };

    if (t >= this.nextDecision || newThreat || !this.goal) {
      this.decide(view, actions);
      this.nextDecision = t + 0.45 + this.rnd() * 0.35 + this.traits.reactionMs / 2000;
    }

    if (t < this.hesitateUntil) return { input: { dx: 0, dy: 0, mode: this.mode, aim: me.aim, seq: ++this.seq }, actions };

    // stuck detection
    if (this.lastPos && Math.hypot(me.x - this.lastPos.x, me.y - this.lastPos.y) < 0.02 && this.goal && this.goal.kind !== 'stay') {
      this.stuckTime += DT;
    } else this.stuckTime = 0;
    this.lastPos = { x: me.x, y: me.y };

    let dx = 0, dy = 0;
    const g = this.goal;
    if (g && g.kind !== 'stay') {
      const gd = Math.hypot(g.x - me.x, g.y - me.y);
      const direct = gd < 2.5 && this.map.los(me.x, me.y, g.x, g.y);
      if (direct) {
        dx = g.x - me.x;
        dy = g.y - me.y;
        if (gd < 0.25) this.goal = { kind: 'stay', x: me.x, y: me.y };
      } else {
        if (t >= this.nextPath || !this.path || this.stuckTime > 0.6) {
          this.path = findPath(this.map, me.x, me.y, g.x, g.y, 3000) || [];
          this.nextPath = t + 1.2;
          this.stuckTime = 0;
        }
        while (this.path.length && Math.hypot(this.path[0][0] - me.x, this.path[0][1] - me.y) < 0.35) this.path.shift();
        // skip ahead to furthest visible point (smoother movement)
        if (this.path.length > 1 && this.map.los(me.x, me.y, this.path[1][0], this.path[1][1]) && !this.map.collides((me.x + this.path[1][0]) / 2, (me.y + this.path[1][1]) / 2)) this.path.shift();
        if (this.path.length) {
          dx = this.path[0][0] - me.x;
          dy = this.path[0][1] - me.y;
        } else if (gd > 0.3) {
          dx = g.x - me.x;
          dy = g.y - me.y;
        }
      }
    }
    const len = Math.hypot(dx, dy);
    let aim = me.aim;
    if (len > 0.01) {
      const jitter = gaussian(this.rnd) * this.traits.mistakeRate * 0.5;
      const a = Math.atan2(dy, dx) + jitter;
      dx = Math.cos(a);
      dy = Math.sin(a);
      aim = a;
    }
    if (me.role === 'seeker') {
      const target = view.players.find((q) => q.role === 'hider');
      if (target) aim = Math.atan2(target.y - me.y, target.x - me.x);
      else if (g && (g.kind === 'ripple' || g.kind === 'hint' || g.kind === 'memory') && Math.hypot(g.x - me.x, g.y - me.y) < 9) aim = Math.atan2(g.y - me.y, g.x - me.x) + Math.sin(t * 2.2) * 0.35;
      else aim = aim + Math.sin(t * 1.7 + this.id.length) * 0.6;
    }
    return { input: { dx, dy, mode: this.mode, aim, seq: ++this.seq }, actions };
  }

  decide(view, actions) {
    const p = this.perception;
    const me = view.you;
    const role = me.role;
    const traits = this.traits;
    const enemies = view.players.filter((q) => q.role !== role);
    let nearestEnemy = 99;
    let nearest = null;
    for (const e of enemies) {
      const d = Math.hypot(e.x - me.x, e.y - me.y);
      if (d < nearestEnemy) {
        nearestEnemy = d;
        nearest = e;
      }
    }
    const threats = p.threats();
    const danger = role === 'hider' && p.threatDistance(me.x, me.y, threats) < 9;
    const ctx = { role, traits, tilt: this.tilt, me, danger, headstart: view.phase === 'headstart', nearestEnemy, chasing: role === 'seeker' ? nearestEnemy : 0 };
    const cands = p.candidates();
    const g = p.globalFeatures();
    const priors = cands.map((c) => candidatePrior(c, ctx));
    const scores = scoreCandidates(this.brain, role, g, cands.map((c) => p.candidateFeatures(c)), priors);
    let idx;
    const mistake = this.rnd() < traits.mistakeRate * (1 + this.tilt);
    if (mistake) idx = Math.floor(this.rnd() * cands.length);
    else idx = sample(softmax(scores, traits.temperature * (1 + this.tilt * 0.5)), this.rnd);
    const prev = this.goal;
    this.goal = cands[idx];
    if (!prev || Math.hypot(prev.x - this.goal.x, prev.y - this.goal.y) > 1) this.nextPath = 0;

    // movement mode + item usage
    const head = headOutputs(this.brain, role, g);
    const ml = modePrior({ ...ctx, chasing: this.goal.kind === 'enemy' ? nearestEnemy : 0 }).map((v, i) => v + head[i]);
    this.mode = MODES[sample(softmax(ml, traits.temperature + 0.1), this.rnd)];

    if (me.item) {
      const u = itemPrior(me, view, p, nearest, nearestEnemy, this.map);
      if (u && sigmoid(u.logit + head[3]) > 0.5 && this.rnd() > traits.mistakeRate) {
        actions.push({ type: 'use', x: u.x, y: u.y });
      }
    }
    // occasional hesitation (human-like)
    if (this.rnd() < 0.02 * (1 - traits.aggression) + this.tilt * 0.01 && !danger) this.hesitateUntil = p.time + 0.3 + this.rnd() * 0.7;
    this.lastDecision = { g, cands, priors, chosen: idx, mode: this.mode };
  }
}

function sample(probs, rnd) {
  let r = rnd();
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i];
    if (r <= 0) return i;
  }
  return probs.length - 1;
}

export function itemPrior(me, view, p, nearest, nearestEnemy, map) {
  const t = p.time;
  const freshRipple = [...p.ripples.values()].filter((r) => t - r.t < 2.5).sort((a, b) => b.t - a.t)[0];
  const threats = p.threats().filter((x) => x.fresh > 0.4);
  const threat = threats.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
  switch (me.item) {
    case 'flare':
      if (freshRipple && Math.hypot(freshRipple.x - me.x, freshRipple.y - me.y) < ITEMS.flare.range) return { logit: 2, x: freshRipple.x, y: freshRipple.y };
      return { logit: -2 };
    case 'widebeam':
      return { logit: nearest || (freshRipple && Math.hypot(freshRipple.x - me.x, freshRipple.y - me.y) < 8) ? 1.5 : -2 };
    case 'echo':
      return { logit: t - p.lastInfo > 8 ? 1.5 : -1 };
    case 'trap': {
      const onDoor = map.tileAtPos(me.x, me.y).door;
      const nearPad = view.pads.some((q) => q.side === 'hider' && Math.hypot(q.x - me.x, q.y - me.y) < 2);
      return { logit: onDoor || nearPad ? 1.5 : -1.5 };
    }
    case 'decoy': {
      if (!threat) return { logit: -2 };
      const d = Math.hypot(threat.x - me.x, threat.y - me.y);
      if (d > 12) return { logit: -1 };
      const a = Math.atan2(me.y - threat.y, me.x - threat.x) + Math.PI / 2;
      return { logit: 1.5, x: me.x + Math.cos(a) * 7, y: me.y + Math.sin(a) * 7 };
    }
    case 'smoke':
      if (nearest && nearestEnemy < 6) return { logit: 2.5, x: (me.x + nearest.x) / 2, y: (me.y + nearest.y) / 2 };
      return { logit: -2 };
    case 'softshoes':
      return { logit: nearest && nearestEnemy < 7 ? 2 : -2 };
    case 'calm':
      if (me.heartbeatIn !== null && me.heartbeatIn < 3) return { logit: 2 };
      if (view.finalHush) return { logit: -3 };
      return { logit: me.heart > 0.75 && !nearest ? 1 : -2 };
  }
  return null;
}
