import { Room } from './net.js';
import { Voice } from './voice.js';
import { sfx, play, vibrate, isMuted, setMuted, audioContext, SOUNDBOARD } from './sfx.js';
import { loadProfile, saveProfile, randomName, levelInfo, titleFor, AVATARS, recordGame } from './profile.js';
import { GAMES, GAME_LIST } from './games/index.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const REACTIONS = ['😂', '💀', '🔥', '😭', '🤡', '😤', '👑', '🫡', '💩', '🤯', '😈', '🙏', '👀', '🥶', '🧂', '🐐', '❤️', '🖕'];
const QUICK = ['gg ez 😎', 'skill issue', 'I let you win', 'rematch. NOW.', 'bro what 💀', 'LAG 😤', 'one more game', 'ur cooked', 'that was luck', 'touch grass', 'nah ur hacking', 'im so back'];
const WIN_ROASTS = ['Absolutely diabolical.', 'Someone call an ambulance… not for the winner.', 'Rent free in their head now.', 'Built different.', 'Victory royale (unofficial).', 'Mom, come pick me up, I\'m scared.'];
const LOSE_ROASTS = ['Skill issue detected. 🧂', 'Have you tried being better?', 'Uninstall? No. Rematch.', 'That was painful to watch. 💀', 'Bro got cooked.', 'L + ratio + rematch'];

const profile = loadProfile();
let room = null;
let voice = null;
let current = null;      // running game: { def, api, inputH, stateH, cleanups, meta }
let lastGameId = null;
let unread = 0;
let lastSb = 0;

// ---------------------------------------------------------------- profile UI
function lvl() { return levelInfo(profile.xp); }

function renderProfile() {
  const li = lvl();
  $('#avatarBtn').textContent = profile.avatar;
  $('#nameInput').value = profile.name;
  $('#lvlLabel').textContent = `LV ${li.level}`;
  $('#titleLabel').textContent = titleFor(li.level);
  $('#xpFill').style.width = `${(li.into / li.need) * 100}%`;
  $('#xpText').textContent = `${li.into} / ${li.need} XP${profile.streak > 1 ? ` · 🔥 ${profile.streak} win streak` : ''}`;
  $('#muteBtn').textContent = isMuted() ? '🔇 Sound off' : '🔊 Sound on';
  renderStats();
}

function renderPicker() {
  const level = lvl().level;
  $('#avatarPicker').innerHTML = AVATARS.map(([e, lv]) =>
    `<button data-e="${e}" data-lvl="LV${lv}" class="${lv > level ? 'locked' : ''} ${e === profile.avatar ? 'sel' : ''}">${e}</button>`).join('');
}

function renderStats() {
  const rows = GAME_LIST.map((g) => {
    const s = profile.games[g.id] || { played: 0, won: 0 };
    return `<tr><td>${g.emoji} ${g.title}</td><td>${s.played}</td><td>${s.won}</td><td>${s.played ? Math.round((s.won / s.played) * 100) : 0}%</td></tr>`;
  }).join('');
  const rivals = Object.entries(profile.rivals).sort((a, b) => (b[1].w + b[1].l) - (a[1].w + a[1].l)).slice(0, 10)
    .map(([n, r]) => `<tr><td>${esc(n)}</td><td>${r.w}</td><td>${r.l}</td><td>${r.w > r.l ? '😎 owns them' : r.w < r.l ? '😰 your nemesis' : '⚔️ even'}</td></tr>`).join('');
  $('#statsBody').innerHTML = `<table><tr><th>Game</th><th>Played</th><th>Won</th><th>Win%</th></tr>${rows}</table>`
    + (rivals ? `<table><tr><th>Rival</th><th>W</th><th>L</th><th></th></tr>${rivals}</table>` : '<p class="hint">Play friends to build rivalries.</p>');
}

$('#avatarBtn').onclick = () => { renderPicker(); $('#avatarPicker').classList.toggle('hidden'); sfx.pop(); };
$('#avatarPicker').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.classList.contains('locked')) { toast(`🔒 Unlocks at ${b.dataset.lvl}. Go win some games!`); sfx.wrong(); return; }
  profile.avatar = b.dataset.e;
  saveProfile(profile);
  $('#avatarPicker').classList.add('hidden');
  renderProfile();
  sfx.coin();
};
$('#nameInput').oninput = (e) => { profile.name = e.target.value.slice(0, 16) || randomName(); saveProfile(profile); };
$('#diceBtn').onclick = () => { profile.name = randomName(); saveProfile(profile); renderProfile(); sfx.boing(); };
$('#muteBtn').onclick = () => { setMuted(!isMuted()); renderProfile(); sfx.click(); };

// ---------------------------------------------------------------- toasts/floaters
function toast(html, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = html;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
  while ($('#toasts').children.length > 4) $('#toasts').firstElementChild.remove();
}

function floatEmoji(e, label) {
  const f = document.createElement('div');
  f.className = 'floater';
  f.style.left = `${8 + Math.random() * 78}%`;
  f.innerHTML = `${esc(e)}<small>${esc(label)}</small>`;
  $('#floaters').append(f);
  setTimeout(() => f.remove(), 2700);
}

// ---------------------------------------------------------------- join / create
function netUser() {
  const li = lvl();
  return { name: profile.name.trim() || randomName(), avatar: profile.avatar, level: li.level, title: titleFor(li.level) };
}

async function enterRoom(action) {
  audioContext(); // unlock audio inside the tap
  if (typeof Peer === 'undefined') { $('#homeMsg').textContent = 'Networking library failed to load. Refresh?'; return; }
  $('#createBtn').disabled = $('#joinBtn').disabled = true;
  $('#homeMsg').textContent = action === 'host' ? 'Opening room…' : 'Knocking on the door…';
  const r = new Room(netUser());
  r.gameDefs = GAMES;
  try {
    if (action === 'host') await r.host();
    else await r.join($('#codeInput').value);
  } catch (e) {
    $('#homeMsg').textContent = `😬 ${e.message}`;
    sfx.wrong();
    $('#createBtn').disabled = $('#joinBtn').disabled = false;
    return;
  }
  room = r;
  wireRoom();
  $('#homeMsg').textContent = '';
  $('#createBtn').disabled = $('#joinBtn').disabled = false;
  $('#home').classList.add('hidden');
  $('#room').classList.remove('hidden');
  $('#codeLabel').textContent = $('#bigCode').textContent = room.code;
  history.replaceState(null, '', `?room=${room.code}`);
  $('#chatLog').innerHTML = '';
  sysMsg(room.isHost ? `Room ${room.code} is open. Share the code!` : `Joined room ${room.code} 🎉`);
  sfx.win();
  renderLobby();
}

$('#createBtn').onclick = () => enterRoom('host');
$('#joinBtn').onclick = () => enterRoom('join');
$('#codeInput').onkeydown = (e) => { if (e.key === 'Enter') enterRoom('join'); };
$('#codeInput').oninput = (e) => {
  // Codes never contain 0/O/1/I/L, so drop anything that can't be in one.
  const v = e.target.value.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ2-9]/g, '');
  if (v !== e.target.value) e.target.value = v;
};

function exitRoom(msg) {
  endGame();
  voice?.destroy();
  voice = null;
  room?.leave();
  room = null;
  closeDrawers();
  $('#result').classList.add('hidden');
  $('#room').classList.add('hidden');
  $('#home').classList.remove('hidden');
  $('#audioUnlock').classList.add('hidden');
  updateMic();
  history.replaceState(null, '', location.pathname);
  $('#homeMsg').textContent = msg || '';
  renderProfile();
}

$('#leaveBtn').onclick = async () => { if (await askConfirm('Leave the room?')) exitRoom(); };

async function shareInvite() {
  // Opened from a file? A file:// link is useless to a friend, so invite them to the live site.
  const base = location.protocol === 'file:' ? 'https://subtoferalsloth11.github.io/squad-arcade/' : `${location.origin}${location.pathname}`;
  const url = `${base}?room=${room.code}`;
  const text = `Join my Squad Arcade room! Code: ${room.code}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Squad Arcade', text, url }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('📋 Invite link copied!'); } catch { toast(`Code: <b>${room.code}</b>`); }
}
$('#shareBtn').onclick = shareInvite;
$('#codeChip').onclick = shareInvite;

// ---------------------------------------------------------------- room events
function wireRoom() {
  voice = new Voice(room, {
    onChange: updateMic,
    onSpeaking: (set) => document.querySelectorAll('.pchip').forEach((el) => el.classList.toggle('speaking', set.has(el.dataset.id))),
    onAutoplayBlocked: () => $('#audioUnlock').classList.remove('hidden'),
  });
  room.on('lobby', () => { renderLobby(); });
  room.on('sys', (m) => { sysMsg(m.text); toast(esc(m.text)); });
  room.on('chat', (m) => onChat(m));
  room.on('react', (m) => { const p = room.player(m.from); floatEmoji(m.e, p ? p.name : ''); sfx.pop(); });
  room.on('sb', (m) => {
    const p = room.player(m.from);
    const sb = SOUNDBOARD.find((s) => s[2] === m.s);
    if (!sb) return;
    play(m.s);
    toast(`${sb[0]} <b>${esc(p ? p.name : '?')}</b> played ${sb[1]}`, 1800);
  });
  room.on('start', (m) => startGame(m));
  room.on('gst', (m) => { if (current) for (const fn of current.stateH) fn(m.d); });
  room.on('ginput', (from, d) => { if (current) for (const fn of current.inputH) fn(from, d); });
  room.on('over', (m) => showResult(m));
  room.on('abort', (m) => { endGame(); renderLobby(); toast(esc(m.text)); sfx.dundun(); sysMsg(m.text); });
  room.on('full', () => exitRoom('That room is full (8 max) 😭'));
  room.on('hostleft', () => exitRoom('The host left — room closed. 👋'));
}

function renderLobby() {
  if (!room) return;
  const strip = room.players.map((p) =>
    `<button class="pchip avatar" data-id="${esc(p.id)}" style="border-color:${p.color}" title="${esc(p.name)}">${esc(p.avatar)}${p.voice ? '<span class="mic">🎙️</span>' : ''}</button>`).join('');
  $('#playerStrip').innerHTML = strip;
  if (voice) document.querySelectorAll('.pchip').forEach((el) => el.classList.toggle('speaking', voice.speaking.has(el.dataset.id)));
  $('#inviteCard').classList.toggle('hidden', room.players.length > 1);
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  $('#scoreboard').innerHTML = sorted.map((p, i) => `<div class="sbrow">
      <span class="avatar pchip" style="border-color:${p.color}">${esc(p.avatar)}</span>
      <span class="nm">${i === 0 && p.score > 0 ? '👑 ' : ''}${esc(p.name)}${p.id === room.id ? ' (you)' : ''}<br><span class="lv">LV ${p.level} · ${esc(p.title || '')}</span></span>
      <span class="sc">${p.score}</span></div>`).join('');
  const n = room.players.length;
  $('#gameGrid').innerHTML = GAME_LIST.map((g) => {
    const s = profile.games[g.id];
    return `<button class="gcard ${n < g.min ? 'disabled' : ''}" data-g="${g.id}" style="background:linear-gradient(160deg, ${g.color}, ${g.color}99)">
      <span class="ge">${g.emoji}</span><span class="gt">${g.title}</span><span class="gb">${g.blurb}</span>
      <span class="gm"><span>👥 ${g.min === g.max ? g.min : `${g.min}-${g.max}`}</span><span>${s ? `🏆 ${s.won}/${s.played}` : 'NEW'}</span></span></button>`;
  }).join('');
}

$('#gameGrid').onclick = (e) => {
  const b = e.target.closest('.gcard');
  if (!b || !room) return;
  const g = GAMES[b.dataset.g];
  if (room.players.length < g.min) { toast(`Need ${g.min}+ players. Invite your friend! 📤`); sfx.wrong(); return; }
  if (room.game) {
    const running = GAMES[room.game.id];
    toast(`⏳ ${running ? running.title : 'A game'} is in progress — you're in the next one!`);
    return;
  }
  sfx.click();
  room.send({ t: 'start', game: g.id });
};

// ---------------------------------------------------------------- chat
function sysMsg(text) {
  const d = document.createElement('div');
  d.className = 'cmsg sys';
  d.textContent = text;
  appendChat(d);
}

function appendChat(el) {
  const log = $('#chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(el);
  while (log.children.length > 200) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function onChat(m) {
  const p = room.player(m.from);
  const d = document.createElement('div');
  d.className = `cmsg ${m.from === room.id ? 'mine' : ''}`;
  d.innerHTML = `<b style="color:${p ? p.color : '#fff'}">${esc(p ? `${p.avatar} ${p.name}` : '???')}</b>${esc(m.text)}`;
  appendChat(d);
  if (m.from !== room.id) {
    if ($('#chatDrawer').classList.contains('hidden')) {
      unread++;
      $('#chatBadge').textContent = unread;
      $('#chatBadge').classList.remove('hidden');
      toast(`💬 <b>${esc(p ? p.name : '?')}</b>: ${esc(m.text)}`, 3200);
    }
    sfx.pop();
  }
}

$('#quickLines').innerHTML = QUICK.map((q) => `<button>${esc(q)}</button>`).join('');
$('#quickLines').onclick = (e) => { const b = e.target.closest('button'); if (b) room?.send({ t: 'chat', text: b.textContent }); };
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text || !room) return;
  room.send({ t: 'chat', text });
  $('#chatInput').value = '';
};

// ---------------------------------------------------------------- drawers
const DRAWERS = ['chatDrawer', 'reactDrawer', 'sbDrawer'];
function closeDrawers() { for (const d of DRAWERS) $(`#${d}`).classList.add('hidden'); }
function toggleDrawer(id) {
  const open = $(`#${id}`).classList.contains('hidden');
  closeDrawers();
  $('#room').style.setProperty('--dock-h', `${$('.dock').offsetHeight}px`);
  if (open) $(`#${id}`).classList.remove('hidden');
  if (id === 'chatDrawer' && open) {
    unread = 0;
    $('#chatBadge').classList.add('hidden');
    $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  }
}
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => $(`#${b.dataset.close}`).classList.add('hidden'); });
$('#chatBtn').onclick = () => toggleDrawer('chatDrawer');
$('#reactBtn').onclick = () => toggleDrawer('reactDrawer');
$('#sbBtn').onclick = () => toggleDrawer('sbDrawer');

$('#reactGrid').innerHTML = REACTIONS.map((e) => `<button>${e}</button>`).join('');
$('#reactGrid').onclick = (e) => { const b = e.target.closest('button'); if (b) room?.send({ t: 'react', e: b.textContent }); };
$('#sbGrid').innerHTML = SOUNDBOARD.map(([e, label, id]) => `<button data-s="${id}">${e}<span>${label}</span></button>`).join('');
$('#sbGrid').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || !room) return;
  if (Date.now() - lastSb < 700) return;
  lastSb = Date.now();
  room.send({ t: 'sb', s: b.dataset.s });
};

// ---------------------------------------------------------------- voice
function updateMic() {
  const st = voice ? voice.state : 'off';
  $('#micBtn').classList.toggle('live', st === 'live');
  $('#micBtn').classList.toggle('muted', st === 'muted');
  $('#micBtn').firstChild.textContent = st === 'muted' ? '🔇' : '🎙️';
  $('#micLabel').textContent = st === 'off' ? 'Voice' : st === 'live' ? 'Live' : 'Muted';
}

$('#micBtn').onclick = async () => {
  if (!voice) return;
  if (voice.state === 'off') {
    $('#micLabel').textContent = '…';
    try {
      await voice.enable();
      toast('🎙️ You\'re live! Everyone in the room can hear you.');
      sfx.ding();
    } catch (e) {
      toast(`🎙️ Mic blocked: ${esc(e.message || e.name)}. Allow microphone access in your browser settings.`, 4500);
      updateMic();
    }
  } else voice.toggleMute();
};
$('#audioUnlock').onclick = () => { voice?.resumeAudio(); $('#audioUnlock').classList.add('hidden'); };

// ---------------------------------------------------------------- game runner
function startGame(m) {
  endGame();
  closeDrawers();
  $('#result').classList.add('hidden');
  const def = GAMES[m.game.id];
  if (!def) return;
  lastGameId = def.id;
  const el = $('#game');
  el.innerHTML = '';
  el.classList.remove('hidden');
  $('#lobby').classList.add('hidden');
  const inputH = [], stateH = [], cleanups = [];
  const players = m.game.players.map((id) => room.player(id)).filter(Boolean).map((p) => ({ ...p }));
  const spectator = !m.game.players.includes(room.id);
  $('#quitGameBtn').classList.toggle('hidden', spectator);
  const byId = (id) => players.find((p) => p.id === id) || room.player(id) || { name: '???', avatar: '❔', color: '#888' };
  const api = {
    me: room.id,
    isHost: room.isHost,
    players,
    spectator,
    el,
    send: (d) => room.send({ t: 'gin', d }),
    broadcast: (d) => room.broadcast({ t: 'gst', d }),
    sendTo: (id, d) => room.sendTo(id, { t: 'gst', d }),
    onInput: (fn) => inputH.push(fn),
    onState: (fn) => stateH.push(fn),
    finish: (winners, text = '') => { if (room.isHost) room.send({ t: 'over', winners, text }); },
    after: (ms, fn) => { const t = setTimeout(fn, ms); cleanups.push(() => clearTimeout(t)); return t; },
    every: (ms, fn) => { const t = setInterval(fn, ms); cleanups.push(() => clearInterval(t)); return t; },
    loop: (fn) => {
      let last = performance.now();
      let id = 0;
      const tick = (t) => { fn(Math.min(0.05, (t - last) / 1000), t); last = t; id = requestAnimationFrame(tick); };
      id = requestAnimationFrame(tick);
      cleanups.push(() => cancelAnimationFrame(id));
    },
    listen: (target, ev, fn, opt) => { target.addEventListener(ev, fn, opt); cleanups.push(() => target.removeEventListener(ev, fn, opt)); },
    onCleanup: (fn) => cleanups.push(fn),
    name: (id) => byId(id).name,
    avatar: (id) => byId(id).avatar,
    color: (id) => byId(id).color,
    tag: (id) => `<b style="color:${byId(id).color}">${esc(byId(id).avatar)} ${esc(byId(id).name)}</b>`,
    esc,
    sfx,
    vibrate,
    toast,
    shake: () => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); },
  };
  current = { def, api, inputH, stateH, cleanups };
  def.start(api);
  if (spectator) toast('👀 Game is full — you\'re spectating this one');
}

function endGame() {
  if (!current) return;
  for (const fn of current.cleanups) { try { fn(); } catch (e) { console.error(e); } }
  current = null;
  $('#game').innerHTML = '';
  $('#game').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  $('#quitGameBtn').classList.add('hidden');
}

$('#quitGameBtn').onclick = async () => { if (await askConfirm('End this game for everyone?')) room?.send({ t: 'quit' }); };

// In-page confirm: window.confirm() is silently blocked in many in-app browsers.
function askConfirm(text) {
  return new Promise((resolve) => {
    $('#confirmText').textContent = text;
    $('#confirm').classList.remove('hidden');
    const done = (v) => { $('#confirm').classList.add('hidden'); resolve(v); };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}

function showResult(m) {
  const wasPlaying = current && !current.api.spectator;
  const players = current ? current.api.players : [];
  endGame();
  renderLobby();
  const winners = m.winners || [];
  const iWon = winners.includes(room.id);
  const draw = winners.length === 0;
  const names = winners.map((id) => room.player(id)?.name || '???');
  $('#resultEmoji').textContent = draw ? '🤝' : iWon ? '🏆' : wasPlaying ? '💀' : '🎉';
  $('#resultTitle').textContent = draw ? 'DRAW!' : iWon ? (winners.length > 1 ? 'YOU (ALL) WIN!' : 'YOU WIN!') : `${names.join(' & ')} WINS`;
  $('#resultText').textContent = m.text || '';
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  $('#resultRoast').textContent = draw ? 'Nobody wins. Everybody loses. Beautiful.' : iWon ? pick(WIN_ROASTS) : wasPlaying ? pick(LOSE_ROASTS) : '';
  if (wasPlaying) {
    const opponents = players.filter((p) => p.id !== room.id).map((p) => p.name);
    const r = recordGame(profile, m.game.id, iWon, draw, opponents);
    $('#resultXp').innerHTML = `<b>+${r.xp} XP</b><br>${r.lines.map(esc).join('<br>')}`
      + (r.levelUp ? `<span class="up">⬆️ LEVEL ${r.levelUp}! "${esc(titleFor(r.levelUp))}"</span>` : '')
      + (r.unlocked.length ? `<span class="up">🔓 Unlocked avatar ${r.unlocked.join(' ')}</span>` : '');
    if (r.levelUp) room.send({ t: 'me', level: r.levelUp, title: titleFor(r.levelUp) });
    $('#resultXp').classList.remove('hidden');
  } else $('#resultXp').classList.add('hidden');
  $('#result').classList.remove('hidden');
  if (draw) sfx.honk();
  else if (iWon) { sfx.win(); vibrate([60, 40, 60, 40, 200]); }
  else if (wasPlaying) sfx.lose();
  else sfx.ding();
}

$('#rematchBtn').onclick = () => {
  $('#result').classList.add('hidden');
  if (!room || !lastGameId) return;
  if (room.players.length < GAMES[lastGameId].min) { toast('Not enough players for a rematch 😢'); return; }
  room.send({ t: 'start', game: lastGameId });
};
$('#lobbyBtn').onclick = () => $('#result').classList.add('hidden');

// ---------------------------------------------------------------- boot
const qp = new URLSearchParams(location.search).get('room');
if (qp) {
  $('#codeInput').value = qp.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  $('#homeMsg').textContent = '👆 Pick a name, then tap Join!';
}
renderProfile();
window.addEventListener('beforeunload', () => room?.leave());
// iOS keeps an AudioContext suspended until a tap; resume it on any touch.
window.addEventListener('pointerdown', () => audioContext(), { passive: true });
