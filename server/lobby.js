// Custom lobbies: codes, invites, host migration, kick, "find players" (persona fill), ready-up,
// and lobbies created from a saved game (resume only with the same human players).
import { randomUUID, randomInt } from 'node:crypto';
import { defaultFace } from '../shared/look.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_PLAYERS = 16;
export const MIN_CUSTOM = 2;

export class LobbyManager {
  constructor(hub) {
    this.hub = hub;
    this.lobbies = new Map();
    this.byCode = new Map();
  }

  get(id) {
    return this.lobbies.get(id);
  }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
      if (!this.byCode.has(c)) return c;
    }
  }

  create(hostId, { saved = null } = {}) {
    const lobby = {
      id: randomUUID(), code: this.newCode(), hostId, members: [], ready: new Set(), open: false,
      saved, roundSeconds: 300, sessionId: null, fillTimer: null, createdAt: Date.now(),
    };
    this.lobbies.set(lobby.id, lobby);
    this.byCode.set(lobby.code, lobby);
    this.addMember(lobby, hostId);
    if (saved) {
      // personas from the saved game come back automatically
      for (const r of saved.roster) if (r.kind === 'persona' && !lobby.members.includes(r.id)) this.addMember(lobby, r.id);
    }
    return lobby;
  }

  addMember(lobby, userId) {
    const hub = this.hub;
    const prev = hub.presence.get(userId)?.lobbyId;
    if (prev && prev !== lobby.id) this.leave(userId);
    if (!lobby.members.includes(userId)) lobby.members.push(userId);
    hub.presence.setLobby(userId, lobby.id);
    hub.matchmaker.leave(userId);
    if (hub.personas.isPersona(userId)) {
      hub.personas.personas.get(userId).busy = true;
      hub.personas.onLobbyJoin(userId, {
        ready: () => lobby.members.includes(userId) && this.setReady(userId, true),
        chat: (text) => this.chat(userId, text),
      });
    }
    this.broadcast(lobby);
  }

  join(code, userId) {
    const lobby = this.byCode.get(String(code || '').toUpperCase());
    if (!lobby) return { error: 'Lobby not found' };
    if (lobby.sessionId) return { error: 'That lobby is in a game right now' };
    if (lobby.members.length >= MAX_PLAYERS && !lobby.members.includes(userId)) return { error: 'Lobby is full' };
    this.addMember(lobby, userId);
    return { lobby };
  }

  leave(userId) {
    const lobbyId = this.hub.presence.get(userId)?.lobbyId;
    const lobby = lobbyId && this.lobbies.get(lobbyId);
    this.hub.presence.setLobby(userId, null);
    if (!lobby) return;
    lobby.members = lobby.members.filter((m) => m !== userId);
    lobby.ready.delete(userId);
    if (this.hub.personas.isPersona(userId)) this.hub.personas.release(userId);
    else this.hub.sendTo(userId, { t: 'lobby:left' });
    const humans = lobby.members.filter((m) => !this.hub.personas.isPersona(m));
    if (!humans.length) return this.close(lobby);
    if (lobby.hostId === userId) lobby.hostId = humans[0]; // oldest remaining human becomes host
    this.broadcast(lobby);
  }

  close(lobby) {
    clearTimeout(lobby.fillTimer);
    for (const m of lobby.members) {
      this.hub.presence.setLobby(m, null);
      if (this.hub.personas.isPersona(m)) this.hub.personas.release(m);
    }
    this.lobbies.delete(lobby.id);
    this.byCode.delete(lobby.code);
  }

  kick(hostId, target) {
    const lobby = this.lobbyOf(hostId);
    if (!lobby || lobby.hostId !== hostId || target === hostId) return;
    this.leave(target);
    this.hub.sendTo(target, { t: 'toast', text: 'You were removed from the lobby' });
  }

  lobbyOf(userId) {
    const id = this.hub.presence.get(userId)?.lobbyId;
    return id ? this.lobbies.get(id) : null;
  }

  setReady(userId, ready) {
    const lobby = this.lobbyOf(userId);
    if (!lobby) return;
    if (ready) lobby.ready.add(userId);
    else lobby.ready.delete(userId);
    this.broadcast(lobby);
  }

  setSettings(userId, { roundSeconds }) {
    const lobby = this.lobbyOf(userId);
    if (!lobby || lobby.hostId !== userId || lobby.saved) return;
    if ([120, 180, 300, 420].includes(roundSeconds)) lobby.roundSeconds = roundSeconds;
    this.broadcast(lobby);
  }

  // "Find players": fill the lobby with matchmaking-pool players (personas) one by one, with natural delays.
  setOpen(userId, open) {
    const lobby = this.lobbyOf(userId);
    if (!lobby || lobby.hostId !== userId) return;
    lobby.open = !!open;
    clearTimeout(lobby.fillTimer);
    if (lobby.open) this.scheduleFill(lobby);
    this.broadcast(lobby);
  }

  scheduleFill(lobby) {
    lobby.fillTimer = setTimeout(async () => {
      if (!this.lobbies.has(lobby.id) || !lobby.open || lobby.sessionId) return;
      if (lobby.members.length >= 8) {
        lobby.open = false;
        this.broadcast(lobby);
        return;
      }
      const users = await this.hub.repos.users.byIds(lobby.members);
      const avg = users.reduce((a, u) => a + u.rating, 0) / Math.max(1, users.length);
      const humans = lobby.members.filter((m) => !this.hub.personas.isPersona(m));
      const id = await this.hub.personas.pick(avg, { window: 250, exclude: new Set(lobby.members), humans });
      await this.hub.presence.ensurePersona(id);
      if (this.lobbies.has(lobby.id) && lobby.open && !lobby.sessionId) this.addMember(lobby, id);
      else this.hub.personas.release(id);
      this.scheduleFill(lobby);
    }, 1500 + Math.random() * 4500);
  }

  async invite(fromId, toName) {
    const lobby = this.lobbyOf(fromId);
    if (!lobby) return { error: 'Create a lobby first' };
    const target = await this.hub.repos.users.byName(toName);
    if (!target) return { error: 'No such player' };
    if (lobby.members.includes(target._id)) return { error: 'Already in your lobby' };
    const from = this.hub.presence.get(fromId)?.user;
    if (this.hub.personas.isPersona(target._id)) {
      const p = this.hub.personas.personas.get(target._id);
      if (!p.online) return { error: `${target.name} is offline` };
      this.hub.personas.onInvite(
        target._id,
        async () => {
          if (!this.lobbies.has(lobby.id) || lobby.sessionId || lobby.members.length >= MAX_PLAYERS) return;
          await this.hub.presence.ensurePersona(target._id);
          this.addMember(lobby, target._id);
        },
        () => this.hub.sendTo(fromId, { t: 'toast', text: `${target.name} declined your invite` }),
      );
      return { ok: true };
    }
    if (!this.hub.presence.isOnline(target._id)) return { error: `${target.name} is offline` };
    this.hub.sendTo(target._id, { t: 'invite', lobbyId: lobby.id, code: lobby.code, from: from?.name });
    return { ok: true };
  }

  inviteReply(userId, lobbyId, accept) {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return { error: 'Lobby no longer exists' };
    if (!accept) {
      this.hub.sendTo(lobby.hostId, { t: 'toast', text: `${this.hub.presence.get(userId)?.user.name} declined your invite` });
      return { ok: true };
    }
    return this.join(lobby.code, userId);
  }

  chat(userId, text) {
    const lobby = this.lobbyOf(userId);
    if (!lobby) return;
    for (const m of lobby.members) this.hub.sendTo(m, { t: 'chat', from: userId, name: this.hub.presence.get(userId)?.user.name, text, scope: 'lobby' });
  }

  async start(userId, { replaceMissing = false } = {}) {
    const lobby = this.lobbyOf(userId);
    if (!lobby || lobby.hostId !== userId || lobby.sessionId) return { error: 'Only the host can start' };
    const notReady = lobby.members.filter((m) => m !== lobby.hostId && !lobby.ready.has(m));
    if (notReady.length) return { error: 'Not everyone is ready' };
    if (lobby.saved) {
      const missing = lobby.saved.participants.filter((id) => !lobby.members.includes(id));
      if (missing.length && !replaceMissing) {
        const names = lobby.saved.roster.filter((r) => missing.includes(r.id)).map((r) => r.name);
        return { error: `Waiting for original players: ${names.join(', ')}`, missing: names };
      }
      const extra = lobby.members.filter((m) => !lobby.saved.roster.some((r) => r.id === m));
      if (extra.length) return { error: 'Only the original players can join a saved game' };
    } else if (lobby.members.length < MIN_CUSTOM) {
      return { error: `Need at least ${MIN_CUSTOM} players (use "Find players" to fill)` };
    }
    clearTimeout(lobby.fillTimer);
    lobby.open = false;
    await this.hub.startCustom(lobby);
    return { ok: true };
  }

  publicState(lobby) {
    const pres = this.hub.presence;
    const savedColor = new Map((lobby.saved?.roster || []).map((r) => [r.id, r.color]));
    const colors = this.hub.gameColors(lobby.members.map((id) => ({ id, color: savedColor.get(id) || pres.get(id)?.user?.color })));
    const members = lobby.members.map((id) => {
      const u = pres.get(id)?.user;
      return { id, name: u?.name, color: colors.get(id), face: u?.face || defaultFace(id), rating: u?.rating, ready: lobby.ready.has(id) || id === lobby.hostId, host: id === lobby.hostId, ping: this.hub.pingOf(id) };
    });
    return {
      t: 'lobby:state', id: lobby.id, code: lobby.code, hostId: lobby.hostId, members, open: lobby.open,
      roundSeconds: lobby.roundSeconds, inGame: !!lobby.sessionId,
      saved: lobby.saved ? { id: lobby.saved._id, timeLeft: Math.round(lobby.saved.timeLeft), roster: lobby.saved.roster.map((r) => ({ id: r.id, name: r.name, color: r.color, face: r.face || defaultFace(r.id) })), participants: lobby.saved.participants } : null,
    };
  }

  broadcast(lobby) {
    const st = this.publicState(lobby);
    for (const m of lobby.members) this.hub.sendTo(m, st);
  }
}
