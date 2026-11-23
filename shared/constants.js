// Shared game constants (imported by server, bots and browser client).
// All distances are in tiles, all times in seconds.

export const TICK_RATE = 20;
export const DT = 1 / TICK_RATE;

export const ROUND_SECONDS = 300;
export const HEADSTART_SECONDS = 30;
export const FINAL_HUSH_SECONDS = 60;

export const PLAYER_RADIUS = 0.35;
export const CATCH_DISTANCE = 0.85;

export const SPEED = { sneak: 1.75, walk: 3.2, sprint: 4.8 };
// Sprinting drains stamina fast, sneaking drains it slowly (so nobody can creep forever); walking/standing regenerate.
export const STAMINA = { max: 100, drain: 28, sneakDrain: 9, regen: 14, walkRegen: 7, minToSprint: 15, minToSneak: 10 };

// Noise loudness (ripple radius in tiles) per movement mode, before floor modifiers.
export const NOISE_BASE = { sneak: 0, walk: 1.9, sprint: 5.5 };
export const NOISE_INTERVAL = 0.9; // a moving player emits at most one ripple per interval
export const NOISE_MIN = 1.4; // ripples smaller than this are not emitted
export const RIPPLE_TTL = 1.4;

export const HEARTBEAT = {
  stillAfter: 20, // seconds near the same spot before pulses start
  anchorRadius: 2, // moving further than this resets the anchor
  interval: 5,
  radius: 3.5,
  finalInterval: 10,
  finalRadius: 5,
};

export const VISION = {
  coneHalfAngle: (35 * Math.PI) / 180,
  wideHalfAngle: (70 * Math.PI) / 180,
  coneRange: 9,
  ambient: 1.5, // everyone sees right next to them, even into bushes
  hiderRadius: 4.5,
  seekerGlow: 8, // hiders notice flashlight carriers up to this distance (LOS)
  lightRange: 14, // seekers see hiders standing in lit areas up to this distance (LOS)
};

export const ITEM_PICKUP_RADIUS = 0.8;

export const ITEMS = {
  decoy: { side: 'hider', icon: '👣', name: 'Decoy', desc: 'Fake noise ripples where you aim', range: 9 },
  smoke: { side: 'hider', icon: '💨', name: 'Smoke', desc: 'Cloud that blocks flashlights (6s)', range: 4, radius: 2.5, duration: 6 },
  softshoes: { side: 'hider', icon: '🥿', name: 'Soft shoes', desc: 'Silent sprint for 5s', duration: 5 },
  calm: { side: 'hider', icon: '💤', name: 'Calm', desc: 'Resets & hides your heartbeat (20s)', duration: 20 },
  flare: { side: 'seeker', icon: '🔥', name: 'Flare', desc: 'Lights up an area (4s)', range: 10, radius: 5, duration: 4 },
  trap: { side: 'seeker', icon: '🪤', name: 'Noise trap', desc: 'Hidden mine: loud ripple + slow', lifetime: 90, radius: 0.7 },
  widebeam: { side: 'seeker', icon: '🔦', name: 'Wide beam', desc: '140° flashlight for 8s', duration: 8 },
  echo: { side: 'seeker', icon: '📡', name: 'Echo', desc: 'Reveal heartbeats nearby (1s)', radius: 12, duration: 1.2 },
};
export const ITEM_KEYS = Object.keys(ITEMS);
export const PAD_RESPAWN = 35;

export const MARKER_TTL = 6;

export const QUICK_CHAT = ['gg', 'nooo', 'how??', 'nice one', 'camper!', 'lag…', 'one more!', 'gl hf', '😤', '😂', '👀', '🫣'];

export const COLORS = [
  '#ff6b6b', '#ffa94d', '#ffd43b', '#a9e34b', '#69db7c', '#38d9a9', '#3bc9db', '#4dabf7',
  '#748ffc', '#9775fa', '#da77f2', '#f783ac', '#e8590c', '#2b8a3e', '#1971c2', '#c2255c',
];

// Number of starting seekers for a given player count.
export function startingSeekers(n) {
  return n >= 12 ? 2 : 1;
}
