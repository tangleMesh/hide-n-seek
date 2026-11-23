// Manual training run: npm run train -- --generations 10 --games 3
import { parseArgs } from 'node:util';
import { createStore, createRepositories } from '../../server/data/index.js';
import { BrainPool } from '../pool.js';
import { Brain } from '../brain.js';
import { esGeneration } from './es.js';
import { imitationEpoch } from './imitation.js';
import { evaluate, nextLeagueRating } from './league.js';
import { loadMap } from '../../server/maps.js';

const { values } = parseArgs({
  options: {
    generations: { type: 'string', default: '5' },
    games: { type: 'string', default: '3' },
    population: { type: 'string', default: '6' },
  },
});

const store = await createStore();
const repos = await createRepositories(store);
const pool = new BrainPool(repos);
await pool.init();
pool.stop();
const map = loadMap('manor');
const champDoc = pool.championDoc();
let champion = champDoc.brain.clone();
let championRating = champDoc.leagueRating;
const latest = (await repos.botModels.all()).at(-1);
const brain = new Brain({ version: latest.version, params: latest.params });
const opts = { population: +values.population };

const samples = (await repos.samples.recent(4000)).map(({ _id, at, ...s }) => s);
if (samples.length >= 50) {
  const loss = imitationEpoch(brain, samples);
  console.log(`imitation: ${samples.length} samples, loss ${loss.toFixed(3)}`);
  await repos.training.log({ kind: 'imitation', gen: brain.version, loss, n: samples.length });
}

let gen = latest.version;
for (let i = 0; i < +values.generations; i++) {
  const t0 = Date.now();
  const r = await esGeneration({ map, brain, opponent: champion, gen, opts });
  gen++;
  console.log(`gen ${gen}: fitness mean ${r.fitnessMean.toFixed(3)} max ${r.fitnessMax.toFixed(3)} (${Date.now() - t0}ms)`);
  await repos.training.log({ kind: 'generation', gen, ...r, ms: Date.now() - t0 });
}
const ev = await evaluate({ map, candidate: brain, champion, games: +values.games, opts });
const leagueRating = nextLeagueRating(championRating, ev.advantage);
const promote = ev.advantage > 0.02;
const doc = await repos.botModels.insert({ version: gen, leagueRating, champion: false, params: brain.toJSON().params, advantage: ev.advantage, source: 'cli' });
if (promote) await repos.botModels.setChampion(doc._id);
await repos.training.log({ kind: 'league', gen, leagueRating, advantage: ev.advantage, promoted: promote });
await repos.training.incState({ generation: 0 });
console.log(`checkpoint v${gen}: advantage ${ev.advantage.toFixed(3)} vs champion → league rating ${leagueRating}${promote ? ' (new champion)' : ''}`);
await store.close();
