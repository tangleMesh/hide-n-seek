// Ranked queue: groups players by rating (window widens with waiting time) and fills
// with personas after a randomized wait so matches start even with few humans online.
export const TARGET_PLAYERS = 8;
export const MAX_PLAYERS = 16;

export class Matchmaker {
  constructor(hub, { fillAfter = [15, 40] } = {}) {
    this.hub = hub;
    this.queue = new Map(); // userId -> { userId, rating, joinedAt, fillAfter }
    this.fillAfter = fillAfter;
    this.pending = new Set(); // matches being assembled
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[mm]', e)), 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  has(userId) {
    return this.queue.has(userId);
  }

  async join(userId) {
    const user = await this.hub.repos.users.byId(userId);
    const leaves = await this.hub.repos.leavers.since(userId, Date.now() - 24 * 3600_000);
    if (leaves.length >= 3) {
      const until = leaves[0].at + 10 * 60_000;
      if (until > Date.now()) return { error: `You left too many ranked games. Queue cooldown: ${Math.ceil((until - Date.now()) / 60000)} min` };
    }
    const [lo, hi] = this.fillAfter;
    this.queue.set(userId, { userId, rating: user.rating, joinedAt: Date.now(), fillAfter: (lo + Math.random() * (hi - lo)) * 1000 });
    this.hub.presence.setQueue(userId, true);
    this.status(userId);
    return { ok: true };
  }

  leave(userId) {
    if (!this.queue.delete(userId)) return;
    this.hub.presence.setQueue(userId, false);
    this.hub.sendTo(userId, { t: 'queue:status', state: 'idle' });
  }

  status(userId, extra = {}) {
    const e = this.queue.get(userId);
    if (!e) return;
    this.hub.sendTo(userId, { t: 'queue:status', state: 'searching', since: e.joinedAt, inQueue: this.queue.size, ...extra });
  }

  async tick() {
    const entries = [...this.queue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const used = new Set();
    const now = Date.now();
    for (const e of entries) {
      if (used.has(e.userId)) continue;
      const waited = now - e.joinedAt;
      const window = 100 + (15 * waited) / 1000;
      const group = entries
        .filter((o) => !used.has(o.userId) && Math.abs(o.rating - e.rating) <= window)
        .sort((a, b) => Math.abs(a.rating - e.rating) - Math.abs(b.rating - e.rating))
        .slice(0, MAX_PLAYERS);
      if (group.length >= TARGET_PLAYERS || waited >= e.fillAfter) {
        for (const g of group) {
          used.add(g.userId);
          this.queue.delete(g.userId);
        }
        this.assemble(group).catch((err) => console.error('[mm] assemble', err));
      }
    }
    for (const e of this.queue.values()) this.status(e.userId);
  }

  // Fill with personas that "join the queue" one by one, then start.
  async assemble(group) {
    const humans = group.map((g) => g.userId);
    const avg = group.reduce((a, g) => a + g.rating, 0) / group.length;
    const ids = [...humans];
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
    for (const h of humans) this.hub.presence.setQueue(h, false);
    await this.hub.startRanked(alive, { filled: needed > 0 });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
