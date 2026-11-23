// Builds maps/manor.json from a readable, rectangle-based description.
// Run: npm run map
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameMap } from '../shared/map.js';

const W = 60, H = 40;
const g = Array.from({ length: H }, () => Array(W).fill('"'));
const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = c; };
const fill = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };
const box = (x0, y0, x1, y1, c) => {
  for (let x = x0; x <= x1; x++) { set(x, y0, c); set(x, y1, c); }
  for (let y = y0; y <= y1; y++) { set(x0, y, c); set(x1, y, c); }
};
const hline = (x0, x1, y, c) => fill(x0, y, x1, y, c);
const vline = (x, y0, y1, c) => fill(x, y0, x, y1, c);
const ellipse = (cx, cy, rx, ry, c) => {
  for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++)
    if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) set(x, y, c);
};

// ---- Garden ----
box(0, 0, W - 1, H - 1, 'H');
// gravel driveway & paths
fill(29, 1, 30, 7, ':');
fill(29, 32, 30, 38, ':');
hline(1, 13, 20, ':');
hline(46, 58, 20, ':');
hline(3, 56, 3, ':'); vline(3, 3, 36, ':'); vline(56, 3, 36, ':'); hline(3, 56, 36, ':');
// ponds
ellipse(9, 9, 4, 3, '~');
ellipse(50, 31, 4, 2, '~');
// bushes
fill(5, 25, 7, 27, '*'); fill(10, 14, 11, 16, '*');
fill(20, 4, 23, 5, '*'); fill(37, 5, 39, 6, '*');
fill(48, 6, 51, 7, '*'); fill(52, 24, 54, 26, '*');
fill(18, 33, 21, 34, '*'); fill(39, 33, 41, 35, '*');
fill(1, 1, 2, 2, '*'); fill(57, 37, 58, 38, '*');
fill(57, 1, 58, 2, '*'); fill(1, 37, 2, 38, '*');
// hedge maze (bottom-left)
box(5, 30, 13, 38, 'H');
set(9, 30, '"'); set(13, 34, '"'); set(5, 33, '"');
hline(7, 11, 32, 'H'); vline(7, 32, 36, 'H'); hline(9, 13, 36, 'H'); vline(11, 33, 35, 'H');
set(9, 36, '"'); set(7, 34, '"');
fill(8, 33, 10, 35, '"'); fill(9, 34, 9, 34, '*');
// shed (top-right)
box(47, 11, 55, 16, '#'); fill(48, 12, 54, 15, '.'); set(51, 16, 'D');
set(48, 12, 'o'); set(49, 12, 'o'); set(54, 15, 'o');
// gazebo (top-left), open structure
box(15, 2, 19, 6, 'H'); set(17, 6, '"'); set(15, 4, '"'); fill(16, 3, 18, 5, ',');

// ---- Manor house ----
box(14, 8, 45, 31, '#');
fill(15, 9, 44, 30, '.');
vline(24, 8, 31, '#'); vline(35, 8, 31, '#');
hline(14, 24, 16, '#'); hline(14, 24, 23, '#');
hline(35, 45, 16, '#'); hline(35, 45, 23, '#');
// floors
fill(15, 9, 23, 15, ',');   // west bedroom
fill(15, 24, 23, 30, ',');  // west study
fill(36, 17, 44, 22, ',');  // east lounge
fill(27, 10, 32, 29, ',');  // hall carpet runner
// doors (interior)
for (const y of [12, 20, 27]) { set(24, y, 'D'); set(35, y, 'D'); }
set(19, 16, 'D'); set(19, 23, 'D'); set(40, 16, 'D'); set(40, 23, 'D');
// doors (exterior)
set(29, 8, 'D'); set(30, 8, 'D'); set(29, 31, 'D'); set(30, 31, 'D'); set(14, 20, 'D'); set(45, 20, 'D');
// furniture
fill(16, 10, 17, 11, 'o'); fill(21, 13, 22, 13, 'o');           // bed, dresser
fill(17, 19, 19, 19, 'o'); fill(22, 21, 22, 22, 'o');           // west middle (dining)
fill(16, 27, 18, 27, 'o'); fill(22, 25, 22, 26, 'o');           // study desk, shelf
fill(26, 15, 26, 17, 'o'); fill(33, 15, 33, 17, 'o');           // hall benches
fill(26, 23, 26, 25, 'o'); fill(33, 23, 33, 25, 'o');
fill(37, 10, 43, 10, 'o'); fill(40, 13, 41, 13, 'o');           // kitchen counter, table
fill(38, 19, 39, 19, 'o'); fill(43, 18, 43, 20, 'o');           // lounge sofa
fill(37, 28, 39, 28, 'o'); fill(43, 25, 43, 26, 'o');           // east storage
// house plants (bushes indoors = hiding spots)
set(15, 22, '*'); set(44, 30, '*'); set(25, 9, '*'); set(34, 30, '*');

const rows = g.map((r) => r.join(''));

const def = {
  id: 'manor',
  name: 'Moonlit Manor',
  rows,
  lamps: [
    { x: 30, y: 5.5, r: 3.2 },
    { x: 30, y: 34.5, r: 3.2 },
    { x: 30, y: 20, r: 3.6 },
    { x: 8, y: 20.5, r: 2.8 },
    { x: 52, y: 20.5, r: 2.8 },
    { x: 51.5, y: 18.5, r: 2.2 },
    { x: 40.5, y: 11.5, r: 2.8 },
    { x: 19.5, y: 27.5, r: 2.4 },
  ],
  pads: [
    // hider pads
    { id: 'h1', x: 18.5, y: 13.5, item: 'decoy' },
    { id: 'h2', x: 41.5, y: 27.5, item: 'smoke' },
    { id: 'h3', x: 5.5, y: 15.5, item: 'softshoes' },
    { id: 'h4', x: 54.5, y: 28.5, item: 'calm' },
    { id: 'h5', x: 52.5, y: 14.5, item: 'decoy' },
    { id: 'h6', x: 9.5, y: 34.5, item: 'smoke' },
    { id: 'h7', x: 17.5, y: 4.5, item: 'calm' },
    // seeker pads
    { id: 's1', x: 31.5, y: 11.5, item: 'flare' },
    { id: 's2', x: 28.5, y: 28.5, item: 'trap' },
    { id: 's3', x: 21.5, y: 7.5, item: 'widebeam' },
    { id: 's4', x: 38.5, y: 37.5, item: 'echo' },
    { id: 's5', x: 44.5, y: 4.5, item: 'flare' },
    { id: 's6', x: 12.5, y: 23.5, item: 'echo' },
  ],
  spawns: {
    seekers: [{ x: 29.5, y: 19.5 }, { x: 30.5, y: 19.5 }],
    hiders: [
      { x: 28.5, y: 18.5 }, { x: 31.5, y: 18.5 }, { x: 28.5, y: 21.5 }, { x: 31.5, y: 21.5 },
      { x: 29.5, y: 17.5 }, { x: 30.5, y: 22.5 }, { x: 27.5, y: 20.5 }, { x: 32.5, y: 20.5 },
      { x: 29.5, y: 22.5 }, { x: 30.5, y: 17.5 }, { x: 27.5, y: 18.5 }, { x: 32.5, y: 22.5 },
      { x: 27.5, y: 22.5 }, { x: 32.5, y: 18.5 }, { x: 28.5, y: 20.5 },
    ],
  },
};

// Validate
const m = new GameMap(def);
const check = (p, what) => {
  const t = m.tileAtPos(p.x, p.y);
  if (t.solid) throw new Error(`${what} at ${p.x},${p.y} is inside ${t.name}`);
};
def.pads.forEach((p) => check(p, `pad ${p.id}`));
def.spawns.seekers.forEach((p) => check(p, 'seeker spawn'));
def.spawns.hiders.forEach((p) => check(p, 'hider spawn'));

const out = fileURLToPath(new URL('../maps/manor.json', import.meta.url));
writeFileSync(out, JSON.stringify(def, null, 1));
console.log(rows.join('\n'));
console.log(`wrote ${out}`);
