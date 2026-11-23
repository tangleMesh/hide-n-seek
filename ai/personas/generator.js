// Generates believable player identities, personalities and backfilled history for personas.
import { COLORS } from '../../shared/constants.js';

const ADJ = ['mossy', 'quiet', 'sly', 'lazy', 'tiny', 'crispy', 'salty', 'sneaky', 'grumpy', 'fuzzy', 'dusty', 'shy', 'wild', 'sleepy', 'lucky', 'frosty', 'brave', 'odd', 'swift', 'cosmic', 'velvet', 'night', 'blue', 'mild', 'loud'];
const NOUN = ['fox', 'owl', 'moth', 'otter', 'badger', 'ghost', 'panda', 'toast', 'pickle', 'noodle', 'raven', 'bean', 'hedgehog', 'shadow', 'lynx', 'cat', 'koala', 'wombat', 'gecko', 'mango', 'pebble', 'cloud', 'squid', 'wolf', 'muffin'];
const FIRST = ['leo', 'mia', 'jonas', 'emma', 'finn', 'lena', 'noah', 'sara', 'max', 'lina', 'ben', 'nora', 'tom', 'ida', 'paul', 'zoe', 'luca', 'ella', 'nils', 'maja', 'jan', 'tim', 'anna', 'ole', 'kim', 'alex', 'sam', 'robin', 'eli', 'yuki', 'omar', 'aria', 'mateo', 'ivy', 'kai'];
const WORDS = ['hush', 'shade', 'lurker', 'seeker', 'hider', 'ninja', 'gamer', 'player', 'pro', 'tryhard', 'casual', 'boss', 'main', 'enjoyer'];
const TACTICS = ['camper', 'roamer', 'item-controller', 'decoy-trickster', 'sweeper', 'flanker'];

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function generateName(rnd) {
  const style = rnd();
  let n;
  if (style < 0.25) n = pick(rnd, ADJ) + pick(rnd, NOUN);
  else if (style < 0.45) n = cap(pick(rnd, FIRST)) + (rnd() < 0.5 ? '_' : '') + Math.floor(rnd() * 99 + 1);
  else if (style < 0.55) n = 'xX' + pick(rnd, NOUN) + pick(rnd, ['', 'z', 'y']) + 'Xx';
  else if (style < 0.7) n = pick(rnd, FIRST) + '.' + pick(rnd, NOUN);
  else if (style < 0.82) n = cap(pick(rnd, ADJ)) + cap(pick(rnd, NOUN)) + (rnd() < 0.4 ? Math.floor(rnd() * 9) : '');
  else if (style < 0.92) n = pick(rnd, NOUN) + pick(rnd, WORDS) + (rnd() < 0.3 ? '_' : '');
  else n = pick(rnd, FIRST) + pick(rnd, FIRST).slice(0, 2) + Math.floor(1990 + rnd() * 20);
  if (rnd() < 0.15) n = n.toLowerCase();
  n = n.replace(/[^A-Za-z0-9_.-]/g, '');
  if (n.length > 16) n = n.slice(0, 16);
  if (n.length < 3) n += Math.floor(rnd() * 900 + 100);
  return n;
}

export function generateTraits(rnd, map) {
  const zones = map ? [{ x: map.w * 0.25, y: map.h * 0.25 }, { x: map.w * 0.75, y: map.h * 0.25 }, { x: map.w * 0.5, y: map.h * 0.5 }, { x: map.w * 0.25, y: map.h * 0.75 }, { x: map.w * 0.75, y: map.h * 0.75 }, null] : [null];
  return {
    aggression: +rnd().toFixed(2),
    patience: +rnd().toFixed(2),
    risk: +rnd().toFixed(2),
    tactic: pick(rnd, TACTICS),
    sprintHabit: +(rnd() * 0.8).toFixed(2),
    itemFocus: +rnd().toFixed(2),
    zone: pick(rnd, zones),
    tiltSensitivity: +(rnd() * 0.8).toFixed(2),
    chattiness: +(rnd() ** 1.5).toFixed(2),
    pingBase: Math.round(18 + rnd() ** 2 * 100),
    color: pick(rnd, COLORS),
  };
}

// Plausible past record for a fresh persona around a target rating.
export function generateHistory(rnd, rating) {
  const games = Math.round(8 + rnd() * 140 + Math.max(0, rating - 1000) / 8);
  const winRate = Math.max(0.2, Math.min(0.75, 0.45 + (rating - 1000) / 2000 + (rnd() - 0.5) * 0.1));
  const wins = Math.round(games * winRate);
  const ageDays = 3 + rnd() * 200 + games / 4;
  return { games, wins, createdAt: Date.now() - Math.round(ageDays * 86400_000) };
}

// Compact synthetic recent matches (only the persona's own line, which is all a profile shows).
export function generateRecentMatches(rnd, user, n = 10) {
  const out = [];
  let at = Date.now() - Math.round((0.2 + rnd() * 3) * 86400_000);
  let rating = user.rating;
  const winRate = user.games ? user.wins / user.games : 0.5;
  for (let i = 0; i < n; i++) {
    const startRole = rnd() < 0.15 ? 'seeker' : 'hider';
    const win = rnd() < winRate;
    const delta = Math.round((win ? 1 : -1) * (6 + rnd() * 16));
    rating -= delta;
    out.push({
      ranked: true,
      synthetic: true,
      at,
      mapId: 'manor',
      winner: win === (startRole === 'seeker') ? 'seekers' : 'hiders',
      userIds: [user._id],
      players: [{ userId: user._id, name: user.name, startRole, caught: startRole === 'hider' && !win, delta, ratingBefore: rating }],
    });
    at -= Math.round((0.01 + rnd() * 0.4) * 86400_000);
  }
  return out;
}
