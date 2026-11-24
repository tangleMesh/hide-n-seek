// GameSession: runs one Game in real time. Owns connection state (reconnect grace, AI takeover),
// snapshots for crash recovery, pause/save (custom only), imitation recording and the ELO update.
import { randomUUID, randomInt } from 'node:crypto';
import { TICK_RATE, DT, startingSeekers } from '../shared/constants.js';
import { Game } from './game.js';
import { observe } from './observe.js';
import { ratingChanges } from './elo.js';
import { BotController } from '../ai/botController.js';
import { HumanRecorder } from '../ai/recorder.js';
import { hashSeed } from '../ai/rng.js';

export const RECONNECT_GRACE = 60; // seconds
const SNAPSHOT_EVERY = 2; // seconds

export class GameSession {
  /**
   * participants: [{ id, kind: 'human'|'persona', name, color, rating, games }]
   */
  constructor(hub, { id = randomUUID(), ranked, map, participants, lobbyId = null, roundSeconds, headstart, state = null, filled = false, savedFrom = null, parties = [] }) {
    this.hub = hub;
    // ranked groups that queued together (they return to their lobby afterwards)
    this.partyLobbies = parties.map((p) => p.lobbyId).filter(Boolean);
    this.id = id;
    this.ranked = !!ranked;
    this.map = map;
    this.lobbyId = lobbyId;
    this.filled = filled;
    this.savedFrom = savedFrom;
    this.paused = false;
    this.saveVotes = new Map();
    this.ended = false;
    this.lastSnapshot = 0;
    this.chatTimes = new Map();
    this.p = new Map();
    for (const part of participants) {
      this.p.set(part.id, { ...part, connected: false, awaySince: null, left: false, input: null, bot: null, recorder: null, usedItem: false });
    }
    if (state) {
      this.game = Game.fromSnapshot(map, state);
    } else {
      const ids = participants.map((x) => x.id);
      const shuffled = [...ids];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // Solo players start as seekers first: a group member seeking their own friends could go easy on them
      // and push their ratings.
      const inParty = new Set(parties.flatMap((p) => p.members));
      shuffled.sort((a, b) => inParty.has(a) - inParty.has(b));
      this.game = new Game(map, { id, playerIds: ids, seekerIds: shuffled.slice(0, startingSeekers(ids.length)), roundSeconds, headstart });
    }
    for (const part of this.p.values()) {
      if (part.kind === 'persona') part.bot = hub.personas.controllerFor(part.id, map, hashSeed(part.id + id));
      else {
        part.awaySince = Date.now(); // until they (re)connect, the AI holds their avatar
        part.bot = this.substituteBot(part.id);
        if (process.env.RECORD_SAMPLES !== 'off') part.recorder = new HumanRecorder(map, part.id);
      }
    }
  }

  substituteBot(id) {
    return new BotController(this.map, id, this.hub.pool.champion(), { traits: { mistakeRate: 0.08, reactionMs: 250 }, seed: hashSeed(id) });
  }

  roster() {
    return [...this.p.values()].map((x) => ({ id: x.id, name: x.name, color: x.color, face: x.face, rating: x.rating }));
  }

  humans() {
    return [...this.p.values()].filter((x) => x.kind === 'human');
  }

  hasConnectedHumans() {
    return this.humans().some((x) => x.connected);
  }

  start() {
    this.startedAt = Date.now();
    this.broadcastStart();
    this.loopNext = performance.now();
    this.loop();
    this.saveSnapshot();
  }

  loop() {
    if (this.ended) return;
    const now = performance.now();
    let n = 0;
    while (now >= this.loopNext && n < 5) {
      this.tick();
      this.loopNext += 1000 / TICK_RATE;
      n++;
    }
    if (now - this.loopNext > 1000) this.loopNext = now; // don't spiral after a long stall
    this.timer = setTimeout(() => this.loop(), Math.max(1, this.loopNext - performance.now()));
  }

  stop() {
    this.ended = true;
    clearTimeout(this.timer);
  }

  broadcastStart(only = null) {
    const msg = {
      t: 'game:start', gameId: this.id, ranked: this.ranked, mapId: this.map.id, roster: this.roster(),
      paused: this.paused, canPause: !this.ranked, hostId: this.hostId(),
    };
    if (only) this.hub.sendTo(only, msg);
    else for (const h of this.humans()) if (!h.left) this.hub.sendTo(h.id, msg);
  }

  hostId() {
    if (this.ranked) return null;
    const lobby = this.lobbyId && this.hub.lobbies.get(this.lobbyId);
    return lobby?.hostId ?? this.humans()[0]?.id ?? null;
  }

  // ---------------- connections ----------------

  onConnect(userId) {
    const part = this.p.get(userId);
    if (!part || part.kind !== 'human') return false;
    if (part.left && this.ranked) return false; // leavers cannot come back into a ranked match
    part.connected = true;
    part.left = false;
    part.awaySince = null;
    part.bot = null;
    part.input = null;
    this.broadcastStart(userId);
    this.broadcastEvent({ type: 'playerBack', id: userId });
    return true;
  }

  onDisconnect(userId) {
    const part = this.p.get(userId);
    if (!part || part.kind !== 'human' || !part.connected) return;
    part.connected = false;
    part.awaySince = Date.now();
    part.bot = this.substituteBot(userId);
    this.broadcastEvent({ type: 'playerAway', id: userId });
  }

  // Voluntary leave.
  async onLeave(userId) {
    const part = this.p.get(userId);
    if (!part || part.kind !== 'human') return;
    part.connected = false;
    part.left = true;
    part.awaySince = part.awaySince ?? Date.now();
    if (!part.bot) part.bot = this.substituteBot(userId);
    this.broadcastEvent({ type: 'playerLeft', id: userId });
    if (this.ranked) await this.hub.repos.leavers.add(userId, this.id);
    if (!this.humans().some((h) => !h.left)) {
      // everybody left: ranked plays out with AI quickly; custom is discarded
      if (!this.ranked) this.abort('abandoned');
    }
  }

  input(userId, msg) {
    const part = this.p.get(userId);
    if (!part || !part.connected) return;
    part.input = {
      dx: clampNum(msg.dx, -1, 1), dy: clampNum(msg.dy, -1, 1), mode: ['sneak', 'walk', 'sprint'].includes(msg.mode) ? msg.mode : 'walk',
      aim: Number.isFinite(msg.aim) ? msg.aim : undefined, seq: Number.isInteger(msg.seq) ? msg.seq : 0,
    };
  }

  action(userId, msg) {
    const part = this.p.get(userId);
    if (!part || !part.connected || this.paused) return;
    if (msg.type === 'use') part.usedItem = true;
    this.game.queueAction(userId, { type: msg.type, x: +msg.x, y: +msg.y });
  }

  chat(userId, text, opts = {}) {
    const now = Date.now();
    if (now - (this.chatTimes.get(userId) || 0) < 900) return;
    this.chatTimes.set(userId, now);
    const msg = { t: 'chat', from: userId, text, scope: 'game' };
    for (const h of this.humans()) if (h.connected || opts.afterEnd) this.hub.sendTo(h.id, msg);
  }

  broadcastEvent(ev) {
    for (const h of this.humans()) if (h.connected) this.hub.sendTo(h.id, { t: 'event', ev });
  }

  // ---------------- simulation ----------------

  tick() {
    if (this.paused || this.ended) return;
    const g = this.game;
    const now = Date.now();
    const obsCache = new Map();
    for (const part of this.p.values()) {
      if (part.kind === 'human' && !part.connected && !part.left && part.awaySince && now - part.awaySince > RECONNECT_GRACE * 1000) {
        part.left = true;
        if (this.ranked) this.hub.repos.leavers.add(part.id, this.id).catch(() => {});
        this.broadcastEvent({ type: 'playerLeft', id: part.id });
      }
      if (part.bot) {
        const obs = observe(g, part.id);
        obsCache.set(part.id, obs);
        const { input, actions } = part.bot.act(obs);
        g.setInput(part.id, input);
        for (const a of actions) g.queueAction(part.id, a);
      } else {
        g.setInput(part.id, part.input || { dx: 0, dy: 0, mode: 'walk' });
      }
    }
    g.step(DT);
    let important = false;
    for (const ev of g.events) {
      if (ev.type === 'caught' || ev.type === 'lastHider' || ev.type === 'phase' || ev.type === 'trap') {
        this.broadcastEvent(ev);
        this.hub.personas.onGameEvent(ev, this);
      }
      if (ev.type !== 'use') important = true;
    }
    // per-human snapshots + imitation recording
    for (const part of this.p.values()) {
      if (part.kind !== 'human' || !part.connected) continue;
      const obs = obsCache.get(part.id) || observe(g, part.id);
      this.hub.sendTo(part.id, { t: 'snap', ...obs });
      if (part.recorder && !part.bot) {
        part.recorder.tick(obs, { mode: g.state.players[part.id].mode, usedItem: part.usedItem });
        part.usedItem = false;
      }
    }
    if (g.state.phase === 'ended') {
      this.finish().catch((e) => console.error('[session] finish', e));
      return;
    }
    if (important || g.state.time - this.lastSnapshot >= SNAPSHOT_EVERY) this.saveSnapshot();
    if (g.state.tick % (TICK_RATE * 2) === 0) this.sendPings();
  }

  sendPings() {
    const pings = {};
    for (const part of this.p.values()) {
      pings[part.id] = part.kind === 'persona' ? this.hub.personas.ping(part.id) : this.hub.presence.ping(part.id);
    }
    for (const h of this.humans()) if (h.connected) this.hub.sendTo(h.id, { t: 'pings', pings });
  }

  snapshotDoc() {
    return {
      gameId: this.id,
      ranked: this.ranked,
      lobbyId: this.lobbyId,
      mapId: this.map.id,
      filled: this.filled,
      participants: [...this.p.values()].map((x) => ({ id: x.id, kind: x.kind, name: x.name, color: x.color, face: x.face, rating: x.rating, games: x.games, left: x.left })),
      state: this.game.serialize(),
      paused: this.paused,
    };
  }

  saveSnapshot() {
    this.lastSnapshot = this.game.state.time;
    return this.hub.repos.snapshots.upsert(this.id, this.snapshotDoc()).catch((e) => console.error('[session] snapshot', e.message));
  }

  // ---------------- pause / save (custom only) ----------------

  pause(userId) {
    if (this.ranked || userId !== this.hostId() || this.paused) return;
    this.paused = true;
    this.saveVotes.clear();
    this.broadcastEvent({ type: 'paused', by: userId });
    this.saveSnapshot();
  }

  resume(userId) {
    if (this.ranked || userId !== this.hostId() || !this.paused) return;
    this.paused = false;
    this.loopNext = performance.now();
    this.broadcastEvent({ type: 'resumed', by: userId });
  }

  async voteSave(userId, yes) {
    if (this.ranked || !this.paused) return;
    const part = this.p.get(userId);
    if (!part || part.kind !== 'human') return;
    this.saveVotes.set(userId, !!yes);
    const voters = this.humans().filter((h) => h.connected);
    const yesVotes = [...this.saveVotes.entries()].filter(([id, v]) => v && voters.some((h) => h.id === id)).length;
    this.broadcastEvent({ type: 'saveVote', yes: yesVotes, needed: Math.floor(voters.length / 2) + 1 });
    if (yesVotes > voters.length / 2) await this.saveAndQuit();
  }

  async saveAndQuit() {
    const doc = this.snapshotDoc();
    const saved = await this.hub.repos.savedGames.insert({
      gameId: this.id,
      mapId: this.map.id,
      hostId: this.hostId(),
      participants: this.humans().map((h) => h.id),
      roster: doc.participants,
      state: doc.state,
      timeLeft: this.game.timeLeft,
    });
    await this.hub.repos.snapshots.finish(this.id, 'saved');
    if (this.savedFrom) await this.hub.repos.savedGames.delete(this.savedFrom);
    this.stop();
    for (const h of this.humans()) if (h.connected) this.hub.sendTo(h.id, { t: 'game:saved', savedId: saved._id });
    this.hub.onSessionEnd(this, null);
  }

  abort(outcome) {
    this.stop();
    this.hub.repos.snapshots.finish(this.id, outcome).catch(() => {});
    for (const h of this.humans()) if (h.connected) this.hub.sendTo(h.id, { t: 'game:aborted', reason: outcome });
    this.hub.onSessionEnd(this, null);
  }

  // ---------------- end of round ----------------

  async finish() {
    if (this.ended) return;
    this.stop();
    const g = this.game;
    const scores = g.scores();
    const parts = [...this.p.values()];
    for (const part of parts) if (part.left && part.kind === 'human') scores[part.id] = 0; // leaver: worst score
    let deltas = {};
    if (this.ranked) {
      deltas = ratingChanges(parts.map((x) => ({ id: x.id, rating: x.rating, games: x.games, startRole: g.state.players[x.id].startRole, score: scores[x.id] })));
    }
    const winner = g.state.winner;
    const results = parts.map((x) => {
      const pl = g.state.players[x.id];
      const win = !x.left && (pl.startRole === 'seeker' ? winner === 'seekers' : pl.caughtAt === null);
      return {
        id: x.id, name: x.name, startRole: pl.startRole, caught: pl.caughtAt !== null, catches: pl.catches,
        score: +scores[x.id].toFixed(3), delta: deltas[x.id] ?? 0, ratingBefore: x.rating, win,
        caughtEarly: pl.caughtAt !== null && pl.caughtAt - g.state.headstart < 60,
      };
    });
    const repos = this.hub.repos;
    try {
      if (this.ranked) await repos.users.applyResults(results.map((r) => ({ id: r.id, delta: r.delta, win: r.win })));
      await repos.matches.insert({
        _id: this.id, ranked: this.ranked, mapId: this.map.id, winner, filled: this.filled,
        userIds: parts.map((x) => x.id),
        personaIds: parts.filter((x) => x.kind === 'persona').map((x) => x.id),
        players: results.map(({ caughtEarly, ...r }) => ({ userId: r.id, name: r.name, startRole: r.startRole, caught: r.caught, catches: r.catches, score: r.score, delta: r.delta, ratingBefore: r.ratingBefore, win: r.win, left: !!this.p.get(r.id).left })),
        duration: g.state.time,
      });
      await repos.snapshots.finish(this.id, 'finished');
      if (this.savedFrom) await repos.savedGames.delete(this.savedFrom);
      const samples = [];
      for (const part of parts) if (part.recorder) samples.push(...part.recorder.drain());
      if (samples.length) await repos.samples.insertMany(samples);
    } catch (e) {
      console.error('[session] persisting results failed', e);
    }
    const msg = { t: 'roundEnd', winner, ranked: this.ranked, results: results.map(({ caughtEarly, score, ...r }) => r) };
    for (const h of this.humans()) if (h.connected) this.hub.sendTo(h.id, msg);
    await this.hub.personas.onMatchEnd(this, results);
    this.hub.onSessionEnd(this, results);
  }
}

function clampNum(v, lo, hi) {
  v = +v;
  if (!Number.isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, v));
}
