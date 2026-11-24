// Hand-drawn ("scribbled") faces on a colored disc. Strokes get a small, fixed wobble per face so they look drawn
// by hand but never flicker. Used for the in-game avatars and every avatar in the menus.
import { FACES } from '/shared/look.js';

export { FACES };

export const FACE_LABELS = {
  happy: 'Happy', grin: 'Grin', wink: 'Wink', cool: 'Cool', love: 'In love', silly: 'Silly', shock: 'Shocked', nervous: 'Nervous',
  sleepy: 'Sleepy', meh: 'Meh', sad: 'Sad', angry: 'Angry', mad: 'Furious', evil: 'Evil', dizzy: 'Dizzy', smug: 'Smug',
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inkFor(color) {
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1b1b22' : '#ffffff';
}

// Drawing kit in unit coordinates (the face disc has radius 1).
function kit(g, rnd, ink) {
  const j = (s = 0.035) => (rnd() - 0.5) * 2 * s;
  const stroke = (pts, { close = false, fill = null, width = 0.13 } = {}) => {
    g.beginPath();
    g.moveTo(pts[0][0] + j(0.02), pts[0][1] + j(0.02));
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      g.quadraticCurveTo((ax + bx) / 2 + j(), (ay + by) / 2 + j(), bx + j(0.02), by + j(0.02));
    }
    if (close) g.closePath();
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    }
    g.lineWidth = width;
    g.strokeStyle = ink;
    g.stroke();
  };
  const arc = (cx, cy, r, a0, a1, n = 9) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  };
  const dot = (x, y, r = 0.1) => {
    g.beginPath();
    g.arc(x + j(0.015), y + j(0.015), r, 0, Math.PI * 2);
    g.fillStyle = ink;
    g.fill();
  };
  const heart = (x, y, s) => {
    g.beginPath();
    g.moveTo(x, y + s * 0.9);
    g.bezierCurveTo(x - s * 1.3, y + s * 0.1, x - s * 0.7, y - s * 0.9, x, y - s * 0.25);
    g.bezierCurveTo(x + s * 0.7, y - s * 0.9, x + s * 1.3, y + s * 0.1, x, y + s * 0.9);
    g.fillStyle = ink === '#ffffff' ? '#ffd6e0' : '#d6336c';
    g.fill();
  };
  return { stroke, arc, dot, heart, j };
}

const PI = Math.PI;
const EY = -0.22, EX = 0.36; // eye positions

const DRAW = {
  happy({ dot, stroke, arc }) {
    dot(-EX, EY); dot(EX, EY);
    stroke(arc(0, 0.02, 0.48, 0.18 * PI, 0.82 * PI));
  },
  grin({ dot, stroke, arc }) {
    dot(-EX, EY - 0.04, 0.11); dot(EX, EY - 0.04, 0.11);
    stroke([[-0.5, 0.12], ...arc(0, 0.12, 0.5, 0, PI)], { close: true, fill: 'rgba(255,255,255,.85)' });
    stroke([[-0.16, 0.14], [-0.16, 0.42]], { width: 0.08 });
    stroke([[0.16, 0.14], [0.16, 0.42]], { width: 0.08 });
  },
  wink({ dot, stroke, arc }) {
    dot(-EX, EY);
    stroke([[EX - 0.17, EY + 0.04], [EX, EY - 0.1], [EX + 0.17, EY + 0.04]]);
    stroke(arc(0.04, 0.05, 0.42, 0.2 * PI, 0.8 * PI));
    stroke(arc(0.2, 0.42, 0.12, 0, PI), { fill: '#ff8fab', width: 0.09 });
  },
  cool({ stroke }) {
    stroke([[-0.72, -0.34], [-0.1, -0.34], [-0.16, -0.06], [-0.62, -0.06]], { close: true, fill: '#111' });
    stroke([[0.1, -0.34], [0.72, -0.34], [0.62, -0.06], [0.16, -0.06]], { close: true, fill: '#111' });
    stroke([[-0.1, -0.3], [0.1, -0.3]], { width: 0.1 });
    stroke([[-0.32, 0.38], [0.05, 0.44], [0.4, 0.26]]);
  },
  love({ heart, stroke, arc }) {
    heart(-EX, EY, 0.2); heart(EX, EY, 0.2);
    stroke(arc(0, 0.02, 0.46, 0.2 * PI, 0.8 * PI));
  },
  silly({ dot, stroke, arc }) {
    stroke(arc(-EX, EY, 0.16, 0, 2 * PI, 12), { width: 0.09 });
    dot(-EX + 0.05, EY + 0.04, 0.07);
    dot(EX, EY, 0.09);
    stroke(arc(0, 0.04, 0.46, 0.15 * PI, 0.85 * PI));
    stroke(arc(0, 0.47, 0.14, 0, PI, 7), { close: true, fill: '#ff8fab', width: 0.09 });
  },
  shock({ dot, stroke, arc }) {
    stroke(arc(-EX, EY, 0.17, 0, 2 * PI, 12), { width: 0.09, fill: 'rgba(255,255,255,.9)' });
    stroke(arc(EX, EY, 0.17, 0, 2 * PI, 12), { width: 0.09, fill: 'rgba(255,255,255,.9)' });
    dot(-EX, EY, 0.07); dot(EX, EY, 0.07);
    stroke(arc(0, 0.4, 0.17, 0, 2 * PI, 12), { fill: 'rgba(0,0,0,.55)' });
  },
  nervous({ dot, stroke, arc }) {
    dot(-EX, EY); dot(EX, EY);
    stroke([[-0.42, 0.34], [-0.28, 0.24], [-0.14, 0.36], [0, 0.24], [0.14, 0.36], [0.28, 0.24], [0.42, 0.34]], { width: 0.1 });
    stroke([[0.66, -0.66], ...arc(0.66, -0.4, 0.11, -0.15 * PI, 1.15 * PI, 8)], { close: true, fill: '#a5d8ff', width: 0.07 });
  },
  sleepy({ stroke, arc }) {
    stroke(arc(-EX, EY - 0.06, 0.15, 0.15 * PI, 0.85 * PI, 6), { width: 0.1 });
    stroke(arc(EX, EY - 0.06, 0.15, 0.15 * PI, 0.85 * PI, 6), { width: 0.1 });
    stroke(arc(0, 0.38, 0.1, 0, 2 * PI, 10), { width: 0.09 });
    stroke([[0.5, -0.78], [0.72, -0.78], [0.5, -0.56], [0.72, -0.56]], { width: 0.07 });
  },
  meh({ dot, stroke }) {
    stroke([[-EX - 0.17, EY - 0.05], [-EX + 0.17, EY - 0.05]], { width: 0.09 });
    stroke([[EX - 0.17, EY - 0.05], [EX + 0.17, EY - 0.05]], { width: 0.09 });
    dot(-EX, EY + 0.06, 0.08); dot(EX, EY + 0.06, 0.08);
    stroke([[-0.32, 0.36], [0.34, 0.34]]);
  },
  sad({ dot, stroke, arc }) {
    dot(-EX, EY); dot(EX, EY);
    stroke(arc(0, 0.68, 0.38, 1.2 * PI, 1.8 * PI));
    stroke([[-EX, EY + 0.12], ...arc(-EX, EY + 0.34, 0.08, -0.15 * PI, 1.15 * PI, 7)], { close: true, fill: '#a5d8ff', width: 0.06 });
  },
  angry({ dot, stroke, arc }) {
    stroke([[-0.6, -0.48], [-0.14, -0.3]]);
    stroke([[0.6, -0.48], [0.14, -0.3]]);
    dot(-EX, EY + 0.02); dot(EX, EY + 0.02);
    stroke(arc(0, 0.7, 0.36, 1.25 * PI, 1.75 * PI));
  },
  mad({ dot, stroke }) {
    stroke([[-0.62, -0.56], [-0.12, -0.28]], { width: 0.15 });
    stroke([[0.62, -0.56], [0.12, -0.28]], { width: 0.15 });
    dot(-EX, EY + 0.04, 0.08); dot(EX, EY + 0.04, 0.08);
    stroke([[-0.42, 0.22], [0.42, 0.22], [0.42, 0.46], [-0.42, 0.46]], { close: true, fill: 'rgba(255,255,255,.9)', width: 0.1 });
    stroke([[-0.42, 0.34], [-0.28, 0.24], [-0.14, 0.44], [0, 0.24], [0.14, 0.44], [0.28, 0.24], [0.42, 0.34]], { width: 0.06 });
  },
  evil({ stroke, arc }) {
    stroke([[-0.62, -0.44], [-0.14, -0.26]]);
    stroke([[0.62, -0.44], [0.14, -0.26]]);
    stroke([[-0.5, -0.12], [-0.22, -0.08]], { width: 0.1 });
    stroke([[0.5, -0.12], [0.22, -0.08]], { width: 0.1 });
    stroke([[-0.62, 0.04], [0, 0.18], ...arc(0, 0.06, 0.6, 0.05 * PI, 0.95 * PI)], { close: true, fill: 'rgba(0,0,0,.6)' });
  },
  dizzy({ stroke }) {
    const spiral = (cx, cy) => {
      const pts = [];
      for (let i = 0; i <= 14; i++) {
        const a = i * 0.9, r = 0.02 + i * 0.012;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      return pts;
    };
    stroke(spiral(-EX, EY), { width: 0.07 });
    stroke(spiral(EX, EY), { width: 0.07 });
    stroke([[-0.38, 0.36], [-0.18, 0.26], [0, 0.38], [0.18, 0.26], [0.38, 0.36]], { width: 0.1 });
  },
  smug({ dot, stroke, arc }) {
    stroke([[-0.56, -0.38], [-0.16, -0.42]], { width: 0.09 });
    stroke(arc(EX, -0.36, 0.2, 1.15 * PI, 1.85 * PI, 6), { width: 0.09 });
    stroke([[-EX - 0.16, EY], [-EX + 0.16, EY]], { width: 0.1 });
    dot(-EX + 0.04, EY + 0.08, 0.07);
    dot(EX, EY, 0.09);
    stroke([[-0.3, 0.32], [0.1, 0.36], [0.42, 0.18]]);
  },
};

function faceSeed(face) {
  let h = 7;
  for (const ch of face) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Draws the colored disc with its face at (x, y) with radius r.
export function drawAvatar(g, x, y, r, color, face) {
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.translate(x, y);
  g.scale(r * 0.88, r * 0.88);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const draw = DRAW[face] || DRAW.happy;
  draw(kit(g, rng(faceSeed(face)), inkFor(color)));
  g.restore();
}

// Pre-rendered avatar canvases (the game draws many avatars every frame).
const sprites = new Map();
export function avatarSprite(color, face, r) {
  const key = `${color}|${face}|${Math.round(r)}`;
  let c = sprites.get(key);
  if (!c) {
    if (sprites.size > 400) sprites.clear();
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(r * 2 + 4);
    drawAvatar(c.getContext('2d'), c.width / 2, c.height / 2, r, color, face);
    sprites.set(key, c);
  }
  return c;
}

const urls = new Map();
export function avatarURL(color, face, size = 22) {
  const key = `${color}|${face}|${size}`;
  let u = urls.get(key);
  if (!u) {
    const dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const c = document.createElement('canvas');
    c.width = c.height = size * dpr;
    drawAvatar(c.getContext('2d'), c.width / 2, c.height / 2, c.width / 2 - 1, color || '#999', face || 'happy');
    u = c.toDataURL();
    urls.set(key, u);
  }
  return u;
}

export function avatarHTML(p, size = 22) {
  return `<img class="avatar" width="${size}" height="${size}" alt="" src="${avatarURL(p?.color, p?.face, size)}">`;
}
