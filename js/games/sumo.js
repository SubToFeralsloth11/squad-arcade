// Bumper Sumo: shove everyone off a shrinking platform. Drag to move, tap DASH
// to body-slam.
import { h, makeCanvas, header, leaders, emoji } from './util.js';

const R0 = 1;           // starting arena radius
const RMIN = 0.45;     // final arena radius for 2 players; grows with the crowd
const SHRINK_S = 40;    // seconds to shrink from R0 to RMIN
const BR = 0.11;        // bumper radius
const ACCEL = 3.2;
const DASH = 2.6;
const DASH_CD = 1500;
const BOUNCE = 1.5;
const FALL = ['yeeted into the void 🕳️', 'took a swim 🌊', 'did a sick backflip off the edge 🤸', 'got sumo\'d 🍙', 'fell off like my grades 📉'];

export default {
  id: 'sumo',
  title: 'Bumper Sumo',
  emoji: '🍙',
  blurb: 'Shove your friends off a shrinking arena. DASH to body-slam. Last one standing.',
  min: 2,
  max: 8,
  color: '#c2255c',

  start(api) {
    const target = api.players.length === 2 ? 5 : 3;
    const setScores = header(api, `🍙 First to ${target}`);
    const status = h('div', { class: 'status' }, 'Drag to move · DASH to slam');
    api.el.append(status);
    const view = makeCanvas(api, api.el, 1);
    const center = h('div', { class: 'center-msg' });
    view.c.parentElement.append(center);
    const dashBtn = h('button', { class: 'btn primary', style: 'margin:6px auto 10px;display:block;width:70%;font-size:26px' }, '💨 DASH');
    if (!api.spectator) api.el.append(dashBtn);

    const myIdx = api.players.findIndex((p) => p.id === api.me);
    let ps = api.players.map(() => [0, 0, 1, 0]); // x, y, alive, dashing
    let shown = ps.map((p) => [...p]);
    let radius = R0;
    let lastDash = 0;
    let stick = null;   // { ox, oy, x, y } in CSS pixels
    let lastSend = 0;
    let splats = [];

    // ---- input: virtual joystick anywhere on the arena ----
    const sendAxis = (force) => {
      const now = performance.now();
      if (!force && now - lastSend < 50) return;
      lastSend = now;
      let ax = 0, ay = 0;
      if (stick) {
        const dx = stick.x - stick.ox, dy = stick.y - stick.oy;
        const len = Math.hypot(dx, dy);
        const max = 50;
        if (len > 4) { const k = Math.min(1, len / max) / len; ax = dx * k; ay = dy * k; }
      }
      api.send({ a: [Math.round(ax * 100) / 100, Math.round(ay * 100) / 100] });
    };
    api.listen(view.c, 'pointerdown', (e) => {
      if (api.spectator) return;
      view.c.setPointerCapture(e.pointerId);
      stick = { ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      sendAxis(true);
    });
    api.listen(view.c, 'pointermove', (e) => { if (stick) { stick.x = e.clientX; stick.y = e.clientY; sendAxis(false); } });
    const release = () => { stick = null; sendAxis(true); };
    api.listen(view.c, 'pointerup', release);
    api.listen(view.c, 'pointercancel', release);
    const dash = (e) => {
      e?.preventDefault();
      if (performance.now() - lastDash < DASH_CD) return;
      lastDash = performance.now();
      api.send({ dash: true });
      api.sfx.swoosh();
    };
    api.listen(dashBtn, 'pointerdown', dash);
    api.listen(window, 'keydown', (e) => { if (e.code === 'Space' && !e.repeat) dash(e); });

    api.loop(() => {
      const { ctx } = view;
      const s = view.w / 2.4; // world units -> px, world spans -1.2..1.2
      const cx = view.w / 2, cy = view.h / 2;
      for (let i = 0; i < ps.length; i++) for (let j = 0; j < 2; j++) shown[i][j] += (ps[i][j] - shown[i][j]) * 0.5;
      ctx.fillStyle = '#0b0a1f';
      ctx.fillRect(0, 0, view.w, view.h);
      // lava ring
      ctx.fillStyle = '#ff6b2c22';
      ctx.beginPath(); ctx.arc(cx, cy, R0 * s * 1.15, 0, Math.PI * 2); ctx.fill();
      const g = ctx.createRadialGradient(cx, cy, radius * s * 0.2, cx, cy, radius * s);
      g.addColorStop(0, '#f3d9a4');
      g.addColorStop(1, '#d9a75b');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, radius * s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = s * 0.03;
      ctx.stroke();
      ctx.strokeStyle = '#c92a2a';
      ctx.lineWidth = s * 0.012;
      ctx.beginPath(); ctx.arc(cx, cy, radius * s * 0.5, 0, Math.PI * 2); ctx.stroke();
      const now = performance.now();
      splats = splats.filter((sp) => now - sp.t < 900);
      for (const sp of splats) {
        const k = (now - sp.t) / 900;
        ctx.globalAlpha = 1 - k;
        emoji(ctx, '💫', cx + sp.x * s, cy + sp.y * s - k * 40, s * 0.2);
        ctx.globalAlpha = 1;
      }
      api.players.forEach((p, i) => {
        const [, , alive, dashing] = ps[i];
        if (!alive) return;
        const [sx, sy] = shown[i];
        ctx.fillStyle = '#0005';
        ctx.beginPath(); ctx.ellipse(cx + sx * s, cy + sy * s + BR * s * 0.6, BR * s, BR * s * 0.45, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(cx + sx * s, cy + sy * s, BR * s * (dashing ? 1.12 : 1), 0, Math.PI * 2); ctx.fill();
        if (i === myIdx) { ctx.strokeStyle = '#fff'; ctx.lineWidth = s * 0.015; ctx.stroke(); }
        emoji(ctx, p.avatar, cx + sx * s, cy + sy * s, BR * s * 1.25);
      });
      if (stick) {
        const r = view.c.getBoundingClientRect();
        const k = view.w / r.width;
        ctx.strokeStyle = '#ffffff55';
        ctx.lineWidth = 3 * k;
        ctx.beginPath(); ctx.arc((stick.ox - r.left) * k, (stick.oy - r.top) * k, 50 * k, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#ffffff88';
        const dx = stick.x - stick.ox, dy = stick.y - stick.oy, len = Math.hypot(dx, dy), c = len > 50 ? 50 / len : 1;
        ctx.beginPath(); ctx.arc((stick.ox + dx * c - r.left) * k, (stick.oy + dy * c - r.top) * k, 20 * k, 0, Math.PI * 2); ctx.fill();
      }
      const cd = Math.max(0, DASH_CD - (performance.now() - lastDash));
      dashBtn.disabled = cd > 0;
      dashBtn.textContent = cd > 0 ? `💨 ${(cd / 1000).toFixed(1)}` : '💨 DASH';
    });

    api.onState((st) => {
      if (st.scores) setScores(st.scores);
      if (st.k === 'r') {
        ps = st.ps; shown = ps.map((p) => [...p]); radius = R0;
        center.textContent = '3';
        api.after(1000, () => { center.textContent = '2'; });
        api.after(2000, () => { center.textContent = '1'; });
        api.after(3000, () => { center.textContent = ''; });
        status.textContent = `Round ${st.round} — drag to move, DASH to slam`;
        api.sfx.beep();
      } else if (st.k === 's') {
        ps = st.ps; radius = st.R;
        if (st.bump) { api.sfx.bonk(); if (st.bump.includes(myIdx)) api.vibrate(30); splats.push({ x: st.bx, y: st.by, t: performance.now() }); }
        if (st.go) api.sfx.go();
        for (const i of st.fell || []) {
          status.innerHTML = `${api.tag(api.players[i].id)} ${api.esc(st.msg)}`;
          if (i === myIdx) { api.sfx.lose(); api.vibrate(300); api.shake(); } else api.sfx.splash();
        }
      } else if (st.k === 'e') {
        center.textContent = st.winner ? (st.winner === api.me ? '🏆' : api.avatar(st.winner)) : '🤝';
        status.innerHTML = st.winner ? `${api.tag(st.winner)} is the last one standing!` : 'Double knockout! 💀';
        if (st.winner === api.me) api.sfx.coin();
      }
    });

    if (!api.isHost) return;

    // ---------------- host physics ----------------
    const ids = api.players.map((p) => p.id);
    const n = ids.length;
    const scores = Object.fromEntries(ids.map((id) => [id, 0]));
    let b = [];
    let R = R0;
    let startAt = 0;
    let round = 0;
    let live = false;
    let token = 0;
    let ev = {};
    const later = (ms, fn) => { const k = token; api.after(ms, () => { if (k === token) fn(); }); };
    const rMin = RMIN + 0.05 * (n - 2); // 0.45 for 2 players … 0.75 for 8

    const newRound = () => {
      token++;
      round++;
      R = R0;
      b = ids.map((_, i) => {
        const a = (i / n) * Math.PI * 2 + Math.PI / 2;
        return { x: Math.cos(a) * 0.6, y: Math.sin(a) * 0.6, vx: 0, vy: 0, ax: 0, ay: 0, alive: true, dashUntil: 0, lastDash: 0 };
      });
      live = false;
      api.broadcast({ k: 'r', round, ps: snap(), scores });
      later(3000, () => { live = true; startAt = performance.now(); ev.go = 1; });
    };

    const snap = () => b.map((o) => [Math.round(o.x * 1000) / 1000, Math.round(o.y * 1000) / 1000, o.alive ? 1 : 0, performance.now() < o.dashUntil ? 1 : 0]);

    api.onInput((from, d) => {
      const i = ids.indexOf(from);
      if (i < 0 || !b[i]) return;
      if (Array.isArray(d?.a)) {
        let [ax, ay] = d.a.map(Number);
        if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;
        const len = Math.hypot(ax, ay);
        if (len > 1) { ax /= len; ay /= len; }
        b[i].ax = ax; b[i].ay = ay;
      }
      if (d?.dash && live && b[i].alive && performance.now() - b[i].lastDash > DASH_CD - 100) {
        const o = b[i];
        o.lastDash = performance.now();
        o.dashUntil = o.lastDash + 250;
        let dx = o.ax, dy = o.ay;
        if (Math.hypot(dx, dy) < 0.1) { dx = o.vx; dy = o.vy; }
        const len = Math.hypot(dx, dy) || 1;
        o.vx += (dx / len) * DASH; o.vy += (dy / len) * DASH;
      }
    });

    const DT = 1 / 60;
    api.every(16, () => {
      if (!live) return;
      const t = (performance.now() - startAt) / 1000;
      R = Math.max(rMin, R0 - (R0 - rMin) * Math.min(1, t / SHRINK_S));
      for (const o of b) {
        if (!o.alive) continue;
        o.vx += o.ax * ACCEL * DT; o.vy += o.ay * ACCEL * DT;
        o.vx *= 0.97; o.vy *= 0.97;
        o.x += o.vx * DT; o.y += o.vy * DT;
      }
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const A = b[i], B = b[j];
        if (!A.alive || !B.alive) continue;
        const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
        if (d >= BR * 2 || d < 1e-6) continue;
        const nx = dx / d, ny = dy / d, overlap = BR * 2 - d;
        A.x -= nx * overlap / 2; A.y -= ny * overlap / 2; B.x += nx * overlap / 2; B.y += ny * overlap / 2;
        const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
        if (rv < 0) {
          const now = performance.now();
          const ka = now < A.dashUntil ? 1.6 : 1, kb = now < B.dashUntil ? 1.6 : 1;
          const imp = -rv * BOUNCE;
          A.vx -= imp * nx * kb; A.vy -= imp * ny * kb;
          B.vx += imp * nx * ka; B.vy += imp * ny * ka;
          if (-rv > 0.4) { ev.bump = [i, j]; ev.bx = (A.x + B.x) / 2; ev.by = (A.y + B.y) / 2; }
        }
      }
      const fell = [];
      b.forEach((o, i) => { if (o.alive && Math.hypot(o.x, o.y) > R + BR * 0.3) { o.alive = false; fell.push(i); } });
      if (fell.length) { ev.fell = fell; ev.msg = FALL[Math.floor(Math.random() * FALL.length)]; }
      const left = b.map((o, i) => (o.alive ? i : -1)).filter((i) => i >= 0);
      if (left.length <= 1) {
        live = false;
        later(700, () => {
          const winner = left.length === 1 ? ids[left[0]] : null;
          if (winner) scores[winner]++;
          api.broadcast({ k: 'e', winner, scores });
          const top = leaders(scores);
          if (top.length === 1 && scores[top[0]] >= target) later(2200, () => api.finish(top, 'Sumo grand champion 🍙'));
          else later(2500, newRound);
        });
      }
    });

    api.every(33, () => {
      if (!b.length) return;
      api.broadcast({ k: 's', ps: snap(), R: Math.round(R * 1000) / 1000, ...ev });
      ev = {};
    });

    newRound();
  },
};
