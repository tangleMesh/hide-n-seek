// Hub: presence, message routing, lobby/queue/session orchestration and crash recovery.
import { QUICK_CHAT } from '../shared/constants.js';
import { publicUser } from './data/index.js';
import { LobbyManager } from './lobby.js';
import { Matchmaker } from './matchmaker.js';
import { GameSession } from './session.js';
import { loadMap } from './maps.js';
import { userFromToken } from './auth.js';

const LOBBY_GRACE_MS = 30_000;
const RANKED_RESUME_MAX_AGE = 120_000;

class Presence {
  constructor(hub) {
    this.hub = hub;
    this.users = new Map(); // id -> { user, conns:Set, lobbyId, queue, lobbyGrace }
  }
  get(id) {
    return this.users.get(id);
  }
  entry(user) {
    let e = this.users.get(user._id);
    if (!e) {
      e = { user, conns: new Set(), lobbyId: null, queue: false, lobbyGrace: null };
      this.users.set(user._id, e);
    } else e.user = user;
    return e;
  }
  async ensurePersona(id) {
    const p = this.hub.personas.personas.get(id);
    if (p) this.entry(p.user);
  }
  isOnline(id) {
    const e = this.users.get(id);
    return !!e && (e.conns.size > 0 || this.hub.personas.isPersona(id));
  }
  setLobby(id, lobbyId) {
    const e = this.users.get(id);
    if (e) e.lobbyId = lobbyId;
  }
  setQueue(id, q) {
    const e = this.users.get(id);
    if (e) e.queue = q;
  }
  ping(id) {
    const e = this.users.get(id);
    if (!e) return null;
    for (const c of e.conns) if (c.rtt != null) return c.rtt;
    return null;
  }
}

export class Hub {
  constructor({ repos, pool, personas, map = loadMap('manor'), matchmakerOpts = {} }) {
    this.repos = repos;
    this.pool = pool;
    this.personas = personas;
    personas.hub = this;
    this.map = map;
    this.presence = new Presence(this);
    this.lobbies = new LobbyManager(this);
    this.matchmaker = new Matchmaker(this, matchmakerOpts);
    this.sessions = new Map();
    this.sessionOf = new Map();
    this.activityListeners = new Set();
  }

  stop() {
    this.matchmaker.stop();
    for (const s of this.sessions.values()) s.stop();
  }

  // ---------------- transport ----------------

  sendTo(userId, msg) {
    const e = this.presence.get(userId);
    if (!e || !e.conns.size) return;
    const data = JSON.stringify(msg);
    for (const c of e.conns) c.send(data);
  }

  pingOf(id) {
    return this.personas.isPersona(id) ? this.personas.ping(id) : this.presence.ping(id);
  }

  // A conn is { send(str), close(), rtt, userId }
  async hello(conn, token) {
    const user = await userFromToken(this.repos, token);
    if (!user) {
      conn.send(JSON.stringify({ t: 'error', code: 'auth', message: 'Please log in again' }));
      conn.close();
      return;
    }
    conn.userId = user._id;
    const e = this.presence.entry(user);
    e.conns.add(conn);
    clearTimeout(e.lobbyGrace);
    e.lobbyGrace = null;
    conn.send(JSON.stringify({ t: 'welcome', user: publicUser(user) }));
    const session = this.sessionOf.get(user._id);
    if (session && session.onConnect(user._id)) return;
    const lobby = this.lobbies.lobbyOf(user._id);
    if (lobby) conn.send(JSON.stringify(this.lobbies.publicState(lobby)));
    if (this.matchmaker.has(user._id)) this.matchmaker.status(user._id);
  }

  onClose(conn) {
    const id = conn.userId;
    if (!id) return;
    const e = this.presence.get(id);
    if (!e) return;
    e.conns.delete(conn);
    if (e.conns.size) return;
    const session = this.sessionOf.get(id);
    if (session) session.onDisconnect(id);
    this.matchmaker.leave(id);
    if (e.lobbyId && !session) {
      e.lobbyGrace = setTimeout(() => {
        if (!e.conns.size) this.lobbies.leave(id);
      }, LOBBY_GRACE_MS);
    }
    this.emitActivity();
  }

  async handle(conn, msg) {
    const uid = conn.userId;
    if (msg.t === 'hello') return this.hello(conn, msg.token);
    if (!uid) return;
    const reply = (m) => conn.send(JSON.stringify(m));
    const err = (r) => r?.error && reply({ t: 'error', message: r.error, missing: r.missing });
    const session = this.sessionOf.get(uid);
    switch (msg.t) {
      case 'input': return session?.input(uid, msg);
      case 'use': return session?.action(uid, { type: 'use', x: msg.x, y: msg.y });
      case 'marker': return session?.action(uid, { type: 'marker', x: msg.x, y: msg.y });
      case 'chat': {
        const text = QUICK_CHAT[msg.i | 0];
        if (!text) return;
        if (session) return session.chat(uid, text);
        return this.lobbies.chat(uid, text);
      }
      case 'game:leave':
        if (session) {
          await session.onLeave(uid);
          this.sessionOf.delete(uid);
          reply({ t: 'game:left' });
          const lobby = this.lobbies.lobbyOf(uid);
          if (lobby) this.lobbies.leave(uid);
        }
        return;
      case 'game:pause': return session?.pause(uid);
      case 'game:resume': return session?.resume(uid);
      case 'game:saveVote': return session?.voteSave(uid, msg.yes);
      case 'lobby:create': {
        if (session) return;
        this.matchmaker.leave(uid);
        const lobby = this.lobbies.create(uid);
        return lobby;
      }
      case 'lobby:join': if (!session) err(this.lobbies.join(msg.code, uid)); return;
      case 'lobby:leave': return this.lobbies.leave(uid);
      case 'lobby:ready': return this.lobbies.setReady(uid, !!msg.ready);
      case 'lobby:kick': return this.lobbies.kick(uid, msg.id);
      case 'lobby:open': return this.lobbies.setOpen(uid, !!msg.open);
      case 'lobby:settings': return this.lobbies.setSettings(uid, { roundSeconds: msg.roundSeconds | 0 });
      case 'lobby:invite': {
        const r = await this.lobbies.invite(uid, String(msg.name || ''));
        if (r.error) err(r);
        else reply({ t: 'toast', text: `Invite sent to ${msg.name}` });
        return;
      }
      case 'lobby:inviteReply': if (!session) err(this.lobbies.inviteReply(uid, msg.lobbyId, !!msg.accept)); return;
      case 'lobby:start': return err(await this.lobbies.start(uid, { replaceMissing: !!msg.replaceMissing }));
      case 'lobby:resumeSaved': {
        if (session) return;
        const saved = await this.repos.savedGames.get(String(msg.savedId));
        if (!saved || !saved.participants.includes(uid)) return err({ error: 'Saved game not found' });
        for (const l of this.lobbies.lobbies.values()) {
          if (l.saved?._id === saved._id) return err(this.lobbies.join(l.code, uid));
        }
        this.matchmaker.leave(uid);
        for (const r of saved.roster) if (r.kind === 'persona') await this.presence.ensurePersona(r.id);
        this.lobbies.create(uid, { saved });
        return;
      }
      case 'queue:join': {
        if (session || this.lobbies.lobbyOf(uid)) return err({ error: 'Leave your lobby first' });
        return err(await this.matchmaker.join(uid));
      }
      case 'queue:leave': return this.matchmaker.leave(uid);
      case 'online:list': return reply({ t: 'online', list: this.onlineList(uid) });
    }
  }

  onlineList(exclude) {
    const out = [];
    const statusOf = (id) => (this.sessionOf.has(id) ? 'in game' : this.presence.get(id)?.lobbyId ? 'in lobby' : 'online');
    for (const e of this.presence.users.values()) {
      if (e.conns.size && e.user._id !== exclude) out.push({ ...publicUser(e.user), status: statusOf(e.user._id) });
    }
    out.push(...this.personas.onlineList(statusOf).filter((p) => p.id !== exclude));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------- sessions ----------------

  async participantsFor(ids) {
    const users = await this.repos.users.byIds(ids);
    const byId = new Map(users.map((u) => [u._id, u]));
    return ids.filter((id) => byId.has(id)).map((id) => {
      const u = byId.get(id);
      return { id, kind: this.personas.isPersona(id) ? 'persona' : 'human', name: u.name, color: u.color, rating: u.rating, games: u.games };
    });
  }

  launch(session) {
    this.sessions.set(session.id, session);
    for (const part of session.p.values()) {
      this.sessionOf.set(part.id, session);
      if (part.kind === 'human' && this.presence.get(part.id)?.conns.size) session.onConnect(part.id);
    }
    session.start();
    this.emitActivity();
  }

  async startRanked(ids, { filled }) {
    const participants = await this.participantsFor(ids);
    const s = new GameSession(this, { ranked: true, map: this.map, participants, filled, roundSeconds: +process.env.ROUND_SECONDS || undefined, headstart: process.env.HEADSTART_SECONDS ? +process.env.HEADSTART_SECONDS : undefined });
    this.launch(s);
    return s;
  }

  async startCustom(lobby) {
    let s;
    if (lobby.saved) {
      const roster = lobby.saved.roster;
      const participants = roster.map((r) => ({ ...r }));
      s = new GameSession(this, { ranked: false, map: loadMap(lobby.saved.mapId), participants, lobbyId: lobby.id, state: lobby.saved.state, savedFrom: lobby.saved._id });
    } else {
      const participants = await this.participantsFor(lobby.members);
      s = new GameSession(this, { ranked: false, map: this.map, participants, lobbyId: lobby.id, roundSeconds: +process.env.ROUND_SECONDS || lobby.roundSeconds, headstart: process.env.HEADSTART_SECONDS ? +process.env.HEADSTART_SECONDS : undefined });
    }
    lobby.sessionId = s.id;
    this.lobbies.broadcast(lobby);
    this.launch(s);
  }

  onSessionEnd(session, results) {
    this.sessions.delete(session.id);
    for (const part of session.p.values()) {
      if (this.sessionOf.get(part.id) === session) this.sessionOf.delete(part.id);
      if (part.kind === 'persona' && !results) {
        const inLobby = session.lobbyId && this.lobbies.get(session.lobbyId)?.members.includes(part.id);
        if (!inLobby) this.personas.release(part.id);
      }
    }
    const lobby = session.lobbyId && this.lobbies.get(session.lobbyId);
    if (lobby) {
      lobby.sessionId = null;
      lobby.ready.clear();
      if (lobby.saved) lobby.saved = null;
      // members who left the game also leave the lobby; personas stay for the next round
      for (const part of session.p.values()) if (part.left) this.lobbies.leave(part.id);
      if (this.lobbies.get(lobby.id)) {
        for (const m of lobby.members) if (this.personas.isPersona(m)) {
          this.personas.personas.get(m).busy = true;
          this.personas.onLobbyJoin(m, { ready: () => lobby.members.includes(m) && this.lobbies.setReady(m, true), chat: () => {} });
        }
        setTimeout(() => this.lobbies.get(lobby.id) && this.lobbies.broadcast(lobby), 50);
      }
    }
    this.emitActivity();
  }

  // ---------------- activity (for idle training) ----------------

  isBusy() {
    for (const s of this.sessions.values()) if (s.hasConnectedHumans()) return true;
    return this.matchmaker.pending.size > 0;
  }

  onActivity(fn) {
    this.activityListeners.add(fn);
  }

  emitActivity() {
    for (const fn of this.activityListeners) fn(this.isBusy());
  }

  // ---------------- crash recovery ----------------

  async recover() {
    const snaps = await this.repos.snapshots.unfinished();
    const report = { resumed: 0, voided: 0, saved: 0 };
    for (const snap of snaps) {
      const age = Date.now() - snap.savedAt;
      if (snap.ranked) {
        if (age > RANKED_RESUME_MAX_AGE || snap.state.phase === 'ended') {
          await this.repos.snapshots.finish(snap._id, 'voided');
          report.voided++;
          continue;
        }
        for (const part of snap.participants) if (part.kind === 'persona') {
          await this.presence.ensurePersona(part.id);
          const p = this.personas.personas.get(part.id);
          if (p) p.busy = true;
        }
        const s = new GameSession(this, { id: snap._id, ranked: true, map: loadMap(snap.mapId), participants: snap.participants, state: snap.state, filled: snap.filled });
        for (const part of s.p.values()) {
          const orig = snap.participants.find((x) => x.id === part.id);
          if (orig?.left) part.left = true;
        }
        this.launch(s);
        report.resumed++;
      } else {
        await this.repos.savedGames.insert({
          gameId: snap._id, mapId: snap.mapId, hostId: snap.participants.find((p) => p.kind === 'human')?.id,
          participants: snap.participants.filter((p) => p.kind === 'human').map((p) => p.id),
          roster: snap.participants, state: snap.state, timeLeft: snap.state.headstart + snap.state.roundSeconds - snap.state.time, recovered: true,
        });
        await this.repos.snapshots.finish(snap._id, 'saved');
        report.saved++;
      }
    }
    return report;
  }
}
