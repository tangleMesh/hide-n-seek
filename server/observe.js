// Builds the per-player filtered view of the game. Used for network snapshots AND bot observations,
// so bots never see more than a human would.
import { VISION, HEARTBEAT } from '../shared/constants.js';

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

// Does the segment a→b pass through any smoke cloud?
function smokeBlocks(smokes, ax, ay, bx, by) {
  for (const s of smokes) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((s.x - ax) * dx + (s.y - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    if ((px - s.x) ** 2 + (py - s.y) ** 2 <= s.r * s.r) return true;
  }
  return false;
}

export function canSee(game, viewer, target) {
  if (viewer.id === target.id) return true;
  const map = game.map;
  const s = game.state;
  const d2 = (viewer.x - target.x) ** 2 + (viewer.y - target.y) ** 2;
  if (viewer.role === 'seeker') {
    if (target.role === 'seeker') return true; // team awareness
    if (s.phase === 'headstart') return false; // blindfolded
    if (d2 <= VISION.ambient ** 2 && map.los(viewer.x, viewer.y, target.x, target.y)) return true;
    const losFull = () =>
      map.los(viewer.x, viewer.y, target.x, target.y, { bushes: true }) &&
      !smokeBlocks(s.smokes, viewer.x, viewer.y, target.x, target.y);
    const half = viewer.wideLeft > 0 ? VISION.wideHalfAngle : VISION.coneHalfAngle;
    if (d2 <= VISION.coneRange ** 2) {
      const a = Math.atan2(target.y - viewer.y, target.x - viewer.x);
      if (angleDiff(a, viewer.aim) <= half && losFull()) return true;
    }
    if (d2 <= VISION.lightRange ** 2 && map.isLit(target.x, target.y, s.flares) && !map.tileAtPos(target.x, target.y).bush) {
      if (losFull()) return true;
    }
    return false;
  }
  // viewer is a hider
  if (target.role === 'seeker') {
    if (d2 <= VISION.seekerGlow ** 2 && map.los(viewer.x, viewer.y, target.x, target.y)) return true;
    return false;
  }
  return d2 <= VISION.hiderRadius ** 2 && map.los(viewer.x, viewer.y, target.x, target.y, { bushes: !map.tileAtPos(viewer.x, viewer.y).bush });
}

// Heartbeat intensity for hiders: 0 (calm) .. 1 (seeker right next to you). Gives a warning, not a position.
export function heartLevel(game, p) {
  let best = Infinity;
  for (const k of game.seekers()) best = Math.min(best, Math.hypot(k.x - p.x, k.y - p.y));
  if (!Number.isFinite(best)) return 0;
  return Math.max(0, Math.min(1, 1 - (best - 2) / 14));
}

export function rippleVisibleTo(r, viewer) {
  if (r.by === viewer.id) return true;
  if (viewer.role === 'seeker') return r.src === 'hider' || r.kind === 'echo';
  return r.src === 'seeker' && (r.r >= 4 || r.kind === 'door' || r.kind === 'echo');
}

export function observe(game, id) {
  const s = game.state;
  const me = s.players[id];
  if (!me) return null;
  const players = [];
  for (const p of Object.values(s.players)) {
    if (p.id === id) continue;
    if (!canSee(game, me, p)) continue;
    players.push({ id: p.id, x: round(p.x), y: round(p.y), aim: round(p.aim), role: p.role, mode: p.mode, wide: p.wideLeft > 0 });
  }
  const seeker = me.role === 'seeker';
  return {
    tick: s.tick,
    phase: s.phase,
    timeLeft: round(game.timeLeft),
    headstartLeft: round(game.headstartLeft),
    finalHush: game.finalHush,
    you: {
      id: me.id, role: me.role, x: round(me.x), y: round(me.y), aim: round(me.aim), stamina: Math.round(me.stamina),
      item: me.item, mode: me.mode, frozen: !!me.frozen, seq: me.lastSeq,
      slowLeft: round(me.slowLeft), softLeft: round(me.softLeft), calmLeft: round(me.calmLeft), wideLeft: round(me.wideLeft),
      still: me.role === 'hider' ? round(me.stillTime) : 0,
      heartbeatIn: me.role === 'hider' && me.calmLeft <= 0 ? round(Math.max(0, HEARTBEAT.stillAfter - me.stillTime)) : null,
      heart: me.role === 'hider' ? round(heartLevel(game, me)) : 0,
      catches: me.catches,
    },
    players,
    ripples: s.ripples.filter((r) => rippleVisibleTo(r, me)).map((r) => ({ id: r.id, x: round(r.x), y: round(r.y), r: r.r, age: round(r.age), ttl: r.ttl, kind: r.kind })),
    pads: s.pads.map((p) => ({ id: p.id, x: p.x, y: p.y, item: p.item, side: p.side, readyIn: Math.ceil(p.readyIn) })),
    smokes: s.smokes.map((o) => ({ id: o.id, x: round(o.x), y: round(o.y), r: o.r, left: round(o.left) })),
    flares: s.flares.map((o) => ({ id: o.id, x: round(o.x), y: round(o.y), r: o.r, left: round(o.left) })),
    traps: seeker ? s.traps.map((t) => ({ id: t.id, x: round(t.x), y: round(t.y) })) : [],
    markers: seeker ? s.markers.map((m) => ({ by: m.by, x: round(m.x), y: round(m.y), left: round(m.left) })) : [],
    echoes: seeker ? s.echoes.map((e) => ({ x: round(e.x), y: round(e.y), left: round(e.left) })) : [],
    counts: { hiders: game.hiders().length, seekers: game.seekers().length },
  };
}

function round(v) {
  return Math.round(v * 100) / 100;
}
