// Persona manager: keeps a population of AI "players" that are indistinguishable from humans for clients.
// Handles selection (reuse vs. 25% fresh), online sessions/breaks, invites, chat reactions and tilt.
import { randomInt } from 'node:crypto';
import { mulberry32, hashSeed } from '../rng.js';
import { BotController } from '../botController.js';
import { skillFromRating } from '../pool.js';
import { generateName, generateTraits, generateHistory, generateRecentMatches } from './generator.js';
import { chatFor, tiltAfter } from './behavior.js';
import { publicUser } from '../../server/data/index.js';

export const FRESH_PROBABILITY = 0.25;

export class PersonaManager {
  constructor({ repos, pool, map, hub = null, seed = Date.now() }) {
    this.repos = repos;
    this.pool = pool;
    this.map = map;
    this.hub = hub;
    this.rnd = mulberry32(seed >>> 0);
    this.personas = new Map(); // id -> state
    this.stats = { fills: 0, fresh: 0, reused: 0 };
    this.timers = new Set();
  }

  async init({ minPopulation = 24 } = {}) {
    const docs = await this.repos.personas.all();
    const users = docs.length ? await this.repos.users.byIds(docs.map((d) => d._id)) : [];
    const byId = new Map(users.map((u) => [u._id, u]));
    for (const d of docs) {
      const u = byId.get(d._id);
      if (u) this.personas.set(d._id, this.stateFrom(d, u));
    }
    // seed a starting population spread over the rating range
    while (this.personas.size < minPopulation) {
      const r = Math.round(800 + this.rnd() * 700 + (this.rnd() - 0.5) * 300);
      await this.createFresh(r);
    }
    this.rotateOnline();
    const t = setInterval(() => this.rotateOnline(), 45_000);
    t.unref?.();
    this.timers.add(t);
  }

  stateFrom(doc, user) {
    return { id: doc._id, traits: doc.traits, tilt: doc.tilt || 0, user, online: false, busy: false, breakUntil: 0, lastMet: doc.lastMet || {}, rematch: null };
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      try { fn(); } catch (e) { console.error('[persona]', e); }
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
  }

  isPersona(id) {
    return this.personas.has(id);
  }

  ping(id) {
    const p = this.personas.get(id);
    if (!p) return null;
    return Math.round(p.traits.pingBase + this.rnd() * 8 + (this.rnd() < 0.03 ? 60 : 0));
  }

  // Some personas are "online" (visible in the online list, can accept invites); they come and go.
  rotateOnline() {
    const hour = new Date().getHours();
    const target = Math.min(this.personas.size, Math.round(6 + 6 * Math.sin(((hour - 6) / 24) * Math.PI * 2) + 6 + this.rnd() * 3));
    const all = [...this.personas.values()];
    for (const p of all) if (p.online && !p.busy && this.rnd() < 0.15) p.online = false;
    let online = all.filter((p) => p.online).length;
    for (const p of all.sort(() => this.rnd() - 0.5)) {
      if (online >= target) break;
      if (!p.online && Date.now() > p.breakUntil) {
        p.online = true;
        online++;
      }
    }
  }

  // statusOf: same status function the hub uses for humans, so personas never look different.
  onlineList(statusOf = () => 'online') {
    return [...this.personas.values()].filter((p) => p.online).map((p) => ({ ...publicUser(p.user), status: statusOf(p.id) }));
  }

  async createFresh(targetRating) {
    let name;
    for (let i = 0; i < 20; i++) {
      name = generateName(this.rnd);
      if (!(await this.repos.users.nameTaken(name))) break;
      name = null;
    }
    if (!name) name = 'player' + randomInt(10000, 99999);
    const traits = generateTraits(this.rnd, this.map);
    const rating = Math.round(targetRating + (this.rnd() - 0.5) * 80);
    const hist = generateHistory(this.rnd, rating);
    const user = await this.repos.users.create({ name, color: traits.color, face: traits.face, rating, games: hist.games, wins: hist.wins, createdAt: hist.createdAt, kind: 'persona', pwHash: null, salt: null });
    await this.repos.personas.insert({ _id: user._id, traits, tilt: 0, createdAt: Date.now() });
    await this.repos.matches.insertMany(generateRecentMatches(this.rnd, user, 6 + Math.floor(this.rnd() * 6)).map((m, i) => ({ _id: `${user._id}-h${i}`, ...m })));
    const st = this.stateFrom({ _id: user._id, traits, tilt: 0 }, user);
    this.personas.set(user._id, st);
    return st;
  }

  /**
   * Pick a persona for a slot. Reuses idle personas near the rating (preferring ones the humans have not met
   * recently, or ones that want a rematch); with 25% probability creates a fresh persona with history.
   */
  async pick(targetRating, { window = 150, exclude = new Set(), humans = [] } = {}) {
    this.stats.fills++;
    const now = Date.now();
    const candidates = [...this.personas.values()].filter(
      (p) => !p.busy && !exclude.has(p.id) && now > p.breakUntil && Math.abs(p.user.rating - targetRating) <= window,
    );
    let chosen = null;
    if (candidates.length && this.rnd() >= FRESH_PROBABILITY) {
      let best = Infinity;
      for (const p of candidates) {
        let score = Math.abs(p.user.rating - targetRating) / window;
        for (const h of humans) {
          const met = p.lastMet[h];
          if (met && now - met < 3 * 3600_000) score += 0.8 * (1 - (now - met) / (3 * 3600_000));
        }
        if (p.rematch && p.rematch.until > now && humans.some((h) => p.rematch.with.includes(h))) score -= 1.5;
        score += this.rnd() * 0.5;
        if (score < best) {
          best = score;
          chosen = p;
        }
      }
      this.stats.reused++;
    }
    if (!chosen) {
      chosen = await this.createFresh(targetRating);
      this.stats.fresh++;
    }
    chosen.busy = true;
    chosen.online = true;
    return chosen.id;
  }

  async refreshUser(id) {
    const p = this.personas.get(id);
    if (!p) return;
    const u = await this.repos.users.byId(id);
    if (u) p.user = u;
  }

  release(id, { rematchWith = [] } = {}) {
    const p = this.personas.get(id);
    if (!p) return;
    if (this.hub?.lobbies.lobbyOf(id)) return; // still sitting in a lobby (custom or ranked group)
    p.busy = false;
    if (rematchWith.length && this.rnd() < 0.35) {
      p.rematch = { with: rematchWith, until: Date.now() + 10 * 60_000 };
    } else if (this.rnd() < 0.5) {
      p.breakUntil = Date.now() + (20 + this.rnd() * 160) * 1000; // short break between matches
      if (this.rnd() < 0.3) p.online = false;
    }
  }

  controllerFor(id, map, seed) {
    const p = this.personas.get(id);
    const rating = p?.user.rating ?? 1000;
    const { brain } = this.pool.forRating(rating);
    const skill = skillFromRating(rating);
    const traits = { ...(p?.traits || {}), ...skill };
    return new BotController(map, id, brain, { traits, seed: seed ?? hashSeed(id + Date.now()), tilt: p?.tilt || 0 });
  }

  // ---------------- reactions ----------------

  say(id, event, send) {
    const p = this.personas.get(id);
    if (!p) return;
    const c = chatFor(event, p.traits, p.tilt, this.rnd);
    if (c) this.later(() => send(c.text), c.delayMs);
  }

  // Lobby joined: ready up after a human-ish delay, maybe greet.
  onLobbyJoin(id, { ready, chat }) {
    this.later(ready, 1200 + this.rnd() * 4000);
    this.say(id, 'lobbyJoin', chat);
  }

  // Invite from a human: accept sometimes (if online and idle) after a delay.
  onInvite(id, accept, decline) {
    const p = this.personas.get(id);
    if (!p) return;
    const yes = p.online && !p.busy && this.rnd() < 0.6;
    this.later(yes ? accept : decline, 2000 + this.rnd() * 7000);
  }

  onGameEvent(ev, session) {
    const chat = (from) => (text) => session.chat(from, text);
    if (ev.type === 'caught') {
      if (this.isPersona(ev.id)) this.say(ev.id, 'caughtMe', chat(ev.id));
      if (this.isPersona(ev.by)) this.say(ev.by, 'iCaught', chat(ev.by));
    } else if (ev.type === 'lastHider' && this.isPersona(ev.id)) {
      this.say(ev.id, 'lastHider', chat(ev.id));
    }
  }

  async onMatchEnd(session, results) {
    const humans = results.filter((r) => !this.isPersona(r.id)).map((r) => r.id);
    const now = Date.now();
    for (const r of results) {
      const p = this.personas.get(r.id);
      if (!p) continue;
      p.tilt = tiltAfter({ tilt: p.tilt, traits: p.traits, won: r.win, caughtEarly: r.caughtEarly });
      for (const h of humans) p.lastMet[h] = now;
      for (const [h, at] of Object.entries(p.lastMet)) if (now - at > 3 * 3600_000) delete p.lastMet[h];
      this.say(r.id, r.win ? 'won' : 'lost', (text) => session.chat(r.id, text, { afterEnd: true }));
      await this.repos.personas.update(r.id, { tilt: p.tilt, lastMet: p.lastMet });
      await this.refreshUser(r.id);
      this.later(() => this.release(r.id, { rematchWith: humans }), 3000 + this.rnd() * 5000);
    }
  }
}
