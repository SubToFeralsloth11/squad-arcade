// Light Cycles: leave a glowing trail, make everyone else crash into it.
import { h, makeCanvas, header, leaders, emoji } from './util.js';

const W = 30;
const H = 42;
const SPAWNS = [[0.35, 0.9, 0], [0.65, 0.1, 2], [0.07, 0.35, 1], [0.93, 0.65, 3], [0.07, 0.65, 1], [0.93, 0.35, 3]];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const CRASH = ['ate the wall 🧱', 'forgot how to turn 💀', 'got boxed in 📦', 'crashed and burned 🔥', 'speedran a loss 🏃', 'is now a pancake 🥞'];

export default {
  id: 'tron',
  title: 'Light Cycles',
  emoji: '🏍️',
  blurb: 'Swipe to steer. Trap your friends with your trail. It gets FAST.',
  min: 2,
  max: 6,
  color: '#0c8599',

  start(api) {
    const target = api.players.length === 2 ? 5 : 3;
    const setScores = header(api, `🏍️ First to ${target}`);
    const status = h('div', { class: 'status' }, 'Get ready…');
    api.el.append(status);
    const view = makeCanvas(api, api.el, W / H);
    const center = h('div', { class: 'center-msg' });
    view.c.parentElement.append(center);
    const pad = h('div', { class: 'dpad' });
    const dirs = [['u', '⬆️', 0], ['l', '⬅️', 3], ['d', '⬇️', 2], ['r', '➡️', 1]];
    for (const [cls, label, d] of dirs) {
      const b = h('button', { class: cls }, label);
      api.listen(b, 'pointerdown', (e) => { e.preventDefault(); steer(d); });
      pad.append(b);
    }
    if (!api.spectator) api.el.append(pad);

    const myIdx = api.players.findIndex((p) => p.id === api.me);
    let grid = new Int8Array(W * H);  // 0 empty, else player index + 1
    let heads = [];
    let alive = [];
    let running = false;
    let countdownEnd = 0;
    let flash = [];

    function steer(d) {
      if (api.spectator) return;
      api.send({ d });
    }

    // Swipe anywhere on the board.
    let sx = 0, sy = 0, swiping = false;
    api.listen(view.c, 'pointerdown', (e) => { swiping = true; sx = e.clientX; sy = e.clientY; });
    api.listen(view.c, 'pointermove', (e) => {
      if (!swiping) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.hypot(dx, dy) < 24) return;
      steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
      sx = e.clientX; sy = e.clientY;
    });
    api.listen(view.c, 'pointerup', () => { swiping = false; });
    api.listen(window, 'keydown', (e) => {
      const k = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 }[e.code];
      if (k != null) { e.preventDefault(); steer(k); }
    });

    api.loop(() => {
      const { ctx } = view;
      const cs = view.w / W;
      ctx.fillStyle = '#07061a';
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.strokeStyle = '#ffffff0d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x++) { ctx.moveTo(x * cs, 0); ctx.lineTo(x * cs, view.h); }
      for (let y = 0; y <= H; y++) { ctx.moveTo(0, y * cs); ctx.lineTo(view.w, y * cs); }
      ctx.stroke();
      for (let i = 0; i < grid.length; i++) {
        const o = grid[i];
        if (!o) continue;
        ctx.fillStyle = api.players[o - 1].color;
        ctx.globalAlpha = alive[o - 1] ? 0.85 : 0.3;
        ctx.fillRect((i % W) * cs + 1, Math.floor(i / W) * cs + 1, cs - 2, cs - 2);
      }
      ctx.globalAlpha = 1;
      heads.forEach(([x, y], i) => {
        if (!alive[i]) return;
        ctx.shadowColor = api.players[i].color;
        ctx.shadowBlur = cs * 1.2;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x * cs, y * cs, cs, cs);
        ctx.shadowBlur = 0;
        if (!running || i === myIdx) emoji(ctx, api.players[i].avatar, x * cs + cs / 2, y * cs - cs * (i === myIdx && !running ? 1.6 : 0.9), cs * (i === myIdx && !running ? 2 : 1.2));
      });
      const now = performance.now();
      flash = flash.filter((f) => now - f.t < 600);
      for (const f of flash) {
        const k = (now - f.t) / 600;
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#ffd43b';
        ctx.beginPath();
        ctx.arc((f.x + 0.5) * cs, (f.y + 0.5) * cs, cs * (1 + k * 4), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (countdownEnd) {
        const left = Math.ceil((countdownEnd - Date.now()) / 1000);
        center.textContent = left > 0 ? String(left) : '';
        if (left <= 0) countdownEnd = 0;
      }
    });

    api.onState((s) => {
      if (s.scores) setScores(s.scores);
      if (s.k === 'r') {
        grid = new Int8Array(W * H);
        heads = s.spawns.map(([x, y]) => [x, y]);
        alive = s.spawns.map(() => true);
        heads.forEach(([x, y], i) => { grid[y * W + x] = i + 1; });
        running = false;
        countdownEnd = Date.now() + s.wait;
        status.innerHTML = myIdx >= 0 ? `Round ${s.round} — you're <b style="color:${api.players[myIdx].color}">this colour</b> ${api.esc(api.players[myIdx].avatar)}` : `Round ${s.round}`;
        api.sfx.beep();
      } else if (s.k === 't') {
        if (!running) { running = true; center.textContent = ''; api.sfx.go(); }
        s.h.forEach((p, i) => {
          if (!p) return;
          heads[i] = p;
          grid[p[1] * W + p[0]] = i + 1;
        });
        for (const i of s.dead || []) {
          alive[i] = false;
          flash.push({ x: heads[i][0], y: heads[i][1], t: performance.now() });
          const pl = api.players[i];
          status.innerHTML = `💥 ${api.tag(pl.id)} ${api.esc(s.msg)}`;
          if (i === myIdx) { api.sfx.boom(); api.vibrate(300); api.shake(); } else api.sfx.hit();
        }
      } else if (s.k === 'e') {
        running = false;
        if (s.winner) {
          center.textContent = s.winner === api.me ? '🏆' : api.avatar(s.winner);
          status.innerHTML = `${api.tag(s.winner)} survives the round!`;
          if (s.winner === api.me) api.sfx.coin();
        } else { center.textContent = '🤝'; status.textContent = 'Everybody died. Beautiful.'; }
      }
    });

    if (!api.isHost) return;

    // ---------------- host ----------------
    const ids = api.players.map((p) => p.id);
    const n = ids.length;
    const scores = Object.fromEntries(ids.map((id) => [id, 0]));
    let hGrid, hHeads, hDir, hAlive, queues, ticks, round = 0, token = 0;
    const later = (ms, fn) => { const k = token; api.after(ms, () => { if (k === token) fn(); }); };

    const newRound = () => {
      token++;
      round++;
      hGrid = new Uint8Array(W * H);
      hHeads = []; hDir = []; hAlive = []; queues = [];
      ticks = 0;
      for (let i = 0; i < n; i++) {
        const [fx, fy, d] = SPAWNS[i];
        const x = Math.round(fx * (W - 1)), y = Math.round(fy * (H - 1));
        hHeads.push([x, y]); hDir.push(d); hAlive.push(true); queues.push([]);
        hGrid[y * W + x] = 1;
      }
      api.broadcast({ k: 'r', round, wait: 3000, spawns: hHeads.map(([x, y], i) => [x, y, hDir[i]]), scores });
      later(3000, tick);
    };

    const tick = () => {
      ticks++;
      const next = [];
      for (let i = 0; i < n; i++) {
        if (!hAlive[i]) { next.push(null); continue; }
        const q = queues[i];
        while (q.length) {
          const d = q.shift();
          if (d !== hDir[i] && (d + 2) % 4 !== hDir[i]) { hDir[i] = d; break; }
        }
        next.push([hHeads[i][0] + DX[hDir[i]], hHeads[i][1] + DY[hDir[i]]]);
      }
      const dead = [];
      next.forEach((p, i) => {
        if (!p) return;
        const [x, y] = p;
        const out = x < 0 || y < 0 || x >= W || y >= H;
        const headOn = next.some((o, j) => j !== i && o && o[0] === x && o[1] === y);
        if (out || headOn || hGrid[y * W + x]) dead.push(i);
      });
      const moved = next.map((p, i) => (p && !dead.includes(i) ? p : null));
      moved.forEach((p, i) => { if (p) { hHeads[i] = p; hGrid[p[1] * W + p[0]] = 1; } });
      for (const i of dead) hAlive[i] = false;
      api.broadcast({ k: 't', h: moved, dead, msg: dead.length ? CRASH[Math.floor(Math.random() * CRASH.length)] : '' });
      const left = hAlive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
      if (left.length <= 1) {
        token++;
        const winner = left.length === 1 ? ids[left[0]] : null;
        if (winner) scores[winner]++;
        api.broadcast({ k: 'e', winner, scores });
        const top = leaders(scores);
        if (top.length === 1 && scores[top[0]] >= target) later(2200, () => api.finish(top, 'Undisputed lord of the grid 🏍️'));
        else later(2500, newRound);
        return;
      }
      const speed = Math.max(55, 115 - Math.floor(ticks / 12) * 3);
      later(speed, tick);
    };

    api.onInput((from, d) => {
      const i = ids.indexOf(from);
      if (i < 0 || !queues || typeof d?.d !== 'number' || d.d < 0 || d.d > 3) return;
      if (queues[i].length < 3) queues[i].push(d.d | 0);
    });

    newRound();
  },
};
