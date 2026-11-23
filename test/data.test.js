// Repository contract tests. Run against the memory adapter always, and against MongoDB when reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createRepositories, publicUser } from '../server/data/index.js';
import { register, login, userFromToken } from '../server/auth.js';

async function mongoAvailable() {
  try {
    const { MongoClient } = await import('mongodb');
    const c = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 800 });
    await c.connect();
    await c.db('hush_test').dropDatabase();
    await c.close();
    return true;
  } catch {
    return false;
  }
}

const drivers = ['memory'];
if (process.env.DB_DRIVER !== 'memory' && (await mongoAvailable())) drivers.push('mongo');

for (const driver of drivers) {
  test(`[${driver}] repository contract`, async (t) => {
    const store = await createStore({ driver, dbName: 'hush_test', file: '' });
    const repos = await createRepositories(store);
    t.after(() => store.close());

    await t.test('register/login/token, unique names (case-insensitive)', async () => {
      const r = await register(repos, 'Alice', 'password1');
      assert.ok(r.token);
      assert.equal((await register(repos, 'alice', 'password2')).error, 'Name already taken');
      assert.ok((await login(repos, 'ALICE', 'password1')).token);
      assert.ok((await login(repos, 'alice', 'wrong')).error);
      assert.equal((await userFromToken(repos, r.token)).name, 'Alice');
      assert.equal(publicUser(r.user).pwHash, undefined);
      assert.equal(publicUser(r.user).kind, undefined);
    });

    await t.test('personas cannot log in', async () => {
      await repos.users.create({ name: 'ghosty', kind: 'persona', pwHash: null, salt: null });
      assert.ok((await login(repos, 'ghosty', '')).error);
    });

    await t.test('rating updates + leaderboard ordering', async () => {
      const a = await repos.users.byName('alice');
      const b = await repos.users.create({ name: 'Bob', kind: 'human' });
      await repos.users.applyResults([{ id: a._id, delta: 30, win: true }, { id: b._id, delta: -10, win: false }]);
      const top = await repos.users.top(10);
      assert.equal(top[0].name, 'Alice');
      assert.equal(top[0].rating, 1030);
      assert.equal(top[0].wins, 1);
      assert.ok(top.every((u) => u.games > 0));
    });

    await t.test('matches by user (array contains)', async () => {
      const a = await repos.users.byName('alice');
      await repos.matches.insert({ ranked: true, userIds: [a._id, 'x'], players: [{ userId: a._id, delta: 5 }] });
      await repos.matches.insert({ ranked: true, userIds: ['y'], players: [] });
      const mine = await repos.matches.recentFor(a._id);
      assert.equal(mine.length, 1);
    });

    await t.test('snapshots upsert/unfinished/finish', async () => {
      await repos.snapshots.upsert('g1', { ranked: true, state: { tick: 1 } });
      await repos.snapshots.upsert('g1', { ranked: true, state: { tick: 2 } });
      let u = await repos.snapshots.unfinished();
      assert.equal(u.length, 1);
      assert.equal(u[0].state.tick, 2);
      await repos.snapshots.finish('g1', 'finished');
      u = await repos.snapshots.unfinished();
      assert.equal(u.length, 0);
    });

    await t.test('saved games per participant', async () => {
      const s = await repos.savedGames.insert({ participants: ['p1', 'p2'], roster: [], state: {} });
      assert.equal((await repos.savedGames.forUser('p2')).length, 1);
      assert.equal((await repos.savedGames.forUser('p3')).length, 0);
      await repos.savedGames.delete(s._id);
      assert.equal((await repos.savedGames.forUser('p1')).length, 0);
    });

    await t.test('leaver log window', async () => {
      await repos.leavers.add('u1', 'g');
      assert.equal((await repos.leavers.since('u1', Date.now() - 1000)).length, 1);
      assert.equal((await repos.leavers.since('u1', Date.now() + 1000)).length, 0);
    });

    await t.test('training state counters', async () => {
      await repos.training.incState({ gamesSimulated: 5 });
      await repos.training.incState({ gamesSimulated: 3 });
      assert.equal((await repos.training.getState()).gamesSimulated, 8);
    });
  });
}
