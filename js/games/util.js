// Small helpers shared by the game modules.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) el.append(k);
  return el;
}

/** Canvas that fills its flex parent at a fixed aspect ratio (w/h), sharp on retina. */
export function makeCanvas(api, parent, aspect) {
  const wrap = h('div', { class: 'cv-wrap' });
  const c = h('canvas');
  wrap.append(c);
  parent.append(wrap);
  const view = { c, ctx: c.getContext('2d'), w: 1, h: 1, scale: 1, onResize: null };
  const fit = () => {
    const r = wrap.getBoundingClientRect();
    let w = r.width - 8, ht = r.height - 8;
    if (w <= 0 || ht <= 0) return;
    if (w / ht > aspect) w = ht * aspect; else ht = w / aspect;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.style.width = `${w}px`;
    c.style.height = `${ht}px`;
    c.width = Math.round(w * dpr);
    c.height = Math.round(ht * dpr);
    view.w = c.width;
    view.h = c.height;
    view.scale = dpr;
    view.onResize?.();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(wrap);
  api.onCleanup(() => ro.disconnect());
  fit();
  return view;
}

/** Pointer position on a canvas, normalised to 0..1 on both axes. */
export function normPoint(c, e) {
  const r = c.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}

export const pick = (a) => a[Math.floor(Math.random() * a.length)];
export function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Header row with the game title and a live score line. Returns the score element. */
export function header(api, title) {
  const scores = h('div', { class: 'gscores' });
  api.el.append(h('div', { class: 'ghead' }, h('span', { class: 'ttl' }, title), scores));
  return (map) => {
    scores.innerHTML = api.players.map((p) => `<span style="color:${p.color}">${api.esc(p.avatar)}<b>${map[p.id] ?? 0}</b></span>`).join('');
  };
}

/** Ids of the players with the top score (several on a tie). */
export function leaders(scores) {
  const best = Math.max(...Object.values(scores));
  return Object.keys(scores).filter((id) => scores[id] === best);
}

/** Draw an emoji centred at (x, y) with the given pixel size. */
export function emoji(ctx, e, x, y, size) {
  ctx.font = `${size}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000'; // colour emoji still take fillStyle's alpha
  ctx.fillText(e, x, y);
}
