// Canvas renderer: tile map, lights, fog of war (visibility polygons), entities, ripples.
import { VISION, ITEMS } from '/shared/constants.js';

const TILE_COLORS = {
  wall: ['#2a2d38', '#30343f'], hedge: ['#173a22', '#1c4428'], furniture: ['#5a4030', '#634636'],
  wood: ['#6b5137', '#735839'], carpet: ['#5a2630', '#612a35'], grass: ['#2c4a2a', '#305030'],
  gravel: ['#5d5d61', '#67676b'], water: ['#1e4766', '#22506f'], bush: ['#1d5a2b', '#236432'], door: ['#8a6a42', '#8a6a42'],
};

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Renderer {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.fog = document.createElement('canvas');
    this.fctx = this.fog.getContext('2d');
    this.lampPolys = map.lamps.map((l) => ({ ...l, poly: map.visibilityPolygon(l.x, l.y, l.r, 0, Math.PI, 72) }));
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.fog.width = this.canvas.width;
    this.fog.height = this.canvas.height;
    this.px = Math.max(30, Math.min(64, Math.min(w / 19, h / 12))) * dpr;
    this.buildMapLayer();
  }

  buildMapLayer() {
    const m = this.map, px = this.px;
    const c = document.createElement('canvas');
    c.width = Math.ceil(m.w * px);
    c.height = Math.ceil(m.h * px);
    const g = c.getContext('2d');
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const t = m.tile(x, y);
        const cols = TILE_COLORS[t.name] || ['#444', '#444'];
        const r = hash(x, y);
        g.fillStyle = cols[r < 0.5 ? 0 : 1];
        g.fillRect(x * px, y * px, px + 1, px + 1);
        if (t.name === 'wood') {
          g.fillStyle = 'rgba(0,0,0,.12)';
          g.fillRect(x * px, y * px + px * 0.5, px, 1);
        } else if (t.name === 'gravel') {
          g.fillStyle = 'rgba(255,255,255,.08)';
          for (let i = 0; i < 5; i++) g.fillRect(x * px + hash(x + i, y) * px, y * px + hash(x, y + i) * px, 2, 2);
        } else if (t.name === 'grass') {
          g.fillStyle = 'rgba(120,200,110,.10)';
          for (let i = 0; i < 3; i++) g.fillRect(x * px + hash(x * 3 + i, y) * px, y * px + hash(x, y * 7 + i) * px, 1, 3);
        } else if (t.name === 'bush') {
          g.fillStyle = '#2f7a3d';
          g.beginPath();
          g.arc(x * px + px / 2, y * px + px / 2, px * 0.46, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = 'rgba(0,0,0,.2)';
          g.beginPath();
          g.arc(x * px + px * 0.6, y * px + px * 0.6, px * 0.25, 0, Math.PI * 2);
          g.fill();
        } else if (t.name === 'water') {
          g.strokeStyle = 'rgba(160,210,255,.15)';
          g.beginPath();
          g.moveTo(x * px + px * 0.2, y * px + px * (0.3 + r * 0.4));
          g.lineTo(x * px + px * 0.7, y * px + px * (0.3 + r * 0.4));
          g.stroke();
        } else if (t.name === 'wall' || t.name === 'hedge') {
          g.fillStyle = 'rgba(255,255,255,.05)';
          g.fillRect(x * px, y * px, px, 2);
        } else if (t.name === 'furniture') {
          g.fillStyle = 'rgba(0,0,0,.25)';
          g.fillRect(x * px + 2, y * px + px - 4, px - 4, 3);
        } else if (t.name === 'door') {
          g.fillStyle = 'rgba(0,0,0,.35)';
          g.fillRect(x * px + px * 0.1, y * px + px * 0.1, px * 0.8, px * 0.8);
          g.fillStyle = '#b38a55';
          g.fillRect(x * px + px * 0.15, y * px + px * 0.15, px * 0.7, px * 0.7);
        }
      }
    }
    this.mapLayer = c;
  }

  // world → screen
  sx(x) {
    return (x - this.camX) * this.px + this.canvas.width / 2;
  }
  sy(y) {
    return (y - this.camY) * this.px + this.canvas.height / 2;
  }
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * this.dpr, y = (clientY - rect.top) * this.dpr;
    return { x: (x - this.canvas.width / 2) / this.px + this.camX, y: (y - this.canvas.height / 2) / this.px + this.camY };
  }

  polyPath(g, poly) {
    g.beginPath();
    poly.forEach(([x, y], i) => (i ? g.lineTo(this.sx(x), this.sy(y)) : g.moveTo(this.sx(x), this.sy(y))));
    g.closePath();
  }

  /**
   * view: { me:{x,y,aim,role,...}, snap, players:[{id,x,y,aim,role,wide}], roster:Map, bubbles:Map, now }
   */
  draw(view) {
    const g = this.ctx, px = this.px, W = this.canvas.width, H = this.canvas.height;
    const { me, snap } = view;
    this.camX = Math.max(W / 2 / px, Math.min(this.map.w - W / 2 / px, me.x));
    this.camY = Math.max(H / 2 / px, Math.min(this.map.h - H / 2 / px, me.y));
    if (W / px > this.map.w) this.camX = this.map.w / 2;
    if (H / px > this.map.h) this.camY = this.map.h / 2;
    g.fillStyle = '#05060a';
    g.fillRect(0, 0, W, H);
    g.drawImage(this.mapLayer, Math.round(this.sx(0)), Math.round(this.sy(0)));

    // warm lamp glow on the ground
    for (const l of this.lampPolys) {
      const grd = g.createRadialGradient(this.sx(l.x), this.sy(l.y), 0, this.sx(l.x), this.sy(l.y), l.r * px);
      grd.addColorStop(0, 'rgba(255,200,120,.28)');
      grd.addColorStop(1, 'rgba(255,200,120,0)');
      g.fillStyle = grd;
      this.polyPath(g, l.poly);
      g.fill();
    }
    for (const f of snap.flares) {
      const grd = g.createRadialGradient(this.sx(f.x), this.sy(f.y), 0, this.sx(f.x), this.sy(f.y), f.r * px);
      grd.addColorStop(0, 'rgba(255,120,60,.45)');
      grd.addColorStop(1, 'rgba(255,120,60,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(this.sx(f.x), this.sy(f.y), f.r * px, 0, Math.PI * 2);
      g.fill();
    }

    // flashlight cones of visible seekers (including me)
    const seekers = view.players.filter((p) => p.role === 'seeker');
    if (me.role === 'seeker') seekers.push({ ...me, wide: snap.you.wideLeft > 0, isMe: true });
    if (!(snap.phase === 'headstart')) {
      for (const s of seekers) {
        const half = s.wide ? VISION.wideHalfAngle : VISION.coneHalfAngle;
        const poly = this.map.visibilityPolygon(s.x, s.y, VISION.coneRange, s.aim, half, 64);
        const grd = g.createRadialGradient(this.sx(s.x), this.sy(s.y), 0, this.sx(s.x), this.sy(s.y), VISION.coneRange * px);
        grd.addColorStop(0, 'rgba(255,240,190,.30)');
        grd.addColorStop(1, 'rgba(255,240,190,0)');
        g.fillStyle = grd;
        this.polyPath(g, poly);
        g.fill();
        s._poly = poly;
      }
    }

    // smoke
    for (const s of snap.smokes) {
      g.fillStyle = `rgba(190,195,205,${0.55 * Math.min(1, s.left / 1.5)})`;
      g.beginPath();
      g.arc(this.sx(s.x), this.sy(s.y), s.r * px, 0, Math.PI * 2);
      g.fill();
    }

    // fog of war
    this.drawFog(view, seekers);

    // pads (known positions, timers)
    for (const p of snap.pads) {
      const x = this.sx(p.x), y = this.sy(p.y);
      const mine = p.side === me.role;
      g.globalAlpha = mine ? 1 : 0.35;
      g.strokeStyle = p.side === 'seeker' ? 'rgba(255,209,102,.8)' : 'rgba(124,196,255,.8)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, px * 0.42, 0, Math.PI * 2);
      g.stroke();
      if (p.readyIn > 0) {
        g.fillStyle = 'rgba(0,0,0,.6)';
        g.beginPath();
        g.arc(x, y, px * 0.38, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ccd';
        g.font = `${Math.round(px * 0.36)}px system-ui`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(p.readyIn, x, y);
      } else {
        g.font = `${Math.round(px * 0.5)}px system-ui`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(ITEMS[p.item].icon, x, y + 1);
      }
      g.globalAlpha = 1;
    }

    // traps (seekers only receive them)
    for (const t of snap.traps) {
      g.strokeStyle = 'rgba(255,107,107,.7)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.arc(this.sx(t.x), this.sy(t.y), px * 0.6, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    // ripples (sound) – drawn above the fog: you hear through walls
    for (const r of snap.ripples) {
      const k = Math.min(1, r.age / r.ttl);
      const rad = r.r * px * (0.25 + 0.75 * Math.sqrt(k));
      const col = r.kind === 'heart' ? '255,80,110' : r.kind === 'trap' ? '255,120,60' : r.kind === 'echo' ? '124,196,255' : r.kind === 'door' ? '255,220,150' : '230,235,255';
      g.strokeStyle = `rgba(${col},${(1 - k) * 0.9})`;
      g.lineWidth = r.kind === 'heart' ? 3 : 2;
      g.beginPath();
      g.arc(this.sx(r.x), this.sy(r.y), rad, 0, Math.PI * 2);
      g.stroke();
      if (r.kind === 'heart' && k < 0.5) {
        g.fillStyle = `rgba(255,80,110,${0.8 - k})`;
        g.font = `${Math.round(px * 0.6)}px system-ui`;
        g.fillText('♥', this.sx(r.x), this.sy(r.y));
      }
    }
    for (const e of snap.echoes) {
      g.fillStyle = `rgba(255,80,110,${Math.min(1, e.left)})`;
      g.beginPath();
      g.arc(this.sx(e.x), this.sy(e.y), px * 0.3, 0, Math.PI * 2);
      g.fill();
    }
    for (const m of snap.markers) {
      const x = this.sx(m.x), y = this.sy(m.y);
      g.strokeStyle = `rgba(255,209,102,${Math.min(1, m.left / 2)})`;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y - px * 0.9);
      g.lineTo(x, y);
      g.stroke();
      g.fillStyle = g.strokeStyle;
      g.beginPath();
      g.moveTo(x, y - px * 0.9);
      g.lineTo(x + px * 0.5, y - px * 0.7);
      g.lineTo(x, y - px * 0.5);
      g.fill();
    }

    // players
    const all = [...view.players, { ...me, isMe: true }];
    for (const p of all) this.drawPlayer(p, view);
  }

  drawFog(view, seekers) {
    const f = this.fctx, px = this.px;
    const { me, snap } = view;
    f.globalCompositeOperation = 'source-over';
    f.clearRect(0, 0, this.fog.width, this.fog.height);
    const blind = me.role === 'seeker' && snap.phase === 'headstart';
    f.fillStyle = blind ? 'rgba(2,3,6,0.97)' : me.role === 'seeker' ? 'rgba(3,4,10,0.84)' : 'rgba(3,4,10,0.78)';
    f.fillRect(0, 0, this.fog.width, this.fog.height);
    if (!blind) {
      f.globalCompositeOperation = 'destination-out';
      const cut = (poly, cx, cy, r, alpha = 1) => {
        const grd = f.createRadialGradient(this.sx(cx), this.sy(cy), 0, this.sx(cx), this.sy(cy), r * px);
        grd.addColorStop(0, `rgba(0,0,0,${alpha})`);
        grd.addColorStop(0.8, `rgba(0,0,0,${alpha * 0.92})`);
        grd.addColorStop(1, `rgba(0,0,0,${alpha * 0.25})`);
        f.fillStyle = grd;
        f.beginPath();
        poly.forEach(([x, y], i) => (i ? f.lineTo(this.sx(x), this.sy(y)) : f.moveTo(this.sx(x), this.sy(y))));
        f.closePath();
        f.fill();
      };
      if (me.role === 'hider') {
        cut(this.map.visibilityPolygon(me.x, me.y, VISION.hiderRadius, 0, Math.PI, 90), me.x, me.y, VISION.hiderRadius);
      } else {
        for (const s of seekers) if (s.isMe && s._poly) cut(s._poly, s.x, s.y, VISION.coneRange);
      }
      cut(this.map.visibilityPolygon(me.x, me.y, VISION.ambient + 0.6, 0, Math.PI, 48), me.x, me.y, VISION.ambient + 0.6);
      for (const l of this.lampPolys) cut(l.poly, l.x, l.y, l.r, 0.55);
      for (const fl of snap.flares) cut(this.map.visibilityPolygon(fl.x, fl.y, fl.r, 0, Math.PI, 64), fl.x, fl.y, fl.r, 0.85);
    }
    f.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(this.fog, 0, 0);
  }

  drawPlayer(p, view) {
    const g = this.ctx, px = this.px;
    const info = view.roster.get(p.id) || { name: '?', color: '#999' };
    const x = this.sx(p.x), y = this.sy(p.y);
    const r = px * 0.36;
    if (p.role === 'seeker') {
      g.fillStyle = 'rgba(255,209,102,.25)';
      g.beginPath();
      g.arc(x, y, r * 1.6, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = info.color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = p.isMe ? 3 : 2;
    g.strokeStyle = p.role === 'seeker' ? '#ffd166' : p.isMe ? '#fff' : 'rgba(0,0,0,.6)';
    g.stroke();
    // facing indicator
    g.strokeStyle = 'rgba(255,255,255,.8)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x + Math.cos(p.aim) * r * 0.4, y + Math.sin(p.aim) * r * 0.4);
    g.lineTo(x + Math.cos(p.aim) * r * 1.05, y + Math.sin(p.aim) * r * 1.05);
    g.stroke();
    g.font = `${Math.round(px * 0.34)}px system-ui`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillStyle = 'rgba(0,0,0,.6)';
    const label = info.name + (view.away?.has(p.id) ? ' ⚡' : '');
    g.fillText(label, x + 1, y - r - 3);
    g.fillStyle = '#fff';
    g.fillText(label, x, y - r - 4);
    const b = view.bubbles.get(p.id);
    if (b && b.until > view.now) {
      g.font = `${Math.round(px * 0.4)}px system-ui`;
      const w = g.measureText(b.text).width + 14;
      const by = y - r - px * 0.75;
      g.fillStyle = 'rgba(255,255,255,.92)';
      g.beginPath();
      g.roundRect(x - w / 2, by - px * 0.55, w, px * 0.55, 8);
      g.fill();
      g.fillStyle = '#111';
      g.textBaseline = 'middle';
      g.fillText(b.text, x, by - px * 0.27);
    }
  }
}
