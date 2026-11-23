// Records imitation-learning samples from human players: (features, candidate the human actually went for, mode, item use).
import { Perception } from './features.js';
import { candidatePrior, DEFAULT_TRAITS } from './brain.js';

const SAMPLE_EVERY = 0.5; // 2 Hz
const HORIZON = 2; // label = where the human actually went within 2s

export class HumanRecorder {
  constructor(map, id) {
    this.map = map;
    this.id = id;
    this.p = new Perception(map, id);
    this.pending = [];
    this.next = 0;
    this.done = [];
  }

  // obs: filtered observation; extra: { mode, usedItem }
  tick(obs, extra) {
    if (obs.phase !== 'play' && obs.phase !== 'headstart') return;
    this.p.update(obs);
    const t = this.p.time;
    for (const s of this.pending) {
      s.modes[extra.mode] = (s.modes[extra.mode] || 0) + 1;
      if (extra.usedItem) s.used = true;
    }
    while (this.pending.length && t - this.pending[0].t >= HORIZON) this.resolve(this.pending.shift(), obs.you);
    if (t >= this.next && !obs.you.frozen) {
      this.next = t + SAMPLE_EVERY;
      const me = obs.you;
      const cands = this.p.candidates();
      const threats = this.p.threats();
      const ctx = { role: me.role, traits: DEFAULT_TRAITS, tilt: 0, me, danger: me.role === 'hider' && this.p.threatDistance(me.x, me.y, threats) < 9, headstart: obs.phase === 'headstart' };
      this.pending.push({
        t, role: me.role, x: me.x, y: me.y, hadItem: !!me.item,
        g: Array.from(this.p.globalFeatures()),
        c: cands.map((c) => Array.from(this.p.candidateFeatures(c))),
        pos: cands.map((c) => [c.x, c.y, c.kind === 'stay' ? 1 : 0]),
        priors: cands.map((c) => candidatePrior(c, ctx)),
        modes: {}, used: false,
      });
    }
  }

  resolve(s, you) {
    const dx = you.x - s.x, dy = you.y - s.y;
    const moved = Math.hypot(dx, dy);
    let chosen = s.pos.findIndex((p) => p[2] === 1);
    if (moved > 0.6) {
      let best = -Infinity;
      s.pos.forEach(([cx, cy, stay], i) => {
        if (stay) return;
        const vx = cx - s.x, vy = cy - s.y;
        const vl = Math.hypot(vx, vy) || 1;
        const cos = (vx * dx + vy * dy) / (vl * moved);
        const score = cos - Math.abs(vl - moved * 2) * 0.03;
        if (score > best) {
          best = score;
          chosen = i;
        }
      });
    }
    const modeCounts = ['sneak', 'walk', 'sprint'].map((m) => s.modes[m] || 0);
    const total = modeCounts.reduce((a, b) => a + b, 0);
    const mode = total ? modeCounts.indexOf(Math.max(...modeCounts)) : -1;
    this.done.push({ role: s.role, g: s.g, c: s.c, priors: s.priors, chosen, mode, use: s.hadItem ? (s.used ? 1 : 0) : -1 });
  }

  drain() {
    const out = this.done;
    this.done = [];
    return out;
  }
}
