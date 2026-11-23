// Brain pool: the league of trained checkpoints, used to give personas a brain that matches their rating.
import { Brain } from './brain.js';

export class BrainPool {
  constructor(repos) {
    this.repos = repos;
    this.models = []; // { id, version, leagueRating, champion, brain }
    this.timer = null;
  }

  async init() {
    if ((await this.repos.botModels.count()) === 0) {
      const seed = new Brain();
      const doc = await this.repos.botModels.insert({ version: 0, leagueRating: 1000, champion: true, ...seed.toJSON(), source: 'seed' });
      await this.repos.botModels.setChampion(doc._id);
    }
    await this.reload();
    this.timer = setInterval(() => this.reload().catch((e) => console.error('[pool] reload', e.message)), 180_000);
    this.timer.unref?.();
  }

  async reload() {
    const docs = await this.repos.botModels.all();
    const known = new Map(this.models.map((m) => [m.id, m]));
    this.models = docs.map((d) => {
      const prev = known.get(d._id);
      const brain = prev ? prev.brain : new Brain({ version: d.version, params: d.params });
      return { id: d._id, version: d.version, leagueRating: d.leagueRating ?? 1000, champion: !!d.champion, brain };
    });
    this.models.sort((a, b) => a.leagueRating - b.leagueRating);
  }

  champion() {
    return (this.models.find((m) => m.champion) || this.models.at(-1))?.brain ?? new Brain();
  }

  championDoc() {
    return this.models.find((m) => m.champion) || this.models.at(-1);
  }

  // Map a public persona rating to a checkpoint: low ratings get early/weak brains, high ratings the strongest.
  forRating(rating) {
    if (!this.models.length) return { brain: new Brain(), strength: 0.5 };
    const strength = Math.max(0, Math.min(1, (rating - 700) / 1100));
    const idx = Math.min(this.models.length - 1, Math.round(strength * (this.models.length - 1)));
    return { brain: this.models[idx].brain, version: this.models[idx].version, strength };
  }

  stop() {
    clearInterval(this.timer);
  }
}

// Human-like imperfection derived from a rating: lower rating => more mistakes, slower reactions, noisier choices.
export function skillFromRating(rating) {
  const s = Math.max(0, Math.min(1, (rating - 600) / 1300));
  return {
    mistakeRate: 0.02 + (1 - s) * 0.3,
    reactionMs: Math.round(160 + (1 - s) * 340),
    temperature: 0.25 + (1 - s) * 0.6,
  };
}
