// Repository layer. Game/server code only talks to these repositories; the underlying DocumentStore
// (Mongo or memory) is swappable. To add another document database, implement the DocumentStore
// contract (see server/data/memory/store.js) and register it in createStore().
import { randomUUID } from 'node:crypto';
import { defaultFace } from '../../shared/look.js';
import { MemoryStore } from './memory/store.js';

export async function createStore(opts = {}) {
  const driver = opts.driver || process.env.DB_DRIVER || 'mongo';
  if (driver === 'memory') {
    const s = new MemoryStore({ file: opts.file ?? process.env.MEMORY_FILE });
    await s.connect();
    return s;
  }
  if (driver === 'mongo') {
    const { MongoStore } = await import('./mongo/store.js');
    const s = new MongoStore({
      url: opts.url || process.env.MONGO_URL || 'mongodb://127.0.0.1:27017',
      dbName: opts.dbName || process.env.MONGO_DB || 'hush',
    });
    await s.connect();
    return s;
  }
  throw new Error(`unknown DB_DRIVER ${driver}`);
}

export const newId = () => randomUUID();

// Fields every client may see about any account (humans and personas alike).
export function publicUser(u) {
  if (!u) return null;
  return { id: u._id, name: u.name, rating: u.rating, games: u.games, wins: u.wins, color: u.color, face: u.face || defaultFace(u._id), createdAt: u.createdAt };
}

export async function createRepositories(store) {
  const c = (n) => store.collection(n);
  const users = c('users'), sessions = c('sessions'), matches = c('matches'), snapshots = c('snapshots');
  const savedGames = c('savedGames'), botModels = c('botModels'), samples = c('trainingSamples');
  const leaverLog = c('leaverLog'), personas = c('personas'), trainingRuns = c('trainingRuns');

  await Promise.all([
    users.ensureIndex({ nameLower: 1 }, { unique: true }),
    users.ensureIndex({ rating: -1 }),
    sessions.ensureIndex({ token: 1 }, { unique: true }),
    matches.ensureIndex({ userIds: 1, at: -1 }),
    snapshots.ensureIndex({ finished: 1 }),
    savedGames.ensureIndex({ participants: 1 }),
    botModels.ensureIndex({ version: -1 }),
    samples.ensureIndex({ at: -1 }),
    leaverLog.ensureIndex({ userId: 1, at: -1 }),
    trainingRuns.ensureIndex({ at: -1 }),
  ]);

  const repos = {
    store,
    users: {
      async create(doc) {
        const u = { _id: newId(), rating: 1000, games: 0, wins: 0, createdAt: Date.now(), kind: 'human', ...doc, nameLower: doc.name.toLowerCase() };
        await users.insertOne(u);
        return u;
      },
      byId: (id) => users.findOne({ _id: id }),
      byIds: (ids) => users.find({ _id: { $in: ids } }),
      byName: (name) => users.findOne({ nameLower: String(name).toLowerCase() }),
      nameTaken: async (name) => (await users.count({ nameLower: String(name).toLowerCase() })) > 0,
      top: (n = 50) => users.find({ games: { $gt: 0 } }, { sort: { rating: -1 }, limit: n }),
      inRange: (lo, hi, kind) => users.find({ rating: { $gte: lo, $lte: hi }, ...(kind ? { kind } : {}) }),
      count: (filter = {}) => users.count(filter),
      all: (filter = {}) => users.find(filter),
      update: (id, set) => users.updateOne({ _id: id }, { $set: set }),
      // results: [{ id, delta, win }]
      applyResults: (results) =>
        users.bulkUpdate(results.map((r) => ({ filter: { _id: r.id }, update: { $inc: { rating: r.delta, games: 1, wins: r.win ? 1 : 0 } } }))),
    },
    sessions: {
      async create(userId) {
        const { randomBytes } = await import('node:crypto');
        const token = randomBytes(24).toString('base64url');
        await sessions.insertOne({ _id: token, token, userId, createdAt: Date.now() });
        return token;
      },
      find: (token) => (token ? sessions.findOne({ token: String(token) }) : null),
      delete: (token) => sessions.deleteOne({ token }),
    },
    matches: {
      insert: (m) => matches.insertOne({ _id: m._id || newId(), at: Date.now(), ...m }),
      insertMany: (ms) => matches.insertMany(ms),
      recentFor: (userId, n = 10) => matches.find({ userIds: userId }, { sort: { at: -1 }, limit: n }),
      recent: (n = 500, filter = {}) => matches.find(filter, { sort: { at: -1 }, limit: n }),
      count: (filter = {}) => matches.count(filter),
    },
    snapshots: {
      upsert: (gameId, doc) => snapshots.updateOne({ _id: gameId }, { $set: { ...doc, savedAt: Date.now(), finished: false } }, { upsert: true }),
      unfinished: () => snapshots.find({ finished: false }),
      finish: (gameId, outcome = 'finished') => snapshots.updateOne({ _id: gameId }, { $set: { finished: true, outcome } }),
      get: (gameId) => snapshots.findOne({ _id: gameId }),
    },
    savedGames: {
      insert: (doc) => savedGames.insertOne({ _id: newId(), savedAt: Date.now(), ...doc }),
      forUser: (userId) => savedGames.find({ participants: userId }, { sort: { savedAt: -1 } }),
      get: (id) => savedGames.findOne({ _id: id }),
      delete: (id) => savedGames.deleteOne({ _id: id }),
    },
    botModels: {
      insert: (doc) => botModels.insertOne({ _id: newId(), createdAt: Date.now(), ...doc }),
      all: () => botModels.find({}, { sort: { version: 1 } }),
      latest: () => botModels.findOne({ champion: true }),
      setRating: (id, leagueRating) => botModels.updateOne({ _id: id }, { $set: { leagueRating } }),
      setChampion: async (id) => {
        await botModels.updateMany({ champion: true }, { $set: { champion: false } });
        await botModels.updateOne({ _id: id }, { $set: { champion: true } });
      },
      count: () => botModels.count(),
      delete: (id) => botModels.deleteOne({ _id: id, champion: { $ne: true } }),
    },
    samples: {
      insertMany: (docs) => samples.insertMany(docs.map((d) => ({ _id: newId(), at: Date.now(), ...d }))),
      recent: (n = 5000) => samples.find({}, { sort: { at: -1 }, limit: n }),
      count: () => samples.count(),
      prune: async (keep = 50000) => {
        const n = await samples.count();
        if (n <= keep) return 0;
        const old = await samples.find({}, { sort: { at: 1 }, limit: n - keep });
        return samples.deleteMany({ _id: { $in: old.map((d) => d._id) } });
      },
    },
    leavers: {
      add: (userId, gameId) => leaverLog.insertOne({ _id: newId(), userId, gameId, at: Date.now() }),
      since: (userId, since) => leaverLog.find({ userId, at: { $gte: since } }, { sort: { at: -1 } }),
    },
    personas: {
      insert: (doc) => personas.insertOne(doc),
      get: (userId) => personas.findOne({ _id: userId }),
      all: () => personas.find({}),
      update: (userId, set) => personas.updateOne({ _id: userId }, { $set: set }),
      count: () => personas.count(),
    },
    training: {
      log: (doc) => trainingRuns.insertOne({ _id: newId(), at: Date.now(), ...doc }),
      recent: (kind, n = 200) => trainingRuns.find(kind ? { kind } : {}, { sort: { at: -1 }, limit: n }),
      getState: () => trainingRuns.findOne({ _id: 'state' }),
      setState: (set) => trainingRuns.updateOne({ _id: 'state' }, { $set: { ...set, kind: 'state', at: 0 } }, { upsert: true }),
      incState: (inc) => trainingRuns.updateOne({ _id: 'state' }, { $inc: inc, $set: { kind: 'state', at: 0 } }, { upsert: true }),
      prune: async (kind, keep = 2000) => {
        const n = await trainingRuns.count({ kind });
        if (n <= keep) return 0;
        const old = await trainingRuns.find({ kind }, { sort: { at: 1 }, limit: n - keep });
        return trainingRuns.deleteMany({ _id: { $in: old.map((d) => d._id) } });
      },
    },
  };
  return repos;
}
