// Connect Four with a 20-second shot clock so nobody can stall.
import { h, header } from './util.js';

const COLS = 7;
const ROWS = 6;
const TURN_MS = 20000;
const BRAIN = ['🧠 big brain move', '🤔 interesting choice…', '😬 bold', '🎯 calculated', '🙈 oops?', '🔥 spicy'];

function findWin(b, r, c) {
  const who = b[r * COLS + c];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells = [[r, c]];
    for (const s of [1, -1]) {
      let rr = r + dr * s, cc = c + dc * s;
      while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && b[rr * COLS + cc] === who) { cells.push([rr, cc]); rr += dr * s; cc += dc * s; }
    }
    if (cells.length >= 4) return cells.map(([a, d]) => a * COLS + d);
  }
  return null;
}

export default {
  id: 'connect4',
  title: 'Connect Four',
  emoji: '🔴',
  blurb: 'The classic, with a 20s shot clock. Line up 4 before your friend does.',
  min: 2,
  max: 2,
  color: '#2f9e44',

  start(api) {
    header(api, '🔴 Connect Four');
    const status = h('div', { class: 'status' });
    const board = h('div', { class: 'c4board' });
    api.el.append(status, h('div', { class: 'c4' }, board));
    const cols = [];
    const cells = [];
    for (let c = 0; c < COLS; c++) {
      const col = h('div', { class: 'c4col' });
      for (let r = 0; r < ROWS; r++) { const cell = h('div', { class: 'c4cell' }); col.append(cell); cells[r * COLS + c] = cell; }
      api.listen(col, 'pointerenter', (e) => { if (e.pointerType === 'mouse') col.classList.add('hover'); });
      api.listen(col, 'pointerleave', () => col.classList.remove('hover'));
      api.listen(col, 'click', () => { if (myTurn()) api.send({ col: c }); });
      board.append(col);
      cols.push(col);
    }

    let st = null;
    let deadline = 0;
    const myTurn = () => st && !st.win && !st.draw && st.turn === api.me;
    const colorOf = (v) => (v ? api.players[v - 1].color : '');

    const renderStatus = () => {
      if (!st) return;
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (st.win || st.draw) return;
      status.innerHTML = myTurn()
        ? `🫵 <b>Your move</b> · ⏱️ ${secs}s`
        : `${api.tag(st.turn)} is thinking… ⏱️ ${secs}s${st.note ? ` · ${api.esc(st.note)}` : ''}`;
    };
    api.every(250, renderStatus);

    api.onState((s) => {
      st = s;
      deadline = Date.now() + (s.ms || 0);
      s.b.forEach((v, i) => {
        const cell = cells[i];
        cell.className = `c4cell ${v ? `p${v}` : ''}`;
        cell.style.background = v ? colorOf(v) : '';
      });
      if (s.last != null) {
        cells[s.last].classList.add('drop');
        api.sfx.pop();
        api.vibrate(15);
      }
      for (const i of s.win || []) cells[i].classList.add('win');
      board.style.opacity = myTurn() || s.win || s.draw ? 1 : 0.85;
      if (s.win) status.innerHTML = `${api.tag(s.winner)} connects four! 🎉`;
      else if (s.draw) status.textContent = 'Board full. Nobody wins. 🫠';
      else if (s.timeout) api.toast(`⏰ ${api.esc(api.name(s.timeout))} took too long — random drop!`);
      if (myTurn()) api.sfx.beep();
      renderStatus();
    });

    if (!api.isHost) return;

    // ---------------- host ----------------
    const ids = api.players.map((p) => p.id);
    const b = new Array(COLS * ROWS).fill(0);
    let turn = Math.random() < 0.5 ? 0 : 1;
    let token = 0;
    let over = false;
    const later = (ms, fn) => { const k = token; api.after(ms, () => { if (k === token) fn(); }); };

    const push = (extra = {}) => api.broadcast({ b, turn: ids[turn], ms: TURN_MS, ...extra });

    const drop = (c, timeout) => {
      let r = ROWS - 1;
      while (r >= 0 && b[r * COLS + c]) r--;
      if (r < 0) return false;
      token++;
      b[r * COLS + c] = turn + 1;
      const win = findWin(b, r, c);
      const last = r * COLS + c;
      if (win) {
        over = true;
        push({ last, win, winner: ids[turn] });
        const w = ids[turn];
        later(2500, () => api.finish([w], 'Four in a row. Cleanest W in history.'));
        return true;
      }
      if (b.every((v) => v)) {
        over = true;
        push({ last, draw: true });
        later(2500, () => api.finish([], 'The board is full. Both of you lost, honestly.'));
        return true;
      }
      const mover = ids[turn];
      turn = 1 - turn;
      push({ last, note: BRAIN[Math.floor(Math.random() * BRAIN.length)], timeout: timeout ? mover : null });
      later(TURN_MS, randomDrop);
      return true;
    };

    const randomDrop = () => {
      if (over) return;
      const open = [...Array(COLS).keys()].filter((c) => !b[c]);
      drop(open[Math.floor(Math.random() * open.length)], true);
    };

    api.onInput((from, d) => {
      if (over || from !== ids[turn]) return;
      const c = Number(d?.col);
      if (Number.isInteger(c) && c >= 0 && c < COLS) drop(c, false);
    });

    push();
    later(TURN_MS, randomDrop);
  },
};
