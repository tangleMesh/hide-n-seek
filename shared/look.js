// Player looks: a color (unique within a lobby/game) and a hand-drawn face (any number of players may share one).
import { COLORS } from './constants.js';

export const FACES = ['happy', 'grin', 'wink', 'cool', 'love', 'silly', 'shock', 'nervous', 'sleepy', 'meh', 'sad', 'angry', 'mad', 'evil', 'dizzy', 'smug'];

export const isColor = (c) => COLORS.includes(c);
export const isFace = (f) => FACES.includes(f);

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Accounts from before faces existed get a stable face derived from their id.
export const defaultFace = (id) => FACES[hash(String(id)) % FACES.length];

// Gives every player a distinct color. Players are considered in the given order: whoever comes first keeps
// their color, a later player with the same color gets a free one (picked deterministically per player, so the
// lobby and the game that starts from it agree). Players whose own color is still free always keep it.
// list: [{ id, color }] → Map id → color
export function uniqueColors(list) {
  const used = new Set();
  const out = new Map();
  const bumped = [];
  for (const p of list) {
    if (isColor(p.color) && !used.has(p.color)) {
      used.add(p.color);
      out.set(p.id, p.color);
    } else bumped.push(p);
  }
  for (const p of bumped) {
    const start = hash(String(p.id)) % COLORS.length;
    let color = null;
    for (let k = 0; k < COLORS.length && !color; k++) {
      const c = COLORS[(start + k) % COLORS.length];
      if (!used.has(c)) color = c;
    }
    color ??= p.color ?? COLORS[start];
    used.add(color);
    out.set(p.id, color);
  }
  return out;
}
