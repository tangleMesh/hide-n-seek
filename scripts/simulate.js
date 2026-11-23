// End-to-end simulation with headless WebSocket clients against a real server process.
// Scenarios: ranked match with persona fill + disconnect/reconnect, crash/restart recovery,
// custom game pause → save → resume with the same players, and a "no bot leaks" check on all traffic.
//
//   node scripts/simulate.js            (uses MongoDB database "hush_sim", dropped first)
//   DB_DRIVER=memory node scripts/simulate.js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DRIVER = process.env.DB_DRIVER || 'mongo';
const MEMFILE = `${ROOT}.sim-memory.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
let failures = 0;
const check = (cond, what) => {
  if (cond) log('  ✔', what);
  else {
    failures++;
    log('  ✘', what);
  }
};

let server;
function startServer() {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_DRIVER: DRIVER, MONGO_DB: 'hush_sim', MEMORY_FILE: MEMFILE,
      ROUND_SECONDS: '25', HEADSTART_SECONDS: '3', MM_FILL_AFTER: '1,2', TRAINING: 'off', MIN_PERSONAS: '12', ADMIN_USERS: 'sim_admin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('  [srv] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('  [srv!] ' + d));
  return waitFor(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 15000, 'server up');
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const allTraffic = [];

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.walk = 0;
  }
  async register() {
    const r = await fetch(`${BASE}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: this.name, password: 'secret123' }) });
    const d = await r.json();
    if (!d.token) throw new Error(`register ${this.name}: ${JSON.stringify(d)}`);
    this.token = d.token;
    this.id = d.user.id;
  }
  connect() {
    this.closedByUs = false;
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', token: this.token }));
        resolve();
      });
      ws.on('message', (data) => {
        const s = data.toString();
        allTraffic.push(s);
        const m = JSON.parse(s);
        this.msgs.push(m);
        if (m.t === 'snap') this.snap = m;
      });
      ws.on('close', () => {
        if (this.autoReconnect && !this.closedByUs) setTimeout(() => this.connect().catch(() => {}), 500);
      });
      ws.on('error', () => resolve());
    });
  }
  send(m) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }
  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
  startWalking() {
    clearInterval(this.walker);
    let seq = 0;
    this.walker = setInterval(() => {
      this.walk += 0.05;
      this.send({ t: 'input', seq: ++seq, dx: Math.cos(this.walk + this.name.length), dy: Math.sin(this.walk * 0.7), mode: 'walk', aim: this.walk });
    }, 50);
  }
  stopWalking() {
    clearInterval(this.walker);
  }
  mark() {
    this.cursor = this.msgs.length;
  }
  async waitMsg(pred, ms = 30000, what = 'message') {
    let idx = this.cursor ?? this.msgs.length;
    this.cursor = undefined;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (; idx < this.msgs.length; idx++) if (pred(this.msgs[idx])) return this.msgs[idx];
      await sleep(50);
    }
    throw new Error(`${this.name}: timeout waiting for ${what}`);
  }
  async me() {
    return (await (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${this.token}` } })).json()).user;
  }
}

async function main() {
  if (DRIVER === 'mongo') {
    const { MongoClient } = await import('mongodb');
    const c = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
    await c.connect();
    await c.db('hush_sim').dropDatabase();
    await c.close();
  } else rmSync(MEMFILE, { force: true });

  await startServer();
  log(`server on ${BASE} (db ${DRIVER})`);
  const tag = Date.now().toString(36).slice(-4);
  const cs = ['ana', 'bo', 'cy'].map((n) => new Client(`sim_${n}${tag}`));
  for (const c of cs) {
    await c.register();
    await c.connect();
  }

  // ---------- Scenario A: ranked with persona fill, disconnect + reconnect ----------
  log('Scenario A: ranked queue → persona fill → disconnect/reconnect → round end');
  const before = await Promise.all(cs.map((c) => c.me()));
  for (const c of cs) {
    c.mark();
    c.send({ t: 'queue:join' });
  }
  const starts = await Promise.all(cs.map((c) => c.waitMsg((m) => m.t === 'game:start', 30000, 'game:start')));
  check(starts[0].ranked && starts[0].roster.length === 8, `ranked game started with 8 players (got ${starts[0].roster.length})`);
  check(new Set(starts.map((s) => s.gameId)).size === 1, 'all humans in the same game');
  const gameA = starts[0].gameId;
  for (const c of cs) c.startWalking();
  await sleep(5000);
  check(cs.every((c) => c.snap && c.snap.tick > 50), 'snapshots streaming');
  cs[2].close();
  const away = await cs[0].waitMsg((m) => m.t === 'event' && m.ev.type === 'playerAway' && m.ev.id === cs[2].id, 5000, 'playerAway');
  check(!!away, 'others see disconnected player as away (AI takes over)');
  await sleep(2500);
  await cs[2].connect();
  const re = await cs[2].waitMsg((m) => m.t === 'game:start', 5000, 'reattach game:start');
  check(re.gameId === gameA, 'reconnected player reattached to the running game');
  await cs[2].waitMsg((m) => m.t === 'snap', 3000, 'snap after reconnect');
  cs[2].startWalking();
  const ends = await Promise.all(cs.map((c) => c.waitMsg((m) => m.t === 'roundEnd', 60000, 'roundEnd')));
  check(ends.every((e) => e.ranked && e.results.length === 8), 'roundEnd received by all humans');
  const after = await Promise.all(cs.map((c) => c.me()));
  check(after.every((u, i) => u.games === before[i].games + 1), 'games counter incremented');
  const deltas = ends[0].results.filter((r) => cs.some((c) => c.id === r.id)).map((r) => r.delta);
  check(after.every((u, i) => u.rating === before[i].rating + deltas[i]), `ratings updated by ELO (${deltas.join(', ')})`);
  for (const c of cs) c.stopWalking();

  // ---------- Scenario B: crash + restart recovery ----------
  log('Scenario B: server crash mid ranked game → restart → game resumes from snapshot');
  for (const c of cs) {
    c.autoReconnect = true;
    c.mark();
    c.send({ t: 'queue:join' });
  }
  const startsB = await Promise.all(cs.map((c) => c.waitMsg((m) => m.t === 'game:start', 30000, 'game:start B')));
  const gameB = startsB[0].gameId;
  for (const c of cs) c.startWalking();
  await sleep(7000);
  const tickBefore = cs[0].snap.tick;
  for (const c of cs) c.mark();
  server.kill('SIGKILL');
  log('  server killed at tick', tickBefore);
  await sleep(1000);
  await startServer();
  const resumed = await Promise.all(cs.map((c) => c.waitMsg((m) => m.t === 'game:start', 20000, 'game:start after restart')));
  check(resumed.every((r) => r.gameId === gameB), 'same ranked game resumed after restart');
  const snapAfter = await cs[0].waitMsg((m) => m.t === 'snap', 5000, 'snap after restart');
  check(snapAfter.tick >= tickBefore - 120, `resumed near the crash point (tick ${snapAfter.tick} vs ${tickBefore})`);
  await Promise.all(cs.map((c) => c.waitMsg((m) => m.t === 'roundEnd', 60000, 'roundEnd B')));
  check(true, 'resumed ranked game finished');
  for (const c of cs) c.stopWalking();

  // ---------- Scenario C: custom pause → save → resume with the same players ----------
  log('Scenario C: custom lobby → pause → save vote → resume later with the same players');
  const [h, g2] = cs;
  h.send({ t: 'lobby:create' });
  const lst = await h.waitMsg((m) => m.t === 'lobby:state', 5000, 'lobby state');
  g2.send({ t: 'lobby:join', code: lst.code });
  await g2.waitMsg((m) => m.t === 'lobby:state' && m.members.length === 2, 5000, 'joined lobby');
  g2.send({ t: 'lobby:ready', ready: true });
  await h.waitMsg((m) => m.t === 'lobby:state' && m.members.every((x) => x.ready), 5000, 'all ready');
  h.mark();
  g2.mark();
  h.send({ t: 'lobby:start' });
  const [cstart] = await Promise.all([h, g2].map((c) => c.waitMsg((m) => m.t === 'game:start', 5000, 'custom start')));
  check(!cstart.ranked && cstart.canPause, 'custom game started (pausable)');
  h.startWalking();
  g2.startWalking();
  await sleep(6000);
  const tl = h.snap.timeLeft;
  h.send({ t: 'game:pause' });
  await g2.waitMsg((m) => m.t === 'event' && m.ev.type === 'paused', 5000, 'paused event');
  h.send({ t: 'game:saveVote', yes: true });
  h.mark();
  g2.send({ t: 'game:saveVote', yes: true });
  const saved = await h.waitMsg((m) => m.t === 'game:saved', 5000, 'game:saved');
  check(!!saved.savedId, 'game saved by vote');
  h.stopWalking();
  g2.stopWalking();
  const list = await (await fetch(`${BASE}/api/saved-games`, { headers: { authorization: `Bearer ${g2.token}` } })).json();
  check(list.games.some((x) => x.id === saved.savedId), 'saved game listed for the other participant');
  // third player must not be able to join the resumed game
  h.send({ t: 'lobby:resumeSaved', savedId: saved.savedId });
  const rl = await h.waitMsg((m) => m.t === 'lobby:state' && m.saved, 5000, 'saved lobby');
  h.send({ t: 'lobby:start' });
  const err = await h.waitMsg((m) => m.t === 'error', 5000, 'missing player error');
  check(/Waiting for original players/.test(err.message), 'cannot resume without the original players');
  g2.send({ t: 'lobby:join', code: rl.code });
  await g2.waitMsg((m) => m.t === 'lobby:state' && m.saved, 5000, 'guest in saved lobby');
  g2.send({ t: 'lobby:ready', ready: true });
  await h.waitMsg((m) => m.t === 'lobby:state' && m.members.every((x) => x.ready), 5000, 'ready to resume');
  h.mark();
  g2.mark();
  h.send({ t: 'lobby:start' });
  await h.waitMsg((m) => m.t === 'game:start', 5000, 'resumed start');
  const rs = await h.waitMsg((m) => m.t === 'snap', 5000, 'resumed snap');
  h.startWalking();
  check(Math.abs(rs.timeLeft - tl) < 3, `timer continued from save (${tl} → ${rs.timeLeft})`);
  await Promise.all([h, g2].map((c) => c.waitMsg((m) => m.t === 'roundEnd', 60000, 'roundEnd C')));
  h.stopWalking();
  check(true, 'resumed custom game finished');

  // ---------- No bot leaks ----------
  log('Checking traffic and public API for persona leaks');
  const leaks = allTraffic.filter((s) => /persona|"kind":"(human|persona)"|"bot":|isBot|botModel|"traits"/i.test(s));
  check(leaks.length === 0, `no persona/bot markers in ${allTraffic.length} ws messages`);
  if (leaks.length) log("    leak sample:", leaks.slice(0, 3).map((l) => l.slice(0, 300)));
  const lb = await (await fetch(`${BASE}/api/leaderboard`)).json();
  const keys = new Set(lb.players.map((p) => Object.keys(p).sort().join(',')));
  check(keys.size === 1, 'leaderboard rows all have identical shape');
  const humanProfile = await (await fetch(`${BASE}/api/profile/${cs[0].name}`)).json();
  const personaRow = lb.players.find((p) => !cs.some((c) => c.id === p.id));
  const personaProfile = await (await fetch(`${BASE}/api/profile/${encodeURIComponent(personaRow.name)}`)).json();
  check(JSON.stringify(Object.keys(humanProfile.user).sort()) === JSON.stringify(Object.keys(personaProfile.user).sort()), 'profiles have identical shape');
  check(personaProfile.recent.length > 0, 'persona profile has match history');
  const adminRes = await fetch(`${BASE}/api/admin/stats`, { headers: { authorization: `Bearer ${cs[0].token}` } });
  check(adminRes.status === 404, 'admin stats are 404 for non-admins');

  for (const c of cs) {
    c.autoReconnect = false;
    c.close();
  }
  server.kill('SIGTERM');
  log(failures ? `FAILED: ${failures} check(s)` : 'ALL CHECKS PASSED');
  if (DRIVER === 'memory') rmSync(MEMFILE, { force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server?.kill('SIGKILL');
  process.exit(1);
});
