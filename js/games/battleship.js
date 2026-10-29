// Battleship: shuffle your fleet, then take turns firing. A hit lets you fire again.
import { h, header } from './util.js';

const N = 8;
const SHIPS = [4, 3, 3, 2, 2];
const TURN_MS = 30000;
const HIT_LINES = ['💥 DIRECT HIT', '🎯 Bullseye!', '🔥 Got one!', '😈 Boom.'];
const MISS_LINES = ['🌊 Splash…', '🐟 You hit a fish', '💧 Nothing but water', '🦀 The crab says no'];

function randomFleet() {
  for (;;) {
    const taken = new Set();
    const fleet = [];
    let ok = true;
    for (const len of SHIPS) {
      let placed = false;
      for (let t = 0; t < 200 && !placed; t++) {
        const horiz = Math.random() < 0.5;
        const r = Math.floor(Math.random() * (horiz ? N : N - len + 1));
        const c = Math.floor(Math.random() * (horiz ? N - len + 1 : N));
        const cells = Array.from({ length: len }, (_, k) => (horiz ? r * N + c + k : (r + k) * N + c));
        if (cells.some((x) => taken.has(x))) continue;
        cells.forEach((x) => taken.add(x));
        fleet.push(cells);
        placed = true;
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return fleet;
  }
}

function validFleet(f) {
  if (!Array.isArray(f) || f.length !== SHIPS.length) return false;
  const lens = f.map((s) => (Array.isArray(s) ? s.length : 0)).sort((a, b) => b - a);
  if (lens.join() !== [...SHIPS].sort((a, b) => b - a).join()) return false;
  const seen = new Set();
  for (const ship of f) {
    if (!ship.every((x) => Number.isInteger(x) && x >= 0 && x < N * N && !seen.has(x))) return false;
    ship.forEach((x) => seen.add(x));
    const s = [...ship].sort((a, b) => a - b);
    const horiz = s.every((x, i) => i === 0 || (x === s[i - 1] + 1 && Math.floor(x / N) === Math.floor(s[0] / N)));
    const vert = s.every((x, i) => i === 0 || x === s[i - 1] + N);
    if (!horiz && !vert) return false;
  }
  return true;
}

export default {
  id: 'battleship',
  title: 'Battleship',
  emoji: '🚢',
  blurb: 'Hide your fleet, hunt theirs. Hits fire again. Long, tense, salty.',
  min: 2,
  max: 2,
  color: '#1864ab',

  start(api) {
    header(api, '🚢 Battleship');
    const status = h('div', { class: 'status' });
    const wrap = h('div', { class: 'bs' });
    api.el.append(status, wrap);

    // Spectators watch from the first player's side but never see live ship positions.
    const me = api.spectator ? api.players[0].id : api.me;
    const them = api.players.find((p) => p.id !== me);
    let fleet = api.spectator ? [] : randomFleet();
    let locked = false;
    let st = { ph: 'place', ready: {} };
    let deadline = 0;

    const grid = (cls, onTap) => {
      const g = h('div', { class: `bsgrid ${cls}` });
      for (let i = 0; i < N * N; i++) {
        const cell = h('div', { class: 'bscell' });
        if (onTap) cell.addEventListener('click', () => onTap(i));
        g.append(cell);
      }
      return g;
    };

    const render = () => {
      wrap.innerHTML = '';
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (st.ph === 'place') {
        const ready = st.ready[me];
        status.innerHTML = api.spectator ? '👀 Admirals are hiding their fleets…'
          : ready ? `Waiting for ${api.tag(them.id)} to place ships… ⏳` : 'Shuffle until you like your fleet, then lock it in';
        const g = grid('');
        const shipCells = new Set(fleet.flat());
        [...g.children].forEach((c, i) => { if (shipCells.has(i)) c.classList.add('ship'); });
        wrap.append(g);
        if (!locked && !api.spectator) {
          wrap.append(h('div', { class: 'modalbtns' },
            h('button', { class: 'btn secondary', onclick: () => { fleet = randomFleet(); api.sfx.swoosh(); render(); } }, '🔀 Shuffle'),
            h('button', { class: 'btn primary', onclick: () => { locked = true; api.send({ fleet }); api.sfx.ding(); render(); } }, '✅ Ready!')));
        }
        return;
      }
      if (api.spectator && st.fleets) fleet = st.fleets[me];
      const myShots = st.shots[me] || {};
      const theirShots = st.shots[them.id] || {};
      const myTurn = st.turn === api.me && !st.done;
      if (!st.done) {
        status.innerHTML = myTurn ? `🎯 <b>Your shot!</b> Tap enemy waters · ⏱️ ${secs}s` : `${api.tag(st.turn)} is aiming… ⏱️ ${secs}s`;
      }
      const enemy = grid(myTurn ? 'armed' : '', (i) => { if (myTurn && !myShots[i]) api.send({ shot: i }); });
      const sunkThem = new Set((st.sunk[them.id] || []).flat());
      [...enemy.children].forEach((c, i) => {
        if (myShots[i] === 'h') { c.classList.add(sunkThem.has(i) ? 'sunk' : 'hit'); c.textContent = sunkThem.has(i) ? '☠️' : '💥'; }
        else if (myShots[i] === 'm') { c.classList.add('miss'); c.textContent = '·'; }
        else if (st.fleets && st.fleets[them.id]?.flat().includes(i)) c.classList.add('ship');
        if (st.last?.by === me && st.last.idx === i) c.classList.add('last');
      });
      const mine = grid('mine');
      const shipCells = new Set(fleet.flat());
      const sunkMine = new Set((st.sunk[me] || []).flat());
      [...mine.children].forEach((c, i) => {
        if (shipCells.has(i)) c.classList.add('ship');
        if (theirShots[i] === 'h') { c.classList.add(sunkMine.has(i) ? 'sunk' : 'hit'); c.textContent = '💥'; }
        else if (theirShots[i] === 'm') { c.classList.add('miss'); c.textContent = '·'; }
        if (st.last?.by === them.id && st.last.idx === i) c.classList.add('last');
      });
      const left = (id) => SHIPS.length - (st.sunk[id] || []).length;
      wrap.append(h('div', { class: 'bslabel' }, `${api.spectator ? api.name(them.id) : 'Enemy waters'} — ${left(them.id)} ships left`), enemy,
        h('div', { class: 'bslabel' }, `${api.spectator ? api.name(me) : 'Your fleet'} — ${left(me)} ships left`), mine);
    };

    api.every(1000, () => { if (st.ph === 'battle' && !st.done) render(); });

    api.onState((s) => {
      const prev = st;
      st = s;
      if (s.ready?.[api.me]) locked = true;
      deadline = Date.now() + (s.ms || 0);
      if (s.ph === 'battle' && prev.ph === 'place') api.sfx.go();
      if (s.last && s.last.seq !== prev.last?.seq) {
        const mineHit = s.last.by !== api.me && !api.spectator;
        if (s.last.res === 'h') {
          api.sfx.boom();
          if (mineHit) { api.vibrate(200); api.shake(); }
          api.toast(s.last.sunk ? `☠️ ${api.esc(api.name(s.last.by))} SANK a ${s.last.sunk}-ship!` : `${api.esc(api.name(s.last.by))}: ${HIT_LINES[s.last.seq % HIT_LINES.length]}`, 1600);
        } else {
          api.sfx.splash();
          if (!mineHit) api.toast(MISS_LINES[s.last.seq % MISS_LINES.length], 1200);
        }
      }
      if (s.done) status.innerHTML = `${api.tag(s.winner)} sank the whole fleet! 🏴‍☠️`;
      render();
    });

    render();
    if (!api.isHost) return;

    // ---------------- host ----------------
    const ids = api.players.map((p) => p.id);
    const fleets = {};
    const shots = Object.fromEntries(ids.map((id) => [id, {}]));
    const sunk = Object.fromEntries(ids.map((id) => [id, []]));
    const ready = {};
    let ph = 'place';
    let turn = null;
    let last = null;
    let seq = 0;
    let token = 0;
    let done = false;
    const later = (ms, fn) => { const k = token; api.after(ms, () => { if (k === token) fn(); }); };
    const other = (id) => ids.find((x) => x !== id);

    const push = (extra = {}) => api.broadcast({ ph, ready, turn, shots, sunk, last, ms: ph === 'battle' ? TURN_MS : 0, ...extra });

    const fire = (by, idx) => {
      if (shots[by][idx]) return;
      token++;
      const target = other(by);
      const ship = fleets[target].find((s) => s.includes(idx));
      shots[by][idx] = ship ? 'h' : 'm';
      let sunkLen = 0;
      if (ship && ship.every((x) => shots[by][x] === 'h')) { sunk[target].push(ship); sunkLen = ship.length; }
      last = { by, idx, res: ship ? 'h' : 'm', sunk: sunkLen, seq: ++seq };
      if (sunk[target].length === SHIPS.length) {
        done = true;
        push({ done: true, winner: by, fleets });
        later(3500, () => api.finish([by], `Sent ${sunk[target].length} ships to Davy Jones 🏴‍☠️`));
        return;
      }
      if (!ship) turn = other(by);
      push();
      later(TURN_MS, autoFire);
    };

    const autoFire = () => {
      if (done || ph !== 'battle') return;
      const open = [...Array(N * N).keys()].filter((i) => !shots[turn][i]);
      fire(turn, open[Math.floor(Math.random() * open.length)]);
    };

    api.onInput((from, d) => {
      if (done) return;
      if (ph === 'place' && d?.fleet && !ready[from] && validFleet(d.fleet)) {
        fleets[from] = d.fleet;
        ready[from] = true;
        if (ids.every((id) => ready[id])) {
          ph = 'battle';
          turn = ids[Math.floor(Math.random() * 2)];
          later(TURN_MS, autoFire);
        }
        push();
      } else if (ph === 'battle' && from === turn && Number.isInteger(d?.shot) && d.shot >= 0 && d.shot < N * N) {
        fire(from, d.shot);
      }
    });

    push();
  },
};
