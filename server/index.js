// HTTP (static files + REST) and WebSocket entry point.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createStore, createRepositories, publicUser } from './data/index.js';
import { register, login, userFromToken, tokenFromRequest } from './auth.js';
import { Hub } from './hub.js';
import { loadMap } from './maps.js';
import { BrainPool } from '../ai/pool.js';
import { PersonaManager } from '../ai/personas/manager.js';
import { TrainingScheduler } from '../ai/scheduler.js';
import { handleAdmin } from '../admin/routes.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const STATIC = { '/client/': 'client', '/shared/': 'shared', '/maps/': 'maps' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export async function createServer(opts = {}) {
  const store = opts.store || (await createStore(opts.db));
  const repos = await createRepositories(store);
  const map = loadMap('manor');
  const pool = new BrainPool(repos);
  await pool.init();
  const personas = new PersonaManager({ repos, pool, map });
  await personas.init({ minPopulation: opts.minPersonas ?? +(process.env.MIN_PERSONAS || 24) });
  const fillEnv = process.env.MM_FILL_AFTER?.split(',').map(Number);
  const hub = new Hub({ repos, pool, personas, map, matchmakerOpts: opts.matchmaker ?? (fillEnv ? { fillAfter: fillEnv } : {}) });
  const recovery = await hub.recover();
  if (recovery.resumed || recovery.voided || recovery.saved) console.log('[recovery]', recovery);
  const trainingEnabled = opts.training ?? process.env.TRAINING !== 'off';
  const scheduler = new TrainingScheduler({ repos, pool, hub, enabled: trainingEnabled, opts: opts.trainingOpts });
  await scheduler.start();

  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      });
    });
  const cookie = (token) => `hush_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (await handleAdmin(req, res, { repos, scheduler, personas })) return;
      if (p === '/api/register' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await register(repos, b.name, b.password);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { token: r.token, user: publicUser(r.user) }, { 'set-cookie': cookie(r.token) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await login(repos, b.name, b.password);
        if (r.error) return json(res, 401, { error: r.error });
        return json(res, 200, { token: r.token, user: publicUser(r.user) }, { 'set-cookie': cookie(r.token) });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        const t = tokenFromRequest(req);
        if (t) await repos.sessions.delete(t);
        return json(res, 200, { ok: true }, { 'set-cookie': 'hush_token=; Path=/; Max-Age=0' });
      }
      if (p === '/api/me') {
        const u = await userFromToken(repos, tokenFromRequest(req));
        return u ? json(res, 200, { user: publicUser(u) }) : json(res, 401, { error: 'not logged in' });
      }
      if (p === '/api/leaderboard') {
        const top = await repos.users.top(50);
        return json(res, 200, { players: top.map(publicUser) });
      }
      if (p.startsWith('/api/profile/')) {
        const u = await repos.users.byName(decodeURIComponent(p.slice('/api/profile/'.length)));
        if (!u) return json(res, 404, { error: 'not found' });
        const ms = await repos.matches.recentFor(u._id, 10);
        const recent = ms.map((m) => {
          const me = m.players.find((x) => x.userId === u._id) || {};
          return { at: m.at, ranked: !!m.ranked, role: me.startRole, win: !!me.win || (me.startRole === 'seeker' ? m.winner === 'seekers' : !me.caught), caught: !!me.caught, delta: me.delta ?? 0 };
        });
        return json(res, 200, { user: publicUser(u), recent });
      }
      if (p === '/api/saved-games') {
        const u = await userFromToken(repos, tokenFromRequest(req));
        if (!u) return json(res, 401, { error: 'not logged in' });
        const list = await repos.savedGames.forUser(u._id);
        return json(res, 200, {
          games: list.map((g) => ({ id: g._id, savedAt: g.savedAt, timeLeft: Math.round(g.timeLeft), host: g.roster.find((r) => r.id === g.hostId)?.name, players: g.roster.map((r) => r.name) })),
        });
      }
      if (p === '/api/online') {
        const u = await userFromToken(repos, tokenFromRequest(req));
        return json(res, 200, { list: hub.onlineList(u?._id) });
      }
      if (p === '/health' || p === '/api/health') {
        return json(res, 200, { ok: true, version: VERSION, liveMatches: hub.liveMatches(), sessions: hub.sessions.size });
      }
      // static
      let file;
      if (p === '/' || p === '/index.html') file = path.join(ROOT, 'client', 'index.html');
      else {
        const prefix = Object.keys(STATIC).find((k) => p.startsWith(k));
        if (prefix) {
          const rel = path.normalize(decodeURIComponent(p.slice(prefix.length))).replace(/^(\.\.[/\\])+/, '');
          file = path.join(ROOT, STATIC[prefix], rel);
          if (!file.startsWith(path.join(ROOT, STATIC[prefix]) + path.sep)) file = null;
        }
      }
      if (!file) return json(res, 404, { error: 'not found' });
      const data = await readFile(file).catch(() => null);
      if (!data) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch (e) {
      console.error('[http]', e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', (ws) => {
    const conn = {
      userId: null, rtt: null, alive: true, sentAt: 0,
      send: (d) => ws.readyState === 1 && ws.send(d),
      close: () => ws.close(),
    };
    let budget = 60;
    const refill = setInterval(() => (budget = 60), 1000);
    ws.on('pong', () => {
      conn.alive = true;
      conn.rtt = Date.now() - conn.sentAt;
    });
    ws.on('message', (data) => {
      if (--budget < 0) return; // simple flood protection (inputs are sent at 20 Hz)
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      hub.handle(conn, msg).catch((e) => console.error('[ws]', e));
    });
    ws.on('close', () => {
      clearInterval(refill);
      hub.onClose(conn);
    });
    ws.on('error', () => {});
    ws._conn = conn;
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const c = ws._conn;
      if (!c.alive) {
        ws.terminate(); // dead socket → close → reconnect grace starts
        continue;
      }
      c.alive = false;
      c.sentAt = Date.now();
      ws.ping();
    }
  }, 5000);

  const close = async () => {
    clearInterval(heartbeat);
    await hub.stop();
    personas.stop();
    pool.stop();
    await scheduler.stop();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(r));
    if (!opts.store) await store.close();
  };
  return { server, hub, repos, store, scheduler, personas, pool, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = +(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const app = await createServer();
  app.server.listen(port, host, () => console.log(`HUSH listening on http://${host}:${port} (db: ${process.env.DB_DRIVER || 'mongo'})`));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('shutting down: saving running games…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
