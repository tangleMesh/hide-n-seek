// Brain = hand-written heuristic prior + learned residual networks (per role).
// The heuristic guarantees sensible play from day one; the residual MLPs are trained by imitation
// (human games) and evolution strategies (self-play) and shift the decisions over time.
import { MLP, softmax } from './mlp.js';
import { G_SIZE, C_SIZE } from './features.js';

export const SCORE_SIZES = [G_SIZE + C_SIZE, 20, 1];
export const HEAD_SIZES = [G_SIZE, 12, 4]; // sneak, walk, sprint, use-item
export const MODES = ['sneak', 'walk', 'sprint'];

export const DEFAULT_TRAITS = {
  aggression: 0.5, patience: 0.5, risk: 0.5, tactic: 'roamer', sprintHabit: 0.4, itemFocus: 0.5,
  zone: null, mistakeRate: 0.05, reactionMs: 200, temperature: 0.35, tiltSensitivity: 0.3, chattiness: 0.3,
};

export class Brain {
  constructor(data = null) {
    this.version = data?.version ?? 0;
    this.nets = {};
    let seed = 7;
    for (const role of ['hider', 'seeker']) {
      this.nets[role] = {
        score: new MLP(SCORE_SIZES, data?.params?.[role]?.score ?? null, seed++),
        head: new MLP(HEAD_SIZES, data?.params?.[role]?.head ?? null, seed++),
      };
    }
  }

  toJSON() {
    const params = {};
    for (const role of ['hider', 'seeker']) {
      params[role] = { score: Array.from(this.nets[role].score.params), head: Array.from(this.nets[role].head.params) };
    }
    return { version: this.version, params };
  }

  // Flat parameter vector (for ES) for one role or both.
  flat(roles = ['hider', 'seeker']) {
    const parts = [];
    for (const r of roles) parts.push(this.nets[r].score.params, this.nets[r].head.params);
    const out = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  setFlat(vec, roles = ['hider', 'seeker']) {
    let o = 0;
    for (const r of roles) {
      for (const net of [this.nets[r].score, this.nets[r].head]) {
        net.params.set(vec.subarray(o, o + net.count));
        o += net.count;
      }
    }
  }

  clone() {
    return new Brain(this.toJSON());
  }
}

// ---------- heuristic prior ----------

export function candidatePrior(c, ctx) {
  const { role, traits: t, tilt, me, danger } = ctx;
  const aggr = Math.min(1, t.aggression + tilt * 0.4);
  const patience = Math.max(0, t.patience - tilt * 0.4);
  let s = 0;
  const zoneBonus = t.zone ? 0.6 * Math.max(0, 1 - Math.hypot(c.x - t.zone.x, c.y - t.zone.y) / 25) : 0;
  if (role === 'seeker') {
    switch (c.kind) {
      case 'enemy': s = 6 + 2 * aggr - 0.15 * c.dist; break;
      case 'ripple': s = (3 + 1.5 * aggr) * c.fresh + (c.heart ? 1 : 0) - 0.1 * c.dist + (t.tactic === 'flanker' ? 0.5 : 0); break;
      case 'memory': s = 2.5 * c.fresh - 0.1 * c.dist; break;
      case 'hint': s = 3 * c.fresh - 0.08 * c.dist + (t.tactic === 'flanker' ? 0.7 : 0); break;
      case 'pad': s = 1.2 + t.itemFocus * 1.5 + (t.tactic === 'item-controller' ? 1.5 : 0) - 0.12 * c.dist; break;
      case 'wp': s = 1.2 * (1 - c.visited) * (t.tactic === 'sweeper' ? 1.6 : 1) - 0.04 * c.dist + zoneBonus; break;
      case 'far': s = 1.4 * (1 - c.visited) + (t.tactic === 'roamer' ? 0.6 : 0) - 0.03 * c.dist + zoneBonus; break;
      case 'stay': s = -2 + (t.tactic === 'camper' ? 0.8 : 0); break;
    }
    if (ctx.headstart) s = c.kind === 'stay' ? 5 : 0;
    return s;
  }
  // hider
  const safety = Math.min(c.threat, 15) / 15;
  const camper = t.tactic === 'camper' ? 1 : 0;
  const roamer = t.tactic === 'roamer' ? 1 : 0;
  switch (c.kind) {
    case 'stay': {
      s = danger ? -1 + patience - (1 - safety) * 3 : 1.2 * patience + camper;
      s += c.bush * (1 + camper) - c.lit * 3;
      if (me.heartbeatIn !== null && me.heartbeatIn < 4) s -= (4 - me.heartbeatIn) * 0.8 * (1 - t.risk * 0.5);
      if (ctx.headstart) s -= 3;
      break;
    }
    case 'pad':
      s = 1 + t.itemFocus + (t.tactic === 'item-controller' ? 1.2 : 0) - 0.12 * c.dist - (c.threat < 6 ? 3 * (1 - t.risk) : 0);
      break;
    default: {
      s = safety * 3 * (danger ? 2 : 1) + c.bush * (0.8 + camper) - c.lit * (2 - t.risk) - 0.05 * c.dist;
      s += (1 - c.visited) * 0.5 * (1 + roamer) + zoneBonus;
      if (c.kind === 'far') s += roamer * 0.5 + (ctx.headstart ? 1.5 : 0);
    }
  }
  return s;
}

export function modePrior(ctx) {
  const { role, traits: t, tilt, nearestEnemy, me, chasing, danger } = ctx;
  const sprintHabit = Math.min(1, t.sprintHabit + tilt * 0.4);
  const l = [0, 1, 0];
  if (role === 'seeker') {
    if (chasing && chasing < 10 && me.stamina > 15) l[2] = 2 + sprintHabit * 2;
    else l[2] = sprintHabit * 0.8 - 0.4;
    l[0] = -1;
  } else if (nearestEnemy < 5) {
    l[2] = 3 + sprintHabit;
  } else if (nearestEnemy < 10 || danger) {
    l[0] = 2.2 * (1 - t.risk * 0.5) + t.patience;
    l[2] = sprintHabit - 0.5;
  } else {
    l[0] = 0.6 + t.patience - tilt;
    l[2] = sprintHabit - 1.2;
  }
  if (me.stamina < 12) {
    l[0] -= 3;
    l[2] -= 3;
  } else if (role === 'hider' && me.stamina < 35 && !danger && nearestEnemy >= 10) l[0] -= 1.5; // save stamina for when it matters
  return l;
}

export function scoreCandidates(brain, role, g, cfeats, priors) {
  const net = brain.nets[role].score;
  const x = new Float64Array(G_SIZE + C_SIZE);
  x.set(g, 0);
  return cfeats.map((cf, i) => {
    x.set(cf, G_SIZE);
    return priors[i] + net.forward(x)[0];
  });
}

export function headOutputs(brain, role, g) {
  return brain.nets[role].head.forward(g);
}

export { softmax };
