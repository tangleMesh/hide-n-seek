// Evolution strategies (OpenAI-ES style, antithetic sampling, rank-normalized fitness) over headless games.
import { Brain } from '../brain.js';
import { runHeadlessGame } from '../sim.js';
import { mulberry32, gaussian } from '../rng.js';
import { generateTraits } from '../personas/generator.js';

export const ES_DEFAULTS = { population: 6, sigma: 0.05, lr: 0.03, players: 6, roundSeconds: 120, headstart: 10 };

// Varied but fixed personalities so the brain learns to cope with different playstyles.
function rosterTraits(seed, n, map) {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => ({ ...generateTraits(rnd, map), mistakeRate: 0.04, reactionMs: 200, temperature: 0.35 }));
}

/**
 * Plays one game where `trial` controls the role `trialRole` and `opponent` the other role.
 * Returns the trial side's mean score in [0,1].
 */
export async function duel({ map, trial, opponent, trialRole, seed, opts, shouldPause }) {
  const n = opts.players;
  const traits = rosterTraits(seed, n, map);
  const ids = Array.from({ length: n }, (_, i) => `b${i}`);
  const seekerIds = [ids[seed % n]];
  const players = ids.map((id, i) => {
    const isSeeker = seekerIds.includes(id);
    const useTrial = (trialRole === 'seeker') === isSeeker;
    return { id, brain: useTrial ? trial : opponent, traits: traits[i], seed: seed * 31 + i };
  });
  const r = await runHeadlessGame({ map, players, seekerIds, roundSeconds: opts.roundSeconds, headstart: opts.headstart, shouldPause });
  const side = ids.filter((id) => (trialRole === 'seeker') === seekerIds.includes(id));
  return side.reduce((a, id) => a + r.scores[id], 0) / side.length;
}

// Fitness of a brain against an opponent: hider score + seeker score on the same seeds.
export async function fitness({ map, brain, opponent, seed, opts, shouldPause }) {
  const h = await duel({ map, trial: brain, opponent, trialRole: 'hider', seed, opts, shouldPause });
  const s = await duel({ map, trial: brain, opponent, trialRole: 'seeker', seed: seed + 1, opts, shouldPause });
  return { h, s, total: h + s };
}

function rankNormalize(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  idx.forEach(([, i], r) => (out[i] = r / (values.length - 1) - 0.5));
  return out;
}

/**
 * One ES generation. Mutates and returns `brain`. onGame is called after every simulated game.
 */
export async function esGeneration({ map, brain, opponent, gen, opts = {}, shouldPause, onGame = () => {} }) {
  opts = { ...ES_DEFAULTS, ...opts };
  const theta = brain.flat();
  const rnd = mulberry32(1000 + gen * 7919);
  const eps = [];
  const fits = [];
  const trial = new Brain();
  for (let k = 0; k < opts.population; k++) {
    const e = new Float64Array(theta.length);
    for (let i = 0; i < e.length; i++) e[i] = gaussian(rnd);
    const seed = 10_000 + gen * 100 + k * 2;
    for (const sign of [1, -1]) {
      const p = new Float64Array(theta.length);
      for (let i = 0; i < p.length; i++) p[i] = theta[i] + sign * opts.sigma * e[i];
      trial.setFlat(p);
      const f = await fitness({ map, brain: trial, opponent, seed, opts, shouldPause });
      onGame(2);
      fits.push(f.total);
    }
    eps.push(e);
  }
  const ranks = rankNormalize(fits);
  const grad = new Float64Array(theta.length);
  for (let k = 0; k < eps.length; k++) {
    const w = ranks[2 * k] - ranks[2 * k + 1];
    for (let i = 0; i < grad.length; i++) grad[i] += w * eps[k][i];
  }
  for (let i = 0; i < theta.length; i++) theta[i] += (opts.lr / (eps.length * opts.sigma)) * grad[i] - opts.lr * 0.002 * theta[i];
  brain.setFlat(theta);
  brain.version += 1;
  const mean = fits.reduce((a, b) => a + b, 0) / fits.length;
  return { fitnessMean: mean, fitnessMax: Math.max(...fits), fitnessMin: Math.min(...fits) };
}
