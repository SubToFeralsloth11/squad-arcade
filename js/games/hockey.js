// Air Hockey: 1v1, drag your mallet, smash the puck. Host simulates physics;
// each phone sees its own goal at the bottom.
import { h, makeCanvas, normPoint, header, clamp, emoji } from './util.js';

const TW = 1;          // table width
const TH = 1.6;        // table height
const MR = 0.085;      // mallet radius
const PR = 0.05;       // puck radius
const GOAL = 0.36;     // goal mouth width
const MAX_PUCK = 3.2;  // units per second
const MAX_MALLET = 5;
const TARGET = 7;
const TAUNTS = ['🥅 GOOOAL!', '🚀 ROCKET!', '🧈 Butter fingers!', '😤 Not again!', '🎯 Sniped!', '🪦 RIP defence'];

export default {
  id: 'hockey',
  title: 'Air Hockey',
  emoji: '🏒',
  blurb: 'Drag your mallet, smash the puck. First to 7. Pure chaos on a phone.',
  min: 2,
  max: 2,
  color: '#1c7ed6',

  start(api) {
    const setScores = header(api, `🏒 First to ${TARGET}`);
    const status = h('div', { class: 'status' }, 'Drag your mallet!');
    api.el.append(status);
    const view = makeCanvas(api, api.el, TW / TH);
    const center = h('div', { class: 'center-msg' });
    view.c.parentElement.append(center);

    const side = api.players.findIndex((p) => p.id === api.me); // 0 = bottom (host coords), 1 = top
    const flip = side === 1;
    const toView = (x, y) => (flip ? [TW - x, TH - y] : [x, y]);

    let puck = [TW / 2, TH / 2];
    let shownPuck = [...puck];
    let mallets = [[TW / 2, TH - 0.2], [TW / 2, 0.2]];
    let shown = mallets.map((m) => [...m]);
    let mine = null; // my mallet target in host coords (local prediction)
    let lastSend = 0;
    let trail = [];

    // ---- input ----
    const aim = (e) => {
      if (side < 0) return;
      const [nx, ny] = normPoint(view.c, e);
      let x = nx * TW, y = ny * TH - 0.06; // keep the mallet just above the finger
      if (flip) { x = TW - x; y = TH - y; }
      const lo = side === 0 ? TH / 2 + MR : MR;
      const hi = side === 0 ? TH - MR : TH / 2 - MR;
      mine = [clamp(x, MR, TW - MR), clamp(y, lo, hi)];
      const now = performance.now();
      if (now - lastSend > 16) { lastSend = now; api.send({ m: mine }); }
    };
    api.listen(view.c, 'pointerdown', (e) => { view.c.setPointerCapture(e.pointerId); aim(e); });
    api.listen(view.c, 'pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') aim(e); });

    // ---- render ----
    api.loop(() => {
      const { ctx } = view;
      const s = view.w / TW;
      for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) shown[k][j] += (mallets[k][j] - shown[k][j]) * 0.45;
      if (mine) shown[side] = mine;
      for (let j = 0; j < 2; j++) shownPuck[j] += (puck[j] - shownPuck[j]) * 0.6;

      ctx.fillStyle = '#e9f4ff';
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.strokeStyle = '#ff4d6d66';
      ctx.lineWidth = s * 0.012;
      ctx.beginPath(); ctx.moveTo(0, view.h / 2); ctx.lineTo(view.w, view.h / 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(view.w / 2, view.h / 2, s * 0.16, 0, Math.PI * 2); ctx.stroke();
      // goals: top and bottom in view space
      const gx = (TW - GOAL) / 2 * s;
      ctx.fillStyle = '#212529';
      ctx.fillRect(gx, 0, GOAL * s, s * 0.025);
      ctx.fillRect(gx, view.h - s * 0.025, GOAL * s, s * 0.025);
      ctx.strokeStyle = '#4dabff66';
      ctx.beginPath(); ctx.arc(view.w / 2, view.h, s * 0.22, Math.PI, 0); ctx.stroke();
      ctx.beginPath(); ctx.arc(view.w / 2, 0, s * 0.22, 0, Math.PI); ctx.stroke();

      const [px, py] = toView(...shownPuck);
      trail.push([px, py]);
      if (trail.length > 8) trail.shift();
      trail.forEach(([x, y], i) => {
        ctx.globalAlpha = (i / trail.length) * 0.25;
        ctx.fillStyle = '#212529';
        ctx.beginPath(); ctx.arc(x * s, y * s, PR * s, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#212529';
      ctx.beginPath(); ctx.arc(px * s, py * s, PR * s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffd43b';
      ctx.lineWidth = s * 0.008;
      ctx.beginPath(); ctx.arc(px * s, py * s, PR * s * 0.6, 0, Math.PI * 2); ctx.stroke();

      api.players.forEach((p, i) => {
        const [mx, my] = toView(...shown[i]);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(mx * s, my * s, MR * s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff55';
        ctx.beginPath(); ctx.arc(mx * s, my * s, MR * s * 0.55, 0, Math.PI * 2); ctx.fill();
        emoji(ctx, p.avatar, mx * s, my * s, MR * s * 1.1);
      });
    });

    api.onState((st) => {
      if (st.p) { puck = st.p; mallets = st.m; }
      if (st.sc) setScores(Object.fromEntries(api.players.map((p, i) => [p.id, st.sc[i]])));
      if (st.hit) { api.sfx.bonk(); if (st.hit === side + 1) api.vibrate(25); }
      if (st.wall) api.sfx.click();
      if (st.goal != null) {
        const scorer = api.players[st.goal];
        center.textContent = st.goal === side ? '🥅 GOAL!' : side < 0 ? '🥅' : '😱';
        status.innerHTML = `${api.tag(scorer.id)} — ${api.esc(st.taunt)}`;
        if (st.goal === side) { api.sfx.airhorn(); api.vibrate([50, 40, 50]); } else { api.sfx.boom(); api.shake(); }
        trail = [];
        api.after(1200, () => { center.textContent = ''; });
      }
    });

    if (!api.isHost) return;

    // ---------------- host physics ----------------
    const ids = api.players.map((p) => p.id);
    const sc = [0, 0];
    const p = { x: TW / 2, y: TH / 2, vx: 0, vy: 0 };
    const m = [{ x: TW / 2, y: TH - 0.2, tx: TW / 2, ty: TH - 0.2, vx: 0, vy: 0 }, { x: TW / 2, y: 0.2, tx: TW / 2, ty: 0.2, vx: 0, vy: 0 }];
    let frozenUntil = performance.now() + 1500;
    let events = {};
    let ended = false;

    const servePuck = (toward) => {
      p.x = TW / 2; p.y = toward === 0 ? TH / 2 + 0.15 : TH / 2 - 0.15; p.vx = 0; p.vy = 0;
    };
    servePuck(Math.random() < 0.5 ? 0 : 1);

    api.onInput((from, d) => {
      const i = ids.indexOf(from);
      if (i < 0 || !Array.isArray(d?.m)) return;
      const [x, y] = d.m.map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      m[i].tx = clamp(x, MR, TW - MR);
      m[i].ty = i === 0 ? clamp(y, TH / 2 + MR, TH - MR) : clamp(y, MR, TH / 2 - MR);
    });

    const DT = 1 / 120;
    const step = () => {
      for (let k = 0; k < 2; k++) {
        const mk = m[k];
        let dx = mk.tx - mk.x, dy = mk.ty - mk.y;
        const dist = Math.hypot(dx, dy), maxStep = MAX_MALLET * DT;
        if (dist > maxStep) { dx *= maxStep / dist; dy *= maxStep / dist; }
        mk.vx = dx / DT; mk.vy = dy / DT;
        mk.x += dx; mk.y += dy;
      }
      if (performance.now() < frozenUntil) return;
      p.x += p.vx * DT; p.y += p.vy * DT;
      p.vx *= 0.9975; p.vy *= 0.9975;
      if (p.x < PR) { p.x = PR; p.vx = Math.abs(p.vx); events.wall = 1; }
      if (p.x > TW - PR) { p.x = TW - PR; p.vx = -Math.abs(p.vx); events.wall = 1; }
      const inMouth = Math.abs(p.x - TW / 2) < GOAL / 2 - PR * 0.3;
      if (!inMouth) {
        if (p.y < PR) { p.y = PR; p.vy = Math.abs(p.vy); events.wall = 1; }
        if (p.y > TH - PR) { p.y = TH - PR; p.vy = -Math.abs(p.vy); events.wall = 1; }
      }
      for (let k = 0; k < 2; k++) {
        const mk = m[k];
        const dx = p.x - mk.x, dy = p.y - mk.y;
        const d = Math.hypot(dx, dy);
        if (d < MR + PR && d > 1e-6) {
          const nx = dx / d, ny = dy / d;
          p.x = mk.x + nx * (MR + PR); p.y = mk.y + ny * (MR + PR);
          const rvx = p.vx - mk.vx, rvy = p.vy - mk.vy;
          const vn = rvx * nx + rvy * ny;
          if (vn < 0) { p.vx -= 1.9 * vn * nx; p.vy -= 1.9 * vn * ny; }
          p.vx += mk.vx * 0.15; p.vy += mk.vy * 0.15;
          events.hit = k + 1;
        }
      }
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAX_PUCK) { p.vx *= MAX_PUCK / sp; p.vy *= MAX_PUCK / sp; }
      const scorer = p.y < -PR ? 0 : p.y > TH + PR ? 1 : -1;
      if (scorer >= 0 && !ended) {
        sc[scorer]++;
        events.goal = scorer;
        events.taunt = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
        servePuck(1 - scorer);
        frozenUntil = performance.now() + 1500;
        if (sc[scorer] >= TARGET) {
          ended = true;
          api.after(1600, () => api.finish([ids[scorer]], `${sc[0]} – ${sc[1]}. Absolute demolition.`));
        }
      }
    };

    let acc = 0;
    let last = performance.now();
    api.every(16, () => {
      const now = performance.now();
      acc = Math.min(acc + (now - last) / 1000, 0.1);
      last = now;
      while (acc >= DT) { step(); acc -= DT; }
    });
    let sendTick = 0;
    api.every(33, () => {
      sendTick++;
      const r = (v) => Math.round(v * 1000) / 1000;
      const msg = { p: [r(p.x), r(p.y)], m: m.map((mk) => [r(mk.x), r(mk.y)]), ...events };
      if (events.goal != null || sendTick % 15 === 0) msg.sc = sc;
      events = {};
      api.broadcast(msg);
    });
    api.broadcast({ sc });
  },
};
