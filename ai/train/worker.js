// Training worker thread: runs learning games one after another. Pauses cooperatively (between ticks)
// whenever the main thread flips the shared pause flag (human game running).
import { parentPort, workerData } from 'node:worker_threads';
import { Brain } from '../brain.js';
import { esGeneration } from './es.js';
import { imitationEpoch } from './imitation.js';
import { evaluate, nextLeagueRating } from './league.js';
import { loadMap } from '../../server/maps.js';

const flag = new Int32Array(workerData.pauseBuffer);
const shouldPause = () => Atomics.load(flag, 0) === 1;
const map = loadMap(workerData.mapId || 'manor');
const opts = workerData.opts || {};

let brain = new Brain(workerData.brain);
let champion = new Brain(workerData.champion);
let championRating = workerData.championRating ?? 1000;
let gen = workerData.generation ?? 0;
let samples = [];
let samplesResolve = null;

parentPort.on('message', (m) => {
  if (m.type === 'samples') {
    samples = m.samples;
    samplesResolve?.();
    samplesResolve = null;
  }
});

const games = (n) => parentPort.postMessage({ type: 'games', n });

async function fetchSamples() {
  const p = new Promise((r) => (samplesResolve = r));
  parentPort.postMessage({ type: 'needSamples' });
  await Promise.race([p, new Promise((r) => setTimeout(r, 10_000))]);
}

async function main() {
  for (;;) {
    const t0 = Date.now();
    const r = await esGeneration({ map, brain, opponent: champion, gen, opts, shouldPause, onGame: games });
    gen++;
    parentPort.postMessage({ type: 'generation', gen, ...r, ms: Date.now() - t0 });

    if (gen % 3 === 0) {
      await fetchSamples();
      if (samples.length >= 50) {
        const loss = imitationEpoch(brain, samples);
        parentPort.postMessage({ type: 'imitation', loss, n: samples.length, gen });
      }
    }
    if (gen % (opts.evalEvery || 5) === 0) {
      const ev = await evaluate({ map, candidate: brain, champion, games: opts.evalGames || 3, opts, shouldPause, onGame: games });
      const leagueRating = nextLeagueRating(championRating, ev.advantage);
      const promote = ev.advantage > 0.02;
      parentPort.postMessage({ type: 'checkpoint', brain: brain.toJSON(), gen, leagueRating, advantage: ev.advantage, champion: promote });
      if (promote) {
        champion = brain.clone();
        championRating = leagueRating;
      } else if (ev.advantage < -0.15) {
        brain = champion.clone(); // drifted into a bad region: restart from the champion
      }
    }
  }
}

main().catch((e) => {
  parentPort.postMessage({ type: 'error', message: e.stack || String(e) });
});
