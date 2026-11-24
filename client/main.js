// App shell: auth, home, lobby, queue, game lifecycle, invites, toasts.
import { Net } from './net.js';
import { GameView, escapeHtml } from './game.js';
import { QUICK_CHAT, COLORS, ITEMS, PAD_RESPAWN } from '/shared/constants.js';
import { sfx } from './audio.js';
import { avatarHTML, avatarURL, drawAvatar, FACES, FACE_LABELS } from './faces.js';

const $ = (id) => document.getElementById(id);
const state = { token: null, user: null, lobby: null, game: null, mapDef: null, lastMode: null, joinCode: null };
try { state.token = localStorage.getItem('hush_token'); } catch {}
state.joinCode = new URLSearchParams(location.search).get('join');

const net = new Net(() => state.token);

function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === `screen-${screen}`);
  state.screen = screen;
}

function toast(text, actions = []) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${escapeHtml(text)}</span>`;
  for (const [label, fn, primary] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.onclick = () => { fn(); t.remove(); };
    t.append(b);
  }
  $('toasts').append(t);
  setTimeout(() => t.remove(), actions.length ? 20000 : 4500);
}

fetch('/api/health').then((r) => r.json()).then((h) => { if (h.version) document.getElementById('version').textContent = 'v' + h.version; }).catch(() => {});

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------------- auth ----------------
let authMode = 'login';
for (const b of document.querySelectorAll('[data-auth]')) {
  b.onclick = () => {
    authMode = b.dataset.auth;
    for (const x of document.querySelectorAll('[data-auth]')) x.classList.toggle('active', x === b);
    $('auth-submit').textContent = authMode === 'login' ? 'Log in' : 'Create account';
    $('auth-pass').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  };
}
$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  try {
    const r = await api(`/api/${authMode}`, { name: $('auth-name').value.trim(), password: $('auth-pass').value });
    setSession(r.token, r.user);
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
};
$('logout').onclick = async () => {
  await api('/api/logout', {}).catch(() => {});
  try { localStorage.removeItem('hush_token'); } catch {}
  state.token = null;
  net.disconnect();
  show('auth');
};

function setSession(token, user) {
  state.token = token;
  state.user = user;
  try { localStorage.setItem('hush_token', token); } catch {}
  net.connect();
  goHome();
}

// ---------------- home ----------------
function renderMe() {
  $('me-name').textContent = state.user.name;
  $('me-rating').textContent = state.user.rating;
  $('me-avatar').src = avatarURL(state.user.color, state.user.face, 30);
}

async function goHome() {
  state.lobby = null;
  show('home');
  renderMe();
  refreshHome();
  if (state.joinCode) {
    net.send({ t: 'lobby:join', code: state.joinCode });
    state.joinCode = null;
    history.replaceState(null, '', '/');
  }
}

async function refreshHome() {
  try {
    const [me, lb, saved, online] = await Promise.all([api('/api/me'), api('/api/leaderboard'), api('/api/saved-games'), api('/api/online')]);
    state.user = me.user;
    renderMe();
    $('leaderboard').innerHTML = lb.players.map((p) => `<li>${avatarHTML(p)}<span class="name">${escapeHtml(p.name)}</span><span class="rating">${p.rating}</span></li>`).join('');
    $('saved-games').innerHTML = saved.games.length
      ? `<h2 style="margin-top:16px">Saved games</h2><ul class="online-list saved">${saved.games.map((g) => `<li><span class="name">${escapeHtml(g.players.join(', '))}<br><span class="mute">${Math.floor(g.timeLeft / 60)}:${String(g.timeLeft % 60).padStart(2, '0')} left · ${new Date(g.savedAt).toLocaleString()}</span></span><button data-resume="${g.id}">Resume</button></li>`).join('')}</ul>`
      : '';
    for (const b of document.querySelectorAll('[data-resume]')) b.onclick = () => net.send({ t: 'lobby:resumeSaved', savedId: b.dataset.resume });
    renderOnline($('online-list'), online.list, false);
  } catch (e) {
    if (e.message === 'not logged in') show('auth');
  }
}

function renderOnline(el, list, invite) {
  el.innerHTML = list.length
    ? list.map((p) => `<li>${avatarHTML(p)}<span class="name">${escapeHtml(p.name)} <span class="mute">${p.rating}</span></span><span class="mute">${p.status}</span>${invite && p.status === 'online' ? `<button data-invite="${escapeHtml(p.name)}">Invite</button>` : ''}</li>`).join('')
    : '<li class="mute">Nobody else online right now</li>';
  for (const b of el.querySelectorAll('[data-invite]')) b.onclick = () => net.send({ t: 'lobby:invite', name: b.dataset.invite });
}

$('btn-ranked').onclick = () => { sfx.unlock(); net.send({ t: 'queue:join' }); };
$('btn-queue-cancel').onclick = () => net.send({ t: 'queue:leave' });
$('btn-create').onclick = () => net.send({ t: 'lobby:create' });
$('join-form').onsubmit = (e) => {
  e.preventDefault();
  net.send({ t: 'lobby:join', code: $('join-code').value.trim().toUpperCase() });
};
setInterval(() => state.screen === 'home' && refreshHome(), 15000);

// ---------------- lobby ----------------
function renderLobby(l) {
  state.lobby = l;
  const me = state.user.id;
  const host = l.hostId === me;
  $('lobby-code').textContent = l.code;
  $('lobby-count').textContent = `${l.members.length}/16`;
  for (const el of document.querySelectorAll('#screen-lobby .host-only')) el.classList.toggle('hidden', !host);
  $('btn-find').textContent = l.open ? 'Stop searching' : 'Find players';
  $('round-len').value = String(l.roundSeconds);
  $('round-len').disabled = !!l.saved;
  const mine = l.members.find((m) => m.id === me);
  $('btn-ready').textContent = mine?.ready ? 'Not ready' : 'Ready';
  $('btn-ready').classList.toggle('hidden', host);
  $('lobby-members').innerHTML = l.members.map((m) => `
    <li>${avatarHTML(m)}<span class="name">${m.host ? '👑 ' : ''}${escapeHtml(m.name || '…')} <span class="mute">${m.rating ?? ''}</span></span>
    <span class="${m.ready ? 'tag-ready' : 'tag-wait'}">${m.ready ? 'ready' : 'waiting'}</span><span class="ping">${m.ping != null ? m.ping + ' ms' : ''}</span>
    ${host && m.id !== me ? `<button class="ghost" data-kick="${m.id}">✕</button>` : ''}</li>`).join('');
  for (const b of document.querySelectorAll('[data-kick]')) b.onclick = () => net.send({ t: 'lobby:kick', id: b.dataset.kick });
  const banner = $('saved-banner');
  if (l.saved) {
    const present = new Set(l.members.map((m) => m.id));
    const missing = l.saved.roster.filter((r) => l.saved.participants.includes(r.id) && !present.has(r.id));
    banner.classList.remove('hidden');
    banner.innerHTML = `<b>Saved game</b> (${Math.floor(l.saved.timeLeft / 60)}:${String(l.saved.timeLeft % 60).padStart(2, '0')} left). ` +
      (missing.length ? `Waiting for: ${missing.map((m) => escapeHtml(m.name)).join(', ')}. Invite them or start with AI stand-ins.` : 'Everyone is here.');
  } else banner.classList.add('hidden');
  // Colors are unique per lobby/game: tell the player when theirs was taken and they got another one.
  const cb = $('color-banner');
  const bumped = mine && !l.saved && mine.color !== state.user.color;
  cb.classList.toggle('hidden', !bumped);
  if (bumped) {
    const holder = l.members.find((m) => m.id !== me && m.color === state.user.color);
    cb.innerHTML = `${avatarHTML({ color: state.user.color, face: state.user.face }, 18)} Your color is taken${holder ? ` by <b>${escapeHtml(holder.name || '…')}</b>` : ''}, so you play as ${avatarHTML(mine, 18)} in this lobby. <button class="ghost" id="color-banner-pick">Pick another color</button>`;
    $('color-banner-pick').onclick = () => openLook();
    if (state.bumpedNotice !== l.id) {
      state.bumpedNotice = l.id;
      toast('Someone in this lobby already has your color, so you got a different one.');
    }
  }
  if (lookOpen()) renderLook();
  if (state.screen !== 'lobby' && !state.game) {
    show('lobby');
    refreshLobbyOnline();
  }
}

// ---------------- look (color + face) ----------------
const look = { color: null, face: null };
const lookOpen = () => !$('look').classList.contains('hidden');

function openLook() {
  look.color = state.user.color;
  look.face = state.user.face;
  $('look').classList.remove('hidden');
  renderLook();
}
function closeLook() {
  $('look').classList.add('hidden');
}

// Colors other lobby members are playing with can't be picked (faces can be shared).
function takenColors() {
  if (state.screen !== 'lobby' || !state.lobby) return new Set();
  return new Set(state.lobby.members.filter((m) => m.id !== state.user.id).map((m) => m.color));
}

function renderLook() {
  const taken = takenColors();
  if (taken.has(look.color)) look.color = COLORS.find((c) => !taken.has(c)) || look.color;
  $('look-colors').innerHTML = COLORS.map((c) => {
    const holder = taken.has(c) ? state.lobby.members.find((m) => m.id !== state.user.id && m.color === c) : null;
    return `<button data-color="${c}" class="${c === look.color ? 'sel' : ''}" style="background:${c}" ${holder ? 'disabled' : ''} title="${holder ? 'Taken by ' + escapeHtml(holder.name || '…') : c}" aria-label="${holder ? 'taken' : 'color ' + c}"></button>`;
  }).join('');
  $('look-faces').innerHTML = FACES.map((f) => `<button data-face="${f}" class="${f === look.face ? 'sel' : ''}" title="${FACE_LABELS[f]}" aria-label="${FACE_LABELS[f]}"><img alt="" src="${avatarURL(look.color, f, 44)}"></button>`).join('');
  for (const b of $('look-colors').querySelectorAll('button')) b.onclick = () => { look.color = b.dataset.color; renderLook(); };
  for (const b of $('look-faces').querySelectorAll('button')) b.onclick = () => { look.face = b.dataset.face; renderLook(); };
  const cv = $('look-preview');
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (cv.width !== 96 * dpr) cv.width = cv.height = 96 * dpr;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  drawAvatar(g, cv.width / 2, cv.height / 2, cv.width / 2 - 3 * dpr, look.color, look.face);
  $('look-face-name').textContent = FACE_LABELS[look.face] || '';
}

$('me-look').onclick = () => openLook();
$('btn-look').onclick = () => openLook();
$('look-cancel').onclick = () => closeLook();
$('look').onclick = (e) => { if (e.target.id === 'look') closeLook(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lookOpen()) closeLook(); });
$('look-save').onclick = () => {
  net.send({ t: 'me:look', color: look.color, face: look.face });
  closeLook();
};
net.on('me', (m) => {
  state.user = { ...state.user, ...m.user };
  renderMe();
  if (state.lobby) renderLobby(state.lobby);
});

// ---------------- guide (items, pads, controls) ----------------
function itemFacts(it) {
  const f = [];
  if (it.aim) f.push(`aimed · up to ${it.range} tiles`);
  else if (it.key !== 'trap') f.push('on yourself');
  if (it.duration && it.duration >= 2) f.push(`${it.duration} s`);
  if (it.lifetime) f.push(`lasts ${it.lifetime} s`);
  if (it.radius && it.radius >= 2) f.push(`${it.radius}-tile radius`);
  return f;
}

function itemCards(side) {
  return Object.entries(ITEMS).filter(([, it]) => it.side === side).map(([key, it]) => `
    <div class="g-item">
      <div class="g-icon" aria-hidden="true">${it.icon}</div>
      <div><div class="g-name">${it.name} ${itemFacts({ ...it, key }).map((x) => `<span class="g-fact">${x}</span>`).join('')}</div>
      <p>${it.how}</p><p class="mute">💡 ${it.tip}</p></div>
    </div>`).join('');
}

function renderGuide() {
  $('guide-body').innerHTML = `
    <section>
      <h3>Items: how they work</h3>
      <ul class="g-list">
        <li>Items lie on <b>glowing pads</b> at fixed spots on the map. Hiders have blue pads and seekers yellow ones. You can only pick up your own side's items, and the other side's pads look faded.</li>
        <li>Walk over a pad to pick its item up. You carry <b>one item</b> at a time, and a full hand leaves the pad alone.</li>
        <li>An empty pad comes back <b>${PAD_RESPAWN} s</b> after a pickup. Its timer is visible, so plan your route around it.</li>
        <li>Use your item with <kbd>E</kbd> or a left click. Aimed items land where your mouse points, within their range.</li>
        <li>In a game, <kbd>I</kbd> shows the explanation of the item you're carrying.</li>
        <li>If you are caught, you lose the item you carry. From then on you're a seeker and can use the yellow pads.</li>
      </ul>
    </section>
    <section>
      <h3>🫣 Hider items</h3>
      ${itemCards('hider')}
    </section>
    <section>
      <h3>🔦 Seeker items</h3>
      ${itemCards('seeker')}
    </section>
    <section>
      <h3>Controls</h3>
      <ul class="g-keys">
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</li>
        <li><kbd>Shift</kbd> sneak: quiet, uses stamina</li>
        <li><kbd>Space</kbd> sprint: fast, loud, uses stamina</li>
        <li><kbd>E</kbd> / left click: use item</li>
        <li><kbd>I</kbd> item info</li>
        <li>Right click: mark a spot for your seeker team</li>
        <li><kbd>1</kbd>–<kbd>8</kbd> quick chat</li>
        <li><kbd>Tab</kbd> scoreboard · <kbd>Esc</kbd> menu</li>
      </ul>
    </section>`;
}

function openGuide() {
  renderGuide();
  $('guide').classList.remove('hidden');
  $('guide-close').focus();
}
const closeGuide = () => $('guide').classList.add('hidden');
$('btn-guide').onclick = openGuide;
$('menu-guide').onclick = openGuide;
$('guide-close').onclick = closeGuide;
$('guide').onclick = (e) => { if (e.target.id === 'guide') closeGuide(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('guide').classList.contains('hidden')) closeGuide(); });

function refreshLobbyOnline() {
  net.send({ t: 'online:list' });
}
setInterval(() => state.screen === 'lobby' && refreshLobbyOnline(), 8000);

$('lobby-leave').onclick = () => { net.send({ t: 'lobby:leave' }); goHome(); };
$('btn-ready').onclick = () => {
  const mine = state.lobby.members.find((m) => m.id === state.user.id);
  net.send({ t: 'lobby:ready', ready: !mine?.ready });
};
$('btn-find').onclick = () => net.send({ t: 'lobby:open', open: !state.lobby.open });
$('round-len').onchange = (e) => net.send({ t: 'lobby:settings', roundSeconds: +e.target.value });
$('btn-start').onclick = () => { sfx.unlock(); net.send({ t: 'lobby:start' }); };
$('copy-link').onclick = async () => {
  const link = `${location.origin}/?join=${state.lobby.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { toast(link); }
};
$('invite-form').onsubmit = (e) => {
  e.preventDefault();
  const name = $('invite-name').value.trim();
  if (name) net.send({ t: 'lobby:invite', name });
  $('invite-name').value = '';
};
$('lobby-chat-bar').innerHTML = QUICK_CHAT.map((c, i) => `<button data-chat="${i}">${escapeHtml(c)}</button>`).join('');
for (const b of document.querySelectorAll('[data-chat]')) b.onclick = () => net.send({ t: 'chat', i: +b.dataset.chat });

// ---------------- queue ----------------
net.on('queue:status', (m) => {
  const box = $('queue-box');
  if (m.state === 'idle') {
    box.classList.add('hidden');
    $('btn-ranked').disabled = false;
    return;
  }
  box.classList.remove('hidden');
  $('btn-ranked').disabled = true;
  if (m.state === 'searching') {
    const s = Math.floor((Date.now() - m.since) / 1000);
    $('queue-text').textContent = `Searching for a match… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  } else if (m.state === 'found') $('queue-text').textContent = `Match found: players ${m.found}/${m.needed}`;
  else if (m.state === 'starting') $('queue-text').textContent = 'Match starting…';
});

// ---------------- game ----------------
async function loadMapDef(id) {
  if (!state.mapDef || state.mapDef.id !== id) state.mapDef = await (await fetch(`/maps/${id}.json`)).json();
  return state.mapDef;
}

net.on('game:start', async (m) => {
  $('queue-box').classList.add('hidden');
  $('btn-ranked').disabled = false;
  for (const id of ['results', 'menu', 'paused', 'scoreboard']) $(id).classList.add('hidden');
  state.lastMode = m.ranked ? 'ranked' : 'custom';
  if (state.game && state.game.start.gameId === m.gameId) {
    state.game.setStart(m);
    if (!m.paused) { state.game.paused = false; $('paused').classList.add('hidden'); }
    return;
  }
  // The server can send game:start twice in a row (start broadcast + reconnect). While the map is still
  // loading, only remember the newest message: building a second GameView would double every key press.
  if (state.startingGame?.gameId === m.gameId) {
    state.startingGame = m;
    return;
  }
  state.startingGame = m;
  state.game?.destroy();
  state.game = null;
  const mapDef = await loadMapDef(m.mapId);
  const start = state.startingGame;
  if (start?.gameId !== m.gameId) return; // another game started meanwhile
  state.startingGame = null;
  show('game');
  state.game = new GameView({ net, mapDef, start, myId: state.user.id });
  if (start.paused) state.game.onEvent({ type: 'paused' });
});
net.on('snap', (m) => state.game?.onSnap(m));
net.on('event', (m) => state.game?.onEvent(m.ev));
net.on('pings', (m) => state.game && (state.game.pings = m.pings));
net.on('chat', (m) => {
  if (m.scope === 'game' && state.game) return state.game.onChat(m);
  if (m.scope === 'lobby') {
    const li = document.createElement('li');
    li.innerHTML = `<b>${escapeHtml(m.name || '')}</b>: ${escapeHtml(m.text)}`;
    $('lobby-chat').prepend(li);
  } else if (state.screen === 'game' && !$('results').classList.contains('hidden')) {
    const name = state.game?.roster.get(m.from)?.name || '';
    const li = document.createElement('div');
    li.className = 'mute';
    li.textContent = `${name}: ${m.text}`;
    $('results-table').after(li);
  }
});
net.on('roundEnd', (m) => {
  const me = m.results.find((r) => r.id === state.user.id);
  $('results-title').textContent = (m.winner === 'seekers' ? 'Seekers win. Everyone was found.' : 'Hiders win. Someone stayed hidden.') + (me ? (me.win ? ' 🎉 You won!' : ' You lost.') : '');
  const rows = m.results.sort((a, b) => (b.win - a.win) || (b.catches - a.catches)).map((r) => {
    const info = state.game?.roster.get(r.id);
    return `<tr><td>${avatarHTML(info)} ${escapeHtml(r.name)}</td><td>${r.startRole === 'seeker' ? '🔦 seeker' : '🫣 hider'}</td><td>${r.caught ? 'caught' : r.startRole === 'hider' ? 'survived' : ''}</td><td class="num">${r.catches}</td>${m.ranked ? `<td class="num ${r.delta >= 0 ? 'up' : 'down'}">${r.delta >= 0 ? '+' : ''}${r.delta}</td>` : ''}</tr>`;
  });
  $('results-table').innerHTML = `<tr><th>Player</th><th>Started as</th><th></th><th class="num">Catches</th>${m.ranked ? '<th class="num">Rating</th>' : ''}</tr>${rows.join('')}`;
  $('results-again').classList.toggle('hidden', !m.ranked);
  $('results').classList.remove('hidden');
});
function leaveGameView() {
  state.game?.destroy();
  state.game = null;
  for (const id of ['results', 'menu', 'paused', 'scoreboard']) $(id).classList.add('hidden');
  if (state.lobby && state.lastMode === 'custom') {
    show('lobby');
    renderLobby(state.lobby);
  } else goHome();
}
$('results-back').onclick = leaveGameView;
$('results-again').onclick = () => { leaveGameView(); net.send({ t: 'queue:join' }); };
$('menu-resume').onclick = () => state.game?.toggleMenu(false);
$('menu-leave').onclick = () => net.send({ t: 'game:leave' });
$('menu-pause').onclick = () => { net.send({ t: 'game:pause' }); state.game?.toggleMenu(false); };
$('vote-save').onclick = () => net.send({ t: 'game:saveVote', yes: true });
$('vote-continue').onclick = () => net.send({ t: 'game:saveVote', yes: false });
$('host-resume').onclick = () => net.send({ t: 'game:resume' });
net.on('game:left', () => { state.lobby = null; leaveGameView(); });
net.on('game:saved', () => { toast('Game saved. Resume it from "Saved games" on the home screen.'); leaveGameView(); });
net.on('game:aborted', () => { toast('The game was closed'); leaveGameView(); });

// ---------------- misc server messages ----------------
net.on('welcome', (m) => {
  state.user = m.user;
  if (state.screen === 'auth') goHome();
});
net.on('lobby:state', (m) => {
  if (state.game && m.inGame) { state.lobby = m; return; }
  renderLobby(m);
});
net.on('lobby:left', () => {
  state.lobby = null;
  if (state.screen === 'lobby') goHome();
});
net.on('online', (m) => renderOnline($('lobby-online'), m.list, true));
net.on('invite', (m) => toast(`${m.from} invited you to their lobby`, [
  ['Join', () => net.send({ t: 'lobby:inviteReply', lobbyId: m.lobbyId, accept: true }), true],
  ['Decline', () => net.send({ t: 'lobby:inviteReply', lobbyId: m.lobbyId, accept: false })],
]));
net.on('toast', (m) => toast(m.text));
net.on('error', (m) => {
  if (m.code === 'auth') {
    try { localStorage.removeItem('hush_token'); } catch {}
    state.token = null;
    net.disconnect();
    show('auth');
    return;
  }
  if (m.missing && state.lobby?.hostId === state.user?.id) {
    toast(m.message, [['Start with AI stand-ins', () => net.send({ t: 'lobby:start', replaceMissing: true }), true]]);
  } else toast(m.message);
});
net.onStatus = (ok) => $('conn').classList.toggle('hidden', ok || !state.token);

// ---------------- boot ----------------
(async () => {
  if (state.token) {
    try {
      const me = await api('/api/me');
      state.user = me.user;
      net.connect();
      goHome();
      return;
    } catch {}
  }
  show('auth');
})();
