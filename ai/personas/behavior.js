// Personality-driven reactions: tilt, quick-chat and emotes. Only fixed QUICK_CHAT phrases are used.

const CHAT = {
  lobbyJoin: ['gl hf', 'gl hf', '👀'],
  caughtMe: ['nooo', 'how??', '😤', 'lag…', 'nooo', '🫣'],
  caughtMeTilted: ['how??', '😤', 'camper!', 'lag…'],
  iCaught: ['😂', '👀', 'nice one'],
  lastHider: ['👀', '🫣', 'nice one'],
  won: ['gg', 'gg', '😂', 'one more!'],
  lost: ['gg', 'gg', 'one more!', 'nooo'],
  lostTilted: ['😤', 'camper!', 'one more!', 'how??'],
};

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// Returns { text, delayMs } or null.
export function chatFor(event, traits, tilt, rnd) {
  const talk = traits.chattiness * (0.6 + tilt);
  const chance = {
    lobbyJoin: 0.35, caughtMe: 0.55, iCaught: 0.3, lastHider: 0.25, won: 0.7, lost: 0.6,
  }[event] ?? 0.2;
  if (rnd() > Math.min(0.95, chance * (0.3 + talk * 1.4))) return null;
  let pool = CHAT[event];
  if (tilt > 0.5 && CHAT[event + 'Tilted']) pool = CHAT[event + 'Tilted'];
  return { text: pick(rnd, pool), delayMs: 600 + rnd() * 2500 };
}

// Tilt rises with early catches/losing streaks, decays with wins and over games.
export function tiltAfter({ tilt = 0, traits, won, caughtEarly }) {
  let t = tilt * 0.75;
  if (!won) t += 0.15 * (0.5 + traits.tiltSensitivity);
  if (caughtEarly) t += 0.2 * (0.5 + traits.tiltSensitivity);
  if (won) t -= 0.15;
  return Math.max(0, Math.min(1, +t.toFixed(3)));
}
