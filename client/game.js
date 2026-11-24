// In-game client: input, client-side prediction + reconciliation, interpolation, HUD, sound cues.
import { GameMap } from '/shared/map.js';
import { stepMovement } from '/shared/physics.js';
import { DT, ITEMS, QUICK_CHAT } from '/shared/constants.js';
import { Renderer } from './render.js';
import { sfx } from './audio.js';
import { avatarHTML } from './faces.js';

const $ = (id) => document.getElementById(id);

export class GameView {
  constructor({ net, mapDef, start, myId }) {
    this.net = net;
    this.map = new GameMap(mapDef);
    this.myId = myId;
    this.setStart(start);
    this.canvas = $('canvas');
    this.renderer = new Renderer(this.canvas, this.map);
    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };
    this.seq = 0;
    this.pending = [];
    this.pred = null;
    this.offset = { x: 0, y: 0 };
    this.snap = null;
    this.prevSnap = null;
    this.snapAt = 0;
    this.bubbles = new Map();
    this.away = new Set();
    this.pings = {};
    this.seenRipples = new Set();
    this.lastHeart = 0;
    this.running = true;
    this.lastTimerSec = null;
    this.bind();
    this.inputTimer = setInterval(() => this.inputTick(), 1000 / 20);
    requestAnimationFrame((t) => this.frame(t));
  }

  setStart(start) {
    this.start = start;
    this.roster = new Map(start.roster.map((r) => [r.id, r]));
    this.ranked = start.ranked;
    this.hostId = start.hostId;
  }

  bind() {
    this.onKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'shift', 'tab'].includes(k)) e.preventDefault();
      if (k === 'tab') {
        this.renderScoreboard();
        $('scoreboard').classList.remove('hidden');
      } else if (k === 'escape') this.toggleMenu();
      else if (k === 'e') this.useItem();
      else if (/^[1-8]$/.test(k)) this.net.send({ t: 'chat', i: +k - 1 });
      this.keys.add(k);
      sfx.unlock();
    };
    this.onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === 'tab') $('scoreboard').classList.add('hidden');
    };
    this.onMouseMove = (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
    };
    this.onMouseDown = (e) => {
      sfx.unlock();
      if (e.button === 0) this.useItem();
      if (e.button === 2) {
        const w = this.renderer.toWorld(e.clientX, e.clientY);
        this.net.send({ t: 'marker', x: w.x, y: w.y });
      }
    };
    this.onContext = (e) => e.preventDefault();
    this.onResize = () => this.renderer.resize();
    this.onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', this.onContext);
  }

  destroy() {
    this.running = false;
    clearInterval(this.inputTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('contextmenu', this.onContext);
  }

  toggleMenu(force) {
    const m = $('menu');
    const show = force ?? m.classList.contains('hidden');
    m.classList.toggle('hidden', !show);
    $('menu-pause').classList.toggle('hidden', this.ranked || this.hostId !== this.myId);
    $('menu-note').textContent = this.ranked ? 'Leaving a ranked game counts as a loss and an AI finishes your round.' : '';
  }

  useItem() {
    if (!this.snap?.you.item) return;
    const w = this.renderer.toWorld(this.mouse.x, this.mouse.y);
    this.net.send({ t: 'use', x: w.x, y: w.y });
    sfx.use();
  }

  currentInput() {
    const k = this.keys;
    const dx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const dy = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
    const mode = k.has('shift') ? 'sneak' : k.has(' ') ? 'sprint' : 'walk';
    let aim = this.pred ? this.aimAngle() : 0;
    return { dx, dy, mode, aim };
  }

  aimAngle() {
    const w = this.renderer.toWorld(this.mouse.x, this.mouse.y);
    return Math.atan2(w.y - this.pred.y, w.x - this.pred.x);
  }

  inputTick() {
    if (!this.snap || !this.pred || !$('menu').classList.contains('hidden')) {
      if (this.snap) this.net.send({ t: 'input', seq: ++this.seq, dx: 0, dy: 0, mode: 'walk', aim: this.pred ? this.aimAngle() : 0 });
      return;
    }
    const input = this.currentInput();
    input.seq = ++this.seq;
    this.net.send({ t: 'input', ...input });
    if (!this.pred.frozen && this.snap.phase !== 'ended' && !this.paused) {
      stepMovement(this.map, this.pred, input, DT);
      this.pending.push(input);
      if (this.pending.length > 60) this.pending.shift();
    }
  }

  onSnap(snap) {
    this.prevSnap = this.snap;
    this.snap = snap;
    this.snapAt = performance.now();
    const you = snap.you;
    // reconcile prediction
    const before = this.pred ? { x: this.pred.x, y: this.pred.y } : null;
    this.pred = { x: you.x, y: you.y, stamina: you.stamina, slowLeft: you.slowLeft, lastMode: you.mode, frozen: you.frozen };
    this.pending = this.pending.filter((i) => i.seq > you.seq);
    for (const i of this.pending) stepMovement(this.map, this.pred, i, DT);
    if (before) {
      const ex = before.x + this.offset.x - this.pred.x, ey = before.y + this.offset.y - this.pred.y;
      if (Math.hypot(ex, ey) < 2) this.offset = { x: ex, y: ey };
      else this.offset = { x: 0, y: 0 };
    }
    this.updateHud();
    this.sounds();
  }

  sounds() {
    const s = this.snap;
    for (const r of s.ripples) {
      if (this.seenRipples.has(r.id)) continue;
      this.seenRipples.add(r.id);
      const dx = r.x - s.you.x, dy = r.y - s.you.y;
      const d = Math.hypot(dx, dy);
      const now = performance.now();
      if (d < 16 && (r.kind !== 'step' || now - (this.lastRippleSound || 0) > 350)) {
        this.lastRippleSound = now;
        sfx.ripple(dx / 10, Math.max(0, 1 - d / 16), r.kind);
      }
    }
    if (this.seenRipples.size > 500) this.seenRipples = new Set(s.ripples.map((r) => r.id));
    if (s.you.role === 'hider' && s.phase !== 'ended') {
      const bpm = 55 + s.you.heart * 110;
      const now = performance.now();
      if (now - this.lastHeart > 60000 / bpm) {
        this.lastHeart = now;
        if (s.you.heart > 0.15) sfx.heartbeat(s.you.heart);
        const h = $('hud-heart');
        h.animate([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 250 });
      }
    }
  }

  updateHud() {
    const s = this.snap, you = s.you;
    const role = $('hud-role');
    role.textContent = you.role === 'seeker' ? (this.start.roster && you.catches >= 0 && this.wasHider ? 'SHADE' : 'SEEKER') : 'HIDER';
    role.className = 'role ' + you.role;
    if (you.role === 'hider') this.wasHider = true;
    const t = Math.ceil(s.timeLeft);
    const timer = $('hud-timer');
    timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    timer.classList.toggle('final', s.finalHush);
    if (s.finalHush && this.lastTimerSec !== t && t <= 10) sfx.tick();
    this.lastTimerSec = t;
    $('hud-counts').textContent = `🫣 ${s.counts.hiders} hiding · 🔦 ${s.counts.seekers} seeking`;
    const center = $('hud-center');
    if (s.phase === 'headstart') {
      center.innerHTML = you.role === 'seeker'
        ? `Eyes closed… ${Math.ceil(s.headstartLeft)}<small>Hiders are running. Listen for ripples when the lights come on.</small>`
        : `Hide! ${Math.ceil(s.headstartLeft)}<small>Seekers are blindfolded. Get away from the hall and find the dark.</small>`;
    } else if (this.paused) center.innerHTML = 'Paused';
    else center.innerHTML = s.finalHush && t > 55 ? 'FINAL HUSH<small>Every heartbeat now pulses.</small>' : '';
    const slot = $('hud-item');
    slot.textContent = you.item ? ITEMS[you.item].icon : '';
    slot.title = you.item ? `${ITEMS[you.item].name}: ${ITEMS[you.item].desc}` : 'No item: walk over a glowing pad';
    slot.classList.toggle('has', !!you.item);
    $('hud-stamina').style.width = `${you.stamina}%`;
    const eff = [];
    if (you.softLeft > 0) eff.push(`🥿 ${Math.ceil(you.softLeft)}s`);
    if (you.calmLeft > 0) eff.push(`💤 ${Math.ceil(you.calmLeft)}s`);
    if (you.wideLeft > 0) eff.push(`🔦 ${Math.ceil(you.wideLeft)}s`);
    if (you.slowLeft > 0) eff.push(`<span class="warn">slowed</span>`);
    if (you.stamina < 10 && this.keys.has('shift')) eff.push(`<span class="warn">too tired to sneak</span>`);
    if (you.role === 'hider' && you.heartbeatIn !== null && you.heartbeatIn < 8) eff.push(`<span class="warn">♥ pulses in ${Math.ceil(you.heartbeatIn)}s, move!</span>`);
    $('hud-effects').innerHTML = eff.map((e) => (e.startsWith('<') ? e : `<span>${e}</span>`)).join('');
    $('hud-heart').classList.toggle('off', you.role !== 'hider');
  }

  feed(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    $('hud-feed').prepend(d);
    setTimeout(() => d.remove(), 6000);
  }

  name(id) {
    const r = this.roster.get(id);
    return r ? `<b style="color:${r.color}">${escapeHtml(r.name)}</b>` : '?';
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'caught':
        this.feed(`${this.name(ev.by)} caught ${this.name(ev.id)}`);
        sfx.caught();
        break;
      case 'phase':
        if (ev.phase === 'play') { sfx.start(); this.feed('Lights on. The hunt begins.'); }
        break;
      case 'lastHider':
        this.feed(`${this.name(ev.id)} is the last one hiding!`);
        break;
      case 'trap':
        this.feed(`${this.name(ev.id)} stepped on a noise trap`);
        break;
      case 'playerAway':
        this.away.add(ev.id);
        this.feed(`${this.name(ev.id)} is reconnecting…`);
        break;
      case 'playerBack':
        this.away.delete(ev.id);
        if (ev.id !== this.myId) this.feed(`${this.name(ev.id)} is back`);
        break;
      case 'playerLeft':
        this.away.add(ev.id);
        this.feed(`${this.name(ev.id)} left the game`);
        break;
      case 'paused':
        this.paused = true;
        $('paused').classList.remove('hidden');
        $('host-resume').classList.toggle('hidden', this.hostId !== this.myId);
        $('save-votes').textContent = '';
        break;
      case 'resumed':
        this.paused = false;
        $('paused').classList.add('hidden');
        break;
      case 'saveVote':
        $('save-votes').textContent = `Save votes: ${ev.yes}/${ev.needed} needed`;
        break;
    }
  }

  onChat(msg) {
    this.bubbles.set(msg.from, { text: msg.text, until: performance.now() + 3500 });
    const d = document.createElement('div');
    d.innerHTML = `${this.name(msg.from)}: ${escapeHtml(msg.text)}`;
    $('hud-chat').append(d);
    setTimeout(() => d.remove(), 7000);
  }

  renderScoreboard() {
    const rows = [...this.roster.values()].map((r) => {
      const ping = this.pings[r.id];
      return `<tr><td>${avatarHTML(r)} ${escapeHtml(r.name)}${this.away.has(r.id) ? ' ⚡' : ''}</td><td class="num">${r.rating}</td><td class="num">${ping != null ? ping + ' ms' : '–'}</td></tr>`;
    });
    $('score-table').innerHTML = `<tr><th>Player</th><th class="num">Rating</th><th class="num">Ping</th></tr>${rows.join('')}`;
  }

  frame(t) {
    if (!this.running) return;
    requestAnimationFrame((tt) => this.frame(tt));
    if (!this.snap || !this.pred) return;
    // decay prediction correction offset
    this.offset.x *= 0.85;
    this.offset.y *= 0.85;
    const me = { id: this.myId, x: this.pred.x + this.offset.x, y: this.pred.y + this.offset.y, aim: this.aimAngle(), role: this.snap.you.role };
    // interpolate others between last two snapshots
    const alpha = Math.min(1, (performance.now() - this.snapAt) / 50);
    const prev = new Map((this.prevSnap?.players || []).map((p) => [p.id, p]));
    const players = this.snap.players.map((p) => {
      const q = prev.get(p.id);
      if (!q) return p;
      return { ...p, x: q.x + (p.x - q.x) * alpha, y: q.y + (p.y - q.y) * alpha };
    });
    this.renderer.draw({ me, snap: this.snap, players, roster: this.roster, bubbles: this.bubbles, away: this.away, now: performance.now() });
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export { QUICK_CHAT };
