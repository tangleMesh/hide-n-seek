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

// how: what pressing E does; tip: when it's worth using. aim: the item goes where the mouse points (within range).
export const ITEMS = {
  decoy: {
    side: 'hider', icon: '👣', name: 'Decoy', desc: 'Fake noise ripples where you aim', range: 9, aim: true,
    how: 'Aim with the mouse and press E: three fake footsteps appear there (up to 9 tiles away).',
    tip: 'Throw it away from where you are going, to pull seekers off your trail.',
  },
  smoke: {
    side: 'hider', icon: '💨', name: 'Smoke', desc: 'Cloud that blocks flashlights (6s)', range: 4, radius: 2.5, duration: 6, aim: true,
    how: 'Aim and press E: a smoke cloud (up to 4 tiles away) blocks flashlights and sight for 6 s.',
    tip: 'Drop it between you and a seeker, then slip away.',
  },
  softshoes: {
    side: 'hider', icon: '🥿', name: 'Soft shoes', desc: 'Silent sprint for 5s', duration: 5,
    how: 'Press E: for 5 s your steps make no noise, even when sprinting.',
    tip: 'Save it for crossing gravel, water or open ground.',
  },
  calm: {
    side: 'hider', icon: '💤', name: 'Calm', desc: 'Resets & hides your heartbeat (20s)', duration: 20,
    how: 'Press E: your heartbeat resets and stays hidden for 20 s (Echo can\'t find you either).',
    tip: 'Use it to stay in a great hiding spot a bit longer, or during the Final Hush.',
  },
  flare: {
    side: 'seeker', icon: '🔥', name: 'Flare', desc: 'Lights up an area (4s)', range: 10, radius: 5, duration: 4, aim: true,
    how: 'Aim and press E: lights up an area (up to 10 tiles away) for 4 s. Every hider in the light is visible.',
    tip: 'Throw it where you just saw ripples.',
  },
  trap: {
    side: 'seeker', icon: '🪤', name: 'Noise trap', desc: 'Hidden mine: loud ripple + slow', lifetime: 90, radius: 0.7,
    how: 'Press E to drop it where you stand. Hiders can\'t see it: the first one to step on it makes a loud ripple and is slowed.',
    tip: 'Place it in doorways and narrow paths. It lasts 90 s.',
  },
  widebeam: {
    side: 'seeker', icon: '🔦', name: 'Wide beam', desc: '140° flashlight for 8s', duration: 8,
    how: 'Press E: your flashlight widens to 140° for 8 s.',
    tip: 'Great for sweeping big rooms or the garden.',
  },
  echo: {
    side: 'seeker', icon: '📡', name: 'Echo', desc: 'Reveal heartbeats nearby (1s)', radius: 12, duration: 1.2,
    how: 'Press E: briefly shows every hider\'s heartbeat within 12 tiles. Hiders using Calm stay hidden, and hiders see the pulse.',
    tip: 'Use it in the middle of an area where you think someone is hiding.',
  },
};
export const ITEM_KEYS = Object.keys(ITEMS);
export const PAD_RESPAWN = 35;

// Ranked: the last LATE_CATCH_COUNT hiders to be caught get a small plus, if they were caught within the
// last LATE_CATCH_WINDOW seconds of the round. Every other caught hider loses points (less the later).
export const LATE_CATCH_COUNT = 2;
export const LATE_CATCH_WINDOW = 120;

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
