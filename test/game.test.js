import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameMap } from '../shared/map.js';
import { Game } from '../server/game.js';
import { canSee, observe } from '../server/observe.js';
import { loadMap } from '../server/maps.js';
import { HEARTBEAT, PAD_RESPAWN } from '../shared/constants.js';

// Small test arena: a wall in the middle, a bush and a lamp.
function arena() {
  const rows = [
    '##########',
    '#........#',
    '#....#...#',
    '#....#...#',
    '#.*......#',
    '#........#',
    '##########',
  ];
  return new GameMap({
    id: 'arena', name: 'Arena', rows,
    lamps: [{ x: 8, y: 1.5, r: 1 }],
    pads: [{ id: 'p1', x: 1.5, y: 1.5, item: 'decoy' }, { id: 'p2', x: 8.5, y: 5.5, item: 'flare' }],
    spawns: { seekers: [{ x: 1.5, y: 5.5 }], hiders: [{ x: 3.5, y: 5.5 }, { x: 7.5, y: 3.5 }] },
  });
}

function place(game, id, x, y, aim) {
  const p = game.state.players[id];
  p.x = x;
  p.y = y;
  p.anchorX = x;
  p.anchorY = y;
  if (aim !== undefined) p.aim = aim;
}

const newGame = (opts = {}) => new Game(arena(), { id: 't', playerIds: ['s', 'h1', 'h2'], seekerIds: ['s'], roundSeconds: 60, headstart: 1, ...opts });
const run = (g, seconds) => { for (let i = 0; i < seconds * 20; i++) g.step(); };

test('walls block line of sight, cone vision works, bushes hide', () => {
  const g = newGame();
  run(g, 1.1); // past headstart
  place(g, 's', 3.5, 2.5, 0); // facing east towards the wall
  place(g, 'h1', 7.5, 2.5); // behind the wall
  assert.equal(canSee(g, g.state.players.s, g.state.players.h1), false);
  place(g, 'h1', 4.5, 2.5); // in front of the wall, inside the cone
  assert.equal(canSee(g, g.state.players.s, g.state.players.h1), true);
  place(g, 's', 2.0, 2.5, Math.PI); // facing away (and outside the 1.5 tile ambient radius)
  assert.equal(canSee(g, g.state.players.s, g.state.players.h1), false);
  place(g, 's', 4.6, 4.5, Math.PI); // facing the bush at (2,4)
  place(g, 'h1', 2.5, 4.5);
  assert.equal(canSee(g, g.state.players.s, g.state.players.h1), false, 'hider inside a bush is hidden from afar');
  place(g, 's', 3.6, 4.5, Math.PI);
  assert.equal(canSee(g, g.state.players.s, g.state.players.h1), true, 'but visible right next to it');
});

test('seekers are blind during the head start', () => {
  const g = newGame({ headstart: 5 });
  g.step();
  place(g, 's', 3.5, 2.5, 0);
  place(g, 'h1', 4.5, 2.5);
  assert.equal(canSee(g, g.state.players.s, g.state.players.h1), false);
  assert.equal(observe(g, 's').players.some((p) => p.id === 'h1'), false);
});

test('touching a hider converts them to a seeker; all caught → seekers win', () => {
  const g = newGame();
  run(g, 1.1);
  place(g, 's', 3.5, 5.5);
  place(g, 'h1', 3.9, 5.5);
  g.step();
  assert.equal(g.state.players.h1.role, 'seeker');
  assert.equal(g.state.players.s.catches, 1);
  place(g, 'h2', 4.2, 5.5); // touched by the new Shade
  g.step();
  assert.equal(g.state.phase, 'ended');
  assert.equal(g.state.winner, 'seekers');
  const sc = g.scores();
  assert.equal(sc.s, 1);
  assert.ok(sc.h1 > 0 && sc.h1 < 0.6);
});

test('timer running out → hiders win', () => {
  const g = newGame({ roundSeconds: 2 });
  run(g, 3.2);
  assert.equal(g.state.winner, 'hiders');
  assert.equal(g.scores().h1, 1);
});

test('standing still makes the heartbeat pulse; moving resets it', () => {
  const g = newGame({ roundSeconds: 200 });
  run(g, 1.1);
  place(g, 'h2', 7.5, 3.5);
  place(g, 's', 1.5, 1.5);
  run(g, HEARTBEAT.stillAfter + 0.5);
  const beats = g.state.ripples.filter((r) => r.kind === 'heart' && r.by === 'h2');
  assert.ok(beats.length >= 1, 'heartbeat ripple after standing still');
  assert.equal(observe(g, 's').ripples.some((r) => r.kind === 'heart'), true, 'seekers see heartbeats');
  assert.equal(observe(g, 'h1').ripples.some((r) => r.kind === 'heart' && r.x === 7.5), false, "other hiders do not see h2's heartbeat");
  assert.equal(observe(g, 'h2').ripples.some((r) => r.kind === 'heart' && r.x === 7.5), true, 'you notice your own heartbeat');
  g.state.players.h2.x = 3.5; // moved far away (anchor stays where it was)
  g.state.players.h2.y = 1.5;
  run(g, 0.5);
  assert.equal(g.state.players.h2.stillTime < 1, true, 'moving resets the still timer');
});

test('sneaking is silent, sprinting is loud', () => {
  const g = newGame({ roundSeconds: 200 });
  run(g, 1.1);
  g.state.ripples = [];
  g.setInput('h1', { dx: 1, dy: 0, mode: 'sneak' });
  run(g, 1);
  assert.equal(g.state.ripples.filter((r) => r.by === 'h1').length, 0);
  g.setInput('h1', { dx: -1, dy: 0, mode: 'sprint' });
  run(g, 1);
  const loud = g.state.ripples.filter((r) => r.by === 'h1');
  assert.ok(loud.length >= 1 && loud[0].r >= 5);
});

test('item pads: pickup, use, fixed respawn timer', () => {
  const g = newGame();
  run(g, 1.1);
  place(g, 'h1', 1.5, 1.5);
  g.step();
  assert.equal(g.state.players.h1.item, 'decoy');
  assert.equal(Math.ceil(g.state.pads[0].readyIn), PAD_RESPAWN);
  g.queueAction('h1', { type: 'use', x: 5, y: 5 });
  run(g, 1.5);
  assert.equal(g.state.players.h1.item, null);
  assert.ok(g.state.ripples.some((r) => r.src === 'hider' && r.by === null), 'decoy ripples');
  // seekers cannot take hider items
  place(g, 's', 8.5, 5.5);
  g.step();
  assert.equal(g.state.players.s.item, 'flare');
});

test('serialize → fromSnapshot continues identically (deterministic)', () => {
  const map = loadMap('manor');
  const ids = ['a', 'b', 'c', 'd'];
  const g1 = new Game(map, { id: 'x', playerIds: ids, seekerIds: ['a'], roundSeconds: 60, headstart: 2 });
  const drive = (g, i) => ids.forEach((id, k) => g.setInput(id, { dx: Math.cos(i / 9 + k), dy: Math.sin(i / 13 + k), mode: i % 60 < 30 ? 'walk' : 'sprint', aim: i / 10 }));
  for (let i = 0; i < 200; i++) { drive(g1, i); g1.step(); }
  const g2 = Game.fromSnapshot(map, JSON.parse(JSON.stringify(g1.serialize())));
  for (let i = 200; i < 500; i++) { drive(g1, i); g1.step(); drive(g2, i); g2.step(); }
  assert.deepEqual(g2.serialize(), g1.serialize());
});

test('sneaking drains stamina: nobody can creep forever', () => {
  const g = newGame({ roundSeconds: 200 });
  run(g, 1.1);
  g.setInput('h1', { dx: 0.3, dy: 0, mode: 'sneak' });
  let walked = false;
  for (let i = 0; i < 20 * 20; i++) {
    g.step();
    if (g.state.players.h1.mode === 'walk') walked = true;
    if (g.state.players.h1.x > 7.5) g.setInput('h1', { dx: -0.3, dy: 0, mode: 'sneak' });
    if (g.state.players.h1.x < 2.5) g.setInput('h1', { dx: 0.3, dy: 0, mode: 'sneak' });
  }
  assert.ok(walked, 'after the stamina runs out the player is forced to walk');
});
