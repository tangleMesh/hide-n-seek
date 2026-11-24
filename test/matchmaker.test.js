import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matchmaker, partyRating, MAX_PARTY } from '../server/matchmaker.js';

function fakeHub(ratings) {
  const started = [];
  const hub = {
    started,
    repos: {
      users: { byIds: async (ids) => ids.map((id) => ({ _id: id, name: id, rating: ratings[id] ?? 1000 })) },
      leavers: { since: async () => [] },
    },
    presence: { setQueue() {}, get: (id) => ({ user: { name: id } }), isOnline: () => true, ensurePersona: async () => {} },
    personas: { isPersona: (id) => id.startsWith('bot'), pick: async () => 'bot' + Math.random().toString(36).slice(2) },
    lobbies: { onQueueChange() {} },
    sendTo() {},
    startRanked: async (ids, opts) => started.push({ ids, ...opts }),
  };
  return hub;
}

test('party rating sits between the average and the best player', () => {
  assert.equal(partyRating([1000]), 1000);
  assert.equal(partyRating([1000, 1400]), 1300);
});

test('a group queues as one unit and lands in the same match with solo players', async () => {
  const hub = fakeHub({});
  const mm = new Matchmaker(hub, { fillAfter: [0, 0] });
  mm.stop();
  await mm.joinGroup(['a', 'b', 'c'], { lobbyId: 'L1' });
  for (const s of ['s1', 's2', 's3', 's4', 's5']) await mm.join(s);
  assert.ok(mm.has('b'));
  await mm.tick();
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(hub.started.length, 1);
  const m = hub.started[0];
  for (const id of ['a', 'b', 'c', 's1', 's5']) assert.ok(m.ids.includes(id));
  assert.deepEqual(m.parties, [{ members: ['a', 'b', 'c'], lobbyId: 'L1' }]);
});

test('leaving cancels the search for the whole group; groups are capped', async () => {
  const hub = fakeHub({});
  const mm = new Matchmaker(hub, { fillAfter: [60, 60] });
  mm.stop();
  await mm.joinGroup(['a', 'b'], { lobbyId: 'L1' });
  mm.leave('b');
  assert.ok(!mm.has('a') && !mm.has('b'));
  const r = await mm.joinGroup(Array.from({ length: MAX_PARTY + 1 }, (_, i) => 'p' + i));
  assert.match(r.error, /at most/);
});

test('a group is never split across matches', async () => {
  const hub = fakeHub({});
  const mm = new Matchmaker(hub, { fillAfter: [0, 0] });
  mm.stop();
  // 7 solos first, then a group of 4: 7 + 4 > 8 but <= 16, so the group joins the same match whole
  for (let i = 0; i < 7; i++) await mm.join('s' + i);
  await mm.joinGroup(['a', 'b', 'c', 'd'], { lobbyId: 'L' });
  await mm.tick();
  await new Promise((r) => setTimeout(r, 3500));
  const withGroup = hub.started.filter((m) => m.ids.includes('a'));
  assert.equal(withGroup.length, 1);
  for (const id of ['b', 'c', 'd']) assert.ok(withGroup[0].ids.includes(id));
});
