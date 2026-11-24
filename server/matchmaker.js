// Ranked queue: groups players by rating (window widens with waiting time) and fills
// with personas after a randomized wait so matches start even with few humans online.
// Queue entries are groups: a solo player is a group of one, a party (from a lobby) queues together and always
// ends up in the same match.
import { randomUUID } from 'node:crypto';

export const TARGET_PLAYERS = 8;
export const MAX_PLAYERS = 16;
export const MAX_PARTY = 4;

// Parties are matched a bit above their average, so a high-rated player can't drag low-rated friends into
// easy games (or the other way round).
export function partyRating(ratings) {
  const avg = ratings.reduce((a, r) => a + r, 0) / ratings.length;
  return Math.round((avg + Math.max(...ratings)) / 2);
}

export class Matchmaker {
  constructor(hub, { fillAfter = [15, 40] } = {}) {
    this.hub = hub;
    this.queue = new Map(); // entryId -> { id, members[], rating, joinedAt, fillAfter, lobbyId }
    this.byUser = new Map(); // userId -> entryId
    this.fillAfter = fillAfter;
    this.pending = new Set(); // matches being assembled
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[mm]', e)), 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  has(userId) {
    return this.byUser.has(userId);
  }

  entryOf(userId) {
    return this.queue.get(this.byUser.get(userId));
  }

  humansOf(entry) {
    return entry.members.filter((m) => !this.hub.personas.isPersona(m));
  }

  join(userId) {
    return this.joinGroup([userId]);
  }

  // members: user ids that queue together; lobbyId: the lobby the party came from (they return there afterwards).
  async joinGroup(members, { lobbyId = null } = {}) {
    if (!members.length || members.length > MAX_PARTY) return { error: `Ranked groups can have at most ${MAX_PARTY} players` };
    for (const m of members) this.leave(m, { silent: true });
    const users = await this.hub.repos.users.byIds(members);
    if (users.length !== members.length) return { error: 'Player not found' };
    for (const u of users) {
      if (this.hub.personas.isPersona(u._id)) continue;
      const leaves = await this.hub.repos.leavers.since(u._id, Date.now() - 24 * 3600_000);
      if (leaves.length >= 3) {
        const until = leaves[0].at + 10 * 60_000;
        if (until > Date.now()) {
          const min = Math.ceil((until - Date.now()) / 60000);
          return { error: members.length === 1 ? `You left too many ranked games. Queue cooldown: ${min} min` : `${u.name} left too many ranked games and can't queue for ${min} min` };
        }
      }
    }
    const [lo, hi] = this.fillAfter;
    const entry = {
      id: randomUUID(), members: [...members], lobbyId,
      rating: partyRating(users.map((u) => u.rating)),
      joinedAt: Date.now(), fillAfter: (lo + Math.random() * (hi - lo)) * 1000,
    };
    this.queue.set(entry.id, entry);
    for (const m of members) {
      this.byUser.set(m, entry.id);
      this.hub.presence.setQueue(m, true);
    }
    this.status(entry);
    return { ok: true, entry };
  }

  // Leaving cancels the search for the whole group.
  leave(userId, { silent = false } = {}) {
    const entry = this.entryOf(userId);
    if (!entry) return;
    this.queue.delete(entry.id);
    for (const m of entry.members) {
      this.byUser.delete(m);
      this.hub.presence.setQueue(m, false);
    }
    for (const h of this.humansOf(entry)) {
      this.hub.sendTo(h, { t: 'queue:status', state: 'idle' });
      if (!silent && h !== userId && entry.members.length > 1) {
        const name = this.hub.presence.get(userId)?.user.name;
        this.hub.sendTo(h, { t: 'toast', text: `${name || 'Someone'} stopped the search` });
      }
    }
    if (entry.lobbyId) this.hub.lobbies.onQueueChange(entry.lobbyId, false);
  }

  status(entry) {
    for (const h of this.humansOf(entry)) {
      this.hub.sendTo(h, { t: 'queue:status', state: 'searching', since: entry.joinedAt, party: entry.members.length });
    }
  }

  // Greedy: the longest-waiting group anchors a match and takes the closest-rated groups that still fit.
  async tick() {
    const entries = [...this.queue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const used = new Set();
    const now = Date.now();
    for (const e of entries) {
      if (used.has(e.id)) continue;
      const waited = now - e.joinedAt;
      const window = 100 + (15 * waited) / 1000;
      const candidates = entries
        .filter((o) => !used.has(o.id) && Math.abs(o.rating - e.rating) <= window)
        .sort((a, b) => (a === e ? -1 : b === e ? 1 : Math.abs(a.rating - e.rating) - Math.abs(b.rating - e.rating)));
      const group = [];
      let players = 0;
      for (const c of candidates) {
        if (players >= TARGET_PLAYERS) break;
        if (players + c.members.length > MAX_PLAYERS) continue;
        group.push(c);
        players += c.members.length;
      }
      if (players >= TARGET_PLAYERS || waited >= e.fillAfter) {
        for (const g of group) {
          used.add(g.id);
          this.queue.delete(g.id);
          for (const m of g.members) this.byUser.delete(m);
        }
        this.assemble(group).catch((err) => console.error('[mm] assemble', err));
      }
    }
    for (const e of this.queue.values()) this.status(e);
  }

  // Fill with personas that "join the queue" one by one, then start.
  async assemble(group) {
    const members = group.flatMap((g) => g.members);
    const humans = members.filter((m) => !this.hub.personas.isPersona(m));
    const users = await this.hub.repos.users.byIds(members);
    const avg = users.reduce((a, u) => a + u.rating, 0) / Math.max(1, users.length);
    const ids = [...members];
    const token = { humans };
    this.pending.add(token);
    const needed = Math.max(0, TARGET_PLAYERS - ids.length);
    const send = (extra) => {
      for (const h of humans) if (this.hub.presence.isOnline(h)) this.hub.sendTo(h, { t: 'queue:status', state: 'found', found: ids.length, needed: Math.max(TARGET_PLAYERS, ids.length), ...extra });
    };
    send({});
    for (let i = 0; i < needed; i++) {
      await sleep(400 + Math.random() * 1400);
      const id = await this.hub.personas.pick(avg, { window: 150 + i * 30, exclude: new Set(ids), humans });
      await this.hub.presence.ensurePersona(id);
      ids.push(id);
      send({});
    }
    // drop humans who disconnected meanwhile (they get no penalty: match didn't start)
    const alive = ids.filter((id) => this.hub.personas.isPersona(id) || this.hub.presence.isOnline(id));
    send({ state: 'starting', countdown: 3 });
    await sleep(3000);
    this.pending.delete(token);
    for (const m of members) this.hub.presence.setQueue(m, false);
    const parties = group.filter((g) => g.members.length > 1).map((g) => ({ members: g.members.filter((m) => alive.includes(m)), lobbyId: g.lobbyId }));
    await this.hub.startRanked(alive, { filled: needed > 0, parties });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
