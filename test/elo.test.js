import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expected, ratingChanges, kFactor } from '../server/elo.js';

test('expected score is symmetric and 0.5 for equal ratings', () => {
  assert.equal(expected(1000, 1000), 0.5);
  assert.ok(Math.abs(expected(1200, 1000) + expected(1000, 1200) - 1) < 1e-12);
});

test('K factor is higher for new players', () => {
  assert.equal(kFactor(0), 40);
  assert.equal(kFactor(50), 24);
});

test('winners gain and losers lose, against the other side average', () => {
  const d = ratingChanges([
    { id: 's', rating: 1000, games: 20, startRole: 'seeker', score: 1 },
    { id: 'h1', rating: 1000, games: 20, startRole: 'hider', score: 0.1 },
    { id: 'h2', rating: 1000, games: 20, startRole: 'hider', score: 0.2 },
  ]);
  assert.ok(d.s > 0);
  assert.ok(d.h1 < 0 && d.h2 < 0);
  assert.ok(d.h2 > d.h1, 'surviving longer loses less');
});

test('beating a stronger side gives more points', () => {
  const vsWeak = ratingChanges([{ id: 'a', rating: 1000, games: 20, startRole: 'hider', score: 1 }, { id: 'b', rating: 800, games: 20, startRole: 'seeker', score: 0 }]);
  const vsStrong = ratingChanges([{ id: 'a', rating: 1000, games: 20, startRole: 'hider', score: 1 }, { id: 'b', rating: 1300, games: 20, startRole: 'seeker', score: 0 }]);
  assert.ok(vsStrong.a > vsWeak.a);
});

test('caught hiders: the later caught, the less minus; the last two caught late get a small plus', async () => {
  const { Game } = await import('../server/game.js');
  const { loadMap } = await import('../server/maps.js');
  const map = loadMap('manor');
  const g = new Game(map, { id: 't', playerIds: ['s', 'a', 'b', 'c', 'd', 'e'], seekerIds: ['s'], roundSeconds: 300, headstart: 30 });
  const end = 330;
  const P = g.state.players;
  P.a.caughtAt = 60; // early
  P.b.caughtAt = 150; // mid
  P.c.caughtAt = end - 130; // third to last caught, and not within the last 2 minutes
  P.d.caughtAt = end - 90; // second to last, within the last 2 minutes
  P.e.caughtAt = end - 20; // caught last
  const sc = g.scores();
  const info = g.catchInfo();
  assert.equal(info.e.lateRank, 1);
  assert.equal(info.d.lateRank, 2);
  assert.equal(info.c.lateRank, 0);
  const players = Object.keys(P).map((id) => ({ id, rating: 1000, games: 20, startRole: P[id].startRole, score: sc[id], caught: !!info[id], lateRank: info[id]?.lateRank || 0 }));
  const d = ratingChanges(players);
  assert.ok(d.a < d.b && d.b < d.c && d.c < 0, `later caught loses less (${d.a}, ${d.b}, ${d.c})`);
  assert.ok(d.d > 0 && d.e > d.d, `last two caught get a small plus (${d.d}, ${d.e})`);
  assert.ok(d.e <= 6, 'the plus stays small');
});

test('the second-to-last caught gets no plus when caught before the last 2 minutes; caught hiders never gain otherwise', async () => {
  const { Game } = await import('../server/game.js');
  const { loadMap } = await import('../server/maps.js');
  const g = new Game(loadMap('manor'), { id: 't', playerIds: ['s', 'a', 'b', 'c'], seekerIds: ['s'], roundSeconds: 300, headstart: 30 });
  const P = g.state.players;
  P.a.caughtAt = 100;
  P.b.caughtAt = 180; // second to last, but 150 s before the end
  P.b.catches = 5; // lots of catches as a Shade still can't turn it into a plus
  P.c.caughtAt = 320;
  const sc = g.scores();
  const info = g.catchInfo();
  assert.equal(info.b.lateRank, 0);
  const d = ratingChanges(Object.keys(P).map((id) => ({ id, rating: 1000, games: 20, startRole: P[id].startRole, score: sc[id], caught: !!info[id], lateRank: info[id]?.lateRank || 0 })));
  assert.ok(d.b < 0, `no plus outside the late window (${d.b})`);
  assert.ok(d.c > 0);
});
