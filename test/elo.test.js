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
