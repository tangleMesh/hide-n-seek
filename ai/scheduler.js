// TrainingScheduler: uses idle server time for self-play learning in a worker thread.
// Pauses the worker (shared flag, checked every simulation tick) as soon as a human game is active.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const RESUME_AFTER_IDLE_MS = 10_000;

export class TrainingScheduler {
  constructor({ repos, pool, hub, opts = {}, enabled = true }) {
    this.repos = repos;
    this.pool = pool;
    this.hub = hub;
    this.opts = opts;
    this.enabled = enabled;
    this.pauseBuffer = new SharedArrayBuffer(4);
    this.flag = new Int32Array(this.pauseBuffer);
    this.state = 'stopped';
    this.idleSince = Date.now();
    this.resumeTimer = null;
    this.stats = { startedAt: Date.now(), gamesSimulated: 0, runningMs: 0, pausedMs: 0, lastChange: Date.now(), generation: 0, lastError: null };
    this.hourly = []; // [{ hour, games }]
  }

  async start() {
    if (!this.enabled) return;
    const st = (await this.repos.training.getState()) || {};
    this.stats.gamesSimulated = st.gamesSimulated || 0;
    this.stats.generation = st.generation || 0;
    const champ = this.pool.championDoc();
    const latest = (await this.repos.botModels.all()).at(-1);
    const workerData = {
      pauseBuffer: this.pauseBuffer,
      brain: latest ? { version: latest.version, params: latest.params } : null,
      champion: champ ? champ.brain.toJSON() : null,
      championRating: champ?.leagueRating ?? 1000,
      generation: this.stats.generation,
      opts: this.opts,
    };
    this.worker = new Worker(fileURLToPath(new URL('./train/worker.js', import.meta.url)), { workerData });
    this.worker.on('message', (m) => this.onMessage(m).catch((e) => console.error('[train]', e)));
    this.worker.on('error', (e) => {
      this.stats.lastError = e.message;
      console.error('[train] worker error', e);
    });
    this.worker.unref();
    this.setRunning(!this.hub?.isBusy());
    this.hub?.onActivity((busy) => this.onActivity(busy));
    this.flushTimer = setInterval(() => this.persist(), 30_000);
    this.flushTimer.unref?.();
  }

  onActivity(busy) {
    clearTimeout(this.resumeTimer);
    if (busy) this.setRunning(false);
    else this.resumeTimer = setTimeout(() => !this.hub.isBusy() && this.setRunning(true), RESUME_AFTER_IDLE_MS);
  }

  setRunning(run) {
    const now = Date.now();
    if (this.state === 'running') this.stats.runningMs += now - this.stats.lastChange;
    else if (this.state === 'paused') this.stats.pausedMs += now - this.stats.lastChange;
    this.stats.lastChange = now;
    this.state = run ? 'running' : 'paused';
    Atomics.store(this.flag, 0, run ? 0 : 1);
  }

  async onMessage(m) {
    switch (m.type) {
      case 'games': {
        this.stats.gamesSimulated += m.n;
        const hour = Math.floor(Date.now() / 3600_000);
        if (this.hourly.at(-1)?.hour !== hour) this.hourly.push({ hour, games: 0 });
        this.hourly.at(-1).games += m.n;
        if (this.hourly.length > 48) this.hourly.shift();
        break;
      }
      case 'generation':
        this.stats.generation = m.gen;
        await this.repos.training.log({ kind: 'generation', gen: m.gen, fitnessMean: m.fitnessMean, fitnessMax: m.fitnessMax, fitnessMin: m.fitnessMin, ms: m.ms });
        break;
      case 'imitation':
        await this.repos.training.log({ kind: 'imitation', gen: m.gen, loss: m.loss, n: m.n });
        break;
      case 'needSamples': {
        const docs = await this.repos.samples.recent(4000);
        this.worker.postMessage({ type: 'samples', samples: docs.map(({ _id, at, ...s }) => s) });
        break;
      }
      case 'checkpoint': {
        const doc = await this.repos.botModels.insert({ version: m.gen, leagueRating: m.leagueRating, champion: false, params: m.brain.params, advantage: m.advantage, source: 'es' });
        if (m.champion) await this.repos.botModels.setChampion(doc._id);
        await this.repos.training.log({ kind: 'league', gen: m.gen, leagueRating: m.leagueRating, advantage: m.advantage, promoted: m.champion });
        await pruneCheckpoints(this.repos);
        await this.pool.reload();
        break;
      }
      case 'error':
        this.stats.lastError = m.message;
        console.error('[train]', m.message);
        break;
    }
  }

  async persist() {
    await this.repos.training.setState({ gamesSimulated: this.stats.gamesSimulated, generation: this.stats.generation }).catch(() => {});
    for (const kind of ['generation', 'imitation', 'league']) await this.repos.training.prune(kind, 3000).catch(() => {});
    await this.repos.samples.prune(50_000).catch(() => {});
  }

  status() {
    const now = Date.now();
    const running = this.stats.runningMs + (this.state === 'running' ? now - this.stats.lastChange : 0);
    const paused = this.stats.pausedMs + (this.state === 'paused' ? now - this.stats.lastChange : 0);
    return {
      enabled: this.enabled, state: this.enabled ? this.state : 'disabled', generation: this.stats.generation,
      gamesSimulated: this.stats.gamesSimulated, idleUse: running + paused ? running / (running + paused) : 0,
      runningMinutes: Math.round(running / 60000), pausedMinutes: Math.round(paused / 60000),
      hourly: this.hourly.map((h) => ({ at: h.hour * 3600_000, games: h.games })), lastError: this.stats.lastError,
    };
  }

  async stop() {
    clearInterval(this.flushTimer);
    await this.persist();
    await this.worker?.terminate();
  }
}

// Keep the league small but diverse: the champion, the seed model and up to MAX checkpoints spread over the
// rating range (drop the checkpoint whose rating is closest to a neighbour, preferring older ones).
export const MAX_CHECKPOINTS = 30;
export async function pruneCheckpoints(repos, max = MAX_CHECKPOINTS) {
  const all = await repos.botModels.all();
  let removable = all.filter((m) => !m.champion && m.source !== 'seed');
  while (removable.length > max) {
    const sorted = [...removable].sort((a, b) => a.leagueRating - b.leagueRating || a.createdAt - b.createdAt);
    let victim = sorted[0], best = Infinity;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].leagueRating - sorted[i - 1].leagueRating;
      if (gap < best) {
        best = gap;
        victim = sorted[i - 1].createdAt < sorted[i].createdAt ? sorted[i - 1] : sorted[i];
      }
    }
    await repos.botModels.delete(victim._id);
    removable = removable.filter((m) => m._id !== victim._id);
  }
}
