import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MLP } from '../ai/mlp.js';
import { Brain } from '../ai/brain.js';
import { imitationEpoch } from '../ai/train/imitation.js';
import { esGeneration } from '../ai/train/es.js';
import { runHeadlessGame } from '../ai/sim.js';
import { loadMap } from '../server/maps.js';
import { G_SIZE, C_SIZE } from '../ai/features.js';
import { createStore, createRepositories, publicUser } from '../server/data/index.js';
import { BrainPool } from '../ai/pool.js';
import { PersonaManager, FRESH_PROBABILITY } from '../ai/personas/manager.js';
import { generateName } from '../ai/personas/generator.js';
import { mulberry32 } from '../ai/rng.js';
import { NAME_RE } from '../server/auth.js';

test('MLP backprop matches numerical gradient', () => {
  const net = new MLP([4, 5, 3], null, 3);
  for (let i = 0; i < net.count; i++) net.params[i] = Math.sin(i * 1.7) * 0.5;
  const x = [0.3, -0.2, 0.9, 0.1];
  const w = [0.7, -1.1, 0.4];
  const loss = () => net.forward(x).reduce((a, o, i) => a + o * w[i], 0);
  net.zeroGrad();
  net.forward(x, true);
  net.backward(w);
  for (const i of [0, 7, 19, net.count - 1]) {
    const orig = net.params[i];
    net.params[i] = orig + 1e-5;
    const up = loss();
    net.params[i] = orig - 1e-5;
    const down = loss();
    net.params[i] = orig;
    assert.ok(Math.abs((up - down) / 2e-5 - net.grads[i]) < 1e-6, `param ${i}`);
  }
});

test('imitation learning moves choices towards the demonstrated candidate', () => {
  const brain = new Brain();
  const rnd = mulberry32(5);
  const samples = Array.from({ length: 200 }, () => {
    const c = Array.from({ length: 4 }, (_, k) => Array.from({ length: C_SIZE }, () => rnd() - 0.5 + (k === 2 ? 0.8 : 0)));
    return { role: 'hider', g: Array.from({ length: G_SIZE }, () => rnd()), c, priors: [0, 0, 0, 0], chosen: 2, mode: 0, use: -1 };
  });
  const first = imitationEpoch(brain, samples, { lr: 0.05 });
  let last = first;
  for (let i = 0; i < 5; i++) last = imitationEpoch(brain, samples, { lr: 0.05 });
  assert.ok(last < first * 0.8, `loss decreased ${first.toFixed(3)} → ${last.toFixed(3)}`);
});

test('headless bot game runs to completion and bots respect the rules', async () => {
  const map = loadMap('manor');
  const brain = new Brain();
  const players = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, brain, seed: i + 1 }));
  const r = await runHeadlessGame({ map, players, seekerIds: ['p0'], roundSeconds: 40, headstart: 5 });
  assert.ok(['hiders', 'seekers'].includes(r.winner));
  for (const p of Object.values(r.game.state.players)) assert.ok(!map.collides(p.x, p.y), 'nobody inside walls');
});

test('one ES generation produces a new brain version', async () => {
  const map = loadMap('manor');
  const brain = new Brain();
  const before = brain.flat().slice();
  const r = await esGeneration({ map, brain, opponent: new Brain(), gen: 0, opts: { population: 2, players: 4, roundSeconds: 20, headstart: 3 } });
  assert.ok(Number.isFinite(r.fitnessMean));
  assert.equal(brain.version, 1);
  assert.notDeepEqual(Array.from(brain.flat()), Array.from(before));
});

test('persona names are valid account names', () => {
  const rnd = mulberry32(1);
  for (let i = 0; i < 300; i++) assert.match(generateName(rnd), NAME_RE);
});

test('persona selection: reuse within the rating window, ~25% fresh personas', async () => {
  const store = await createStore({ driver: 'memory', file: '' });
  const repos = await createRepositories(store);
  const pool = new BrainPool(repos);
  await pool.init();
  pool.stop();
  const pm = new PersonaManager({ repos, pool, map: loadMap('manor'), seed: 42 });
  await pm.init({ minPopulation: 40 });
  pm.stop();
  const startCount = pm.personas.size;
  let fresh = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const before = pm.personas.size;
    const id = await pm.pick(1100, { window: 300 });
    if (pm.personas.size > before) fresh++;
    else assert.ok(Math.abs(pm.personas.get(id).user.rating - 1100) <= 300, 'reused persona within window');
    pm.personas.get(id).busy = false;
    pm.personas.get(id).breakUntil = 0;
  }
  const rate = fresh / N;
  assert.ok(rate >= FRESH_PROBABILITY - 0.07 && rate <= FRESH_PROBABILITY + 0.07, `fresh rate ${rate}`);
  // fresh personas come with history, and look like any other account
  const newest = [...pm.personas.values()].slice(startCount)[0];
  const u = await repos.users.byId(newest.id);
  assert.ok(u.games > 0 && u.createdAt < Date.now() - 86400_000);
  assert.ok((await repos.matches.recentFor(u._id)).length > 0);
  assert.deepEqual(Object.keys(publicUser(u)).sort(), ['color', 'createdAt', 'face', 'games', 'id', 'name', 'rating', 'wins']);
  await store.close();
});
