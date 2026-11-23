// Map model shared by server, bots and client: tiles, collision, line of sight, visibility polygons.
import { PLAYER_RADIUS } from './constants.js';

// Tile legend (ASCII in map files).
export const TILE = {
  '#': { name: 'wall', solid: true, opaque: true },
  H: { name: 'hedge', solid: true, opaque: true },
  o: { name: 'furniture', solid: true, opaque: false },
  '.': { name: 'wood', noiseMul: 1, noiseAdd: 0, speed: 1 },
  ',': { name: 'carpet', noiseMul: 0.5, noiseAdd: 0, speed: 1 },
  '"': { name: 'grass', noiseMul: 0.7, noiseAdd: 0, speed: 1 },
  ':': { name: 'gravel', noiseMul: 1.6, noiseAdd: 1.4, speed: 1 },
  '~': { name: 'water', noiseMul: 1.2, noiseAdd: 2.6, speed: 0.6 },
  '*': { name: 'bush', noiseMul: 1, noiseAdd: 1.3, speed: 0.7, bush: true },
  D: { name: 'door', noiseMul: 1, noiseAdd: 0, speed: 1, door: true },
};
const CODES = Object.keys(TILE);
const BY_CODE = CODES.map((c) => TILE[c]);
const CODE_OF = Object.fromEntries(CODES.map((c, i) => [c, i]));

export class GameMap {
  constructor(def) {
    this.id = def.id;
    this.name = def.name;
    this.h = def.rows.length;
    this.w = Math.max(...def.rows.map((r) => r.length));
    this.tiles = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let ch = def.rows[y][x] ?? '#';
        if (x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1) ch = ch === 'H' ? 'H' : '#';
        if (!(ch in CODE_OF)) ch = '.';
        this.tiles[y * this.w + x] = CODE_OF[ch];
      }
    }
    this.lamps = def.lamps || [];
    this.pads = def.pads || [];
    this.spawns = def.spawns;
    this.def = def;
  }

  char(x, y) {
    return CODES[this.tiles[y * this.w + x]];
  }
  tile(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return TILE['#'];
    return BY_CODE[this.tiles[ty * this.w + tx]];
  }
  tileAtPos(x, y) {
    return this.tile(Math.floor(x), Math.floor(y));
  }
  solid(tx, ty) {
    return !!this.tile(tx, ty).solid;
  }
  walkable(tx, ty) {
    return !this.tile(tx, ty).solid;
  }

  // Does a circle at (x,y) with radius r overlap any solid tile?
  collides(x, y, r = PLAYER_RADIUS) {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.solid(tx, ty)) continue;
        const cx = Math.max(tx, Math.min(x, tx + 1));
        const cy = Math.max(ty, Math.min(y, ty + 1));
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }

  // Move a circle by (dx,dy) with axis-separated sliding collision. Returns new position.
  move(x, y, dx, dy, r = PLAYER_RADIUS) {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.2));
    const sx = dx / steps, sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      if (!this.collides(x + sx, y, r)) x += sx;
      if (!this.collides(x, y + sy, r)) y += sy;
    }
    return { x, y };
  }

  // Line of sight between two points. opts.bushes: bushes block (except the viewer's own tile).
  los(ax, ay, bx, by, opts = {}) {
    const dx = bx - ax, dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return true;
    // Grid traversal (Amanatides & Woo)
    let tx = Math.floor(ax), ty = Math.floor(ay);
    const ex = Math.floor(bx), ey = Math.floor(by);
    const startX = tx, startY = ty;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = dx !== 0 ? (dx > 0 ? tx + 1 - ax : ax - tx) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? ty + 1 - ay : ay - ty) * tDeltaY : Infinity;
    for (let guard = 0; guard < 400; guard++) {
      if (!(tx === startX && ty === startY)) {
        const t = this.tile(tx, ty);
        if (t.opaque) return false;
        if (opts.bushes && t.bush) return false;
      }
      if (tx === ex && ty === ey) return true;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        tx += stepX;
      } else {
        tMaxY += tDeltaY;
        ty += stepY;
      }
    }
    return true;
  }

  // Cast a ray until hitting an opaque tile; returns distance (capped at max).
  castRay(x, y, angle, max) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let tx = Math.floor(x), ty = Math.floor(y);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = dx !== 0 ? (dx > 0 ? tx + 1 - x : x - tx) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? ty + 1 - y : y - ty) * tDeltaY : Infinity;
    let t = 0;
    while (t < max) {
      if (tMaxX < tMaxY) {
        t = tMaxX;
        tMaxX += tDeltaX;
        tx += stepX;
      } else {
        t = tMaxY;
        tMaxY += tDeltaY;
        ty += stepY;
      }
      if (t >= max) return max;
      if (this.tile(tx, ty).opaque) return t;
    }
    return max;
  }

  // Visibility polygon (list of [x,y]) for a circle (arc = full) or a cone.
  visibilityPolygon(x, y, radius, dir = 0, halfAngle = Math.PI, rays = 96) {
    const pts = [];
    const full = halfAngle >= Math.PI - 1e-6;
    if (!full) pts.push([x, y]);
    const n = full ? rays : Math.max(12, Math.round((rays * halfAngle) / Math.PI));
    const start = full ? 0 : dir - halfAngle;
    const span = full ? Math.PI * 2 : halfAngle * 2;
    for (let i = 0; i <= n; i++) {
      if (full && i === n) break;
      const a = start + (span * i) / n;
      const d = this.castRay(x, y, a, radius);
      pts.push([x + Math.cos(a) * d, y + Math.sin(a) * d]);
    }
    return pts;
  }

  isLit(x, y, extraLights = []) {
    for (const l of this.lamps) if ((x - l.x) ** 2 + (y - l.y) ** 2 <= l.r * l.r) return true;
    for (const l of extraLights) if ((x - l.x) ** 2 + (y - l.y) ** 2 <= l.r * l.r) return true;
    return false;
  }

  toJSON() {
    return this.def;
  }
}

// Shortest-path helper over the tile grid (8-neighbour A*). Returns array of tile centers or null.
export function findPath(map, sx, sy, gx, gy, maxNodes = 4000) {
  const w = map.w, h = map.h;
  const start = Math.floor(sy) * w + Math.floor(sx);
  const goal = Math.floor(gy) * w + Math.floor(gx);
  if (start === goal) return [];
  if (!map.walkable(goal % w, Math.floor(goal / w))) return null;
  const g = new Float32Array(w * h).fill(Infinity);
  const came = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  const heap = [];
  const push = (node, f) => {
    heap.push([f, node]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top[1];
  };
  const gxT = goal % w, gyT = Math.floor(goal / w);
  const hfn = (n) => {
    const dx = Math.abs((n % w) - gxT), dy = Math.abs(Math.floor(n / w) - gyT);
    return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
  };
  g[start] = 0;
  push(start, hfn(start));
  let expanded = 0;
  while (heap.length) {
    const cur = pop();
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    if (++expanded > maxNodes) return null;
    const cx = cur % w, cy = Math.floor(cur / w);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = cx + ox, ny = cy + oy;
        if (!map.walkable(nx, ny)) continue;
        if (ox && oy && (!map.walkable(cx + ox, cy) || !map.walkable(cx, cy + oy))) continue; // no corner cutting
        const t = map.tile(nx, ny);
        const cost = (ox && oy ? 1.414 : 1) / (t.speed || 1);
        const n = ny * w + nx;
        const ng = g[cur] + cost;
        if (ng < g[n]) {
          g[n] = ng;
          came[n] = cur;
          push(n, ng + hfn(n));
        }
      }
    }
  }
  if (came[goal] === -1) return null;
  const path = [];
  for (let n = goal; n !== start; n = came[n]) path.push([(n % w) + 0.5, Math.floor(n / w) + 0.5]);
  return path.reverse();
}
