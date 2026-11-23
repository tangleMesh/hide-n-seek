// Movement step shared by the authoritative server and the client-side prediction.
import { SPEED, STAMINA } from './constants.js';

// p: { x, y, stamina, slowLeft, frozen }  input: { dx, dy, mode }
// Returns the effective movement mode ('idle' | 'sneak' | 'walk' | 'sprint').
export function stepMovement(map, p, input, dt) {
  let dx = +input.dx || 0, dy = +input.dy || 0;
  const len = Math.hypot(dx, dy);
  let mode = input.mode === 'sneak' || input.mode === 'sprint' ? input.mode : 'walk';
  if (p.frozen || len < 0.01) {
    p.stamina = Math.min(STAMINA.max, p.stamina + STAMINA.regen * dt);
    return 'idle';
  }
  dx /= len;
  dy /= len;
  if (mode === 'sprint') {
    if (p.stamina <= 0 || (p.stamina < STAMINA.minToSprint && p.lastMode !== 'sprint')) mode = 'walk';
  }
  if (mode === 'sprint') p.stamina = Math.max(0, p.stamina - STAMINA.drain * dt);
  else p.stamina = Math.min(STAMINA.max, p.stamina + STAMINA.regen * dt * (mode === 'sneak' ? 1 : 0.6));
  const floor = map.tileAtPos(p.x, p.y);
  let speed = SPEED[mode] * (floor.speed || 1);
  if (p.slowLeft > 0) speed *= 0.5;
  const next = map.move(p.x, p.y, dx * speed * dt, dy * speed * dt);
  p.x = next.x;
  p.y = next.y;
  p.lastMode = mode;
  return mode;
}
