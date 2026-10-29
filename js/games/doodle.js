// Doodle Duel: one player draws, everyone else races to guess. Wrong guesses are
// public (that's the funny part).
import { h, makeCanvas, normPoint, shuffle, header, leaders } from './util.js';

const WORDS = `pizza,toilet,banana,unicorn,zombie,spaghetti,dinosaur,hamburger,skateboard,volcano,mermaid,ninja,robot,cactus,octopus,
snowman,rainbow,sandwich,giraffe,penguin,vampire,wizard,pirate,alien,rocket,castle,dragon,toaster,hot dog,ice cream,popcorn,taco,
sushi,donut,cupcake,broccoli,pineapple,avocado,watermelon,cheese,bacon,chicken nugget,french fries,burrito,pancake,waffle,cookie,
spider,shark,snake,crab,frog,cat,dog,sloth,llama,flamingo,hedgehog,kangaroo,elephant,monkey,bee,snail,owl,whale,jellyfish,turtle,
pig,cow,duck,chicken,goat,horse,bunny,squirrel,raccoon,bat,ghost,skeleton,mummy,witch,clown,cowboy,king,queen,baby,grandma,
teacher,doctor,chef,firefighter,astronaut,superhero,mustache,beard,armpit,belly button,nose picking,sneeze,fart,burp,snore,
tickle,hiccup,smelly sock,underwear,flip flops,sunglasses,crown,top hat,backpack,umbrella,toothbrush,toilet paper,bathtub,
phone,laptop,headphones,video game,selfie,wifi,battery,lightbulb,camera,television,microwave,fridge,washing machine,vacuum,
car,bus,train,airplane,helicopter,bicycle,tractor,submarine,ufo,school,hospital,beach,island,desert,jungle,pyramid,eiffel tower,
moon,sun,star,planet,tornado,lightning,snowflake,fire,earthquake,trampoline,roller coaster,ferris wheel,bowling,basketball,
soccer,golf,karate,yoga,dancing,swimming,fishing,camping,birthday cake,wedding,graveyard,haunted house,treasure chest,
magic wand,crystal ball,sword,shield,bomb,cannon,trophy,medal,money,diamond,gold,lipstick,nail polish,hair dryer,mirror,
zipper,ladder,bridge,lighthouse,windmill,tent,campfire,marshmallow,lollipop,chewing gum,bubble,balloon,kite,paper airplane,
snowball fight,sandcastle,igloo,scarecrow,pumpkin,spider web,brain,skull,heart,eyeball,tooth,tongue,lips,feet,muscles,
sweat,tears,angry mom,stinky cheese,running late,traffic jam,bad haircut,food fight,pillow fight,sleepwalking,monday`
  .split(',').map((w) => w.trim()).filter(Boolean);

const COLORS = ['#111111', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#8b5a2b', '#ff7eb6'];
const SIZES = [4, 9, 18, 34];
const DRAW_MS = 80000;
const CHOOSE_MS = 15000;

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

// True when a run of whole words in the guess spells the answer: "its a hot dog" matches
// "hot dog", but "cattle" does not match "cat".
function containsAnswer(guess, w) {
  const words = String(guess).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length && joined.length < w.length; j++) {
      joined += words[j];
      if (joined === w) return true;
    }
  }
  return false;
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

const maskOf = (word, shown) => [...word].map((ch, i) => (ch === ' ' ? ' ' : shown.has(i) ? ch : '_')).join('');

export default {
  id: 'doodle',
  title: 'Doodle Duel',
  emoji: '🎨',
  blurb: 'Draw terribly. Guess wildly. Everyone sees your wrong guesses.',
  min: 2,
  max: 8,
  color: '#7048e8',

  start(api) {
    const setScores = header(api, '🎨 Doodle Duel');
    const status = h('div', { class: 'status' });
    api.el.append(status);
    const view = makeCanvas(api, api.el, 1);
    const tools = h('div', { class: 'dd-tools hidden' });
    const feed = h('div', { class: 'dd-feed' });
    const guessInput = h('input', { maxlength: '40', placeholder: 'Type your guess…', autocomplete: 'off', enterkeyhint: 'send' });
    const guessForm = h('form', { class: 'dd-guess' }, guessInput, h('button', { class: 'btn primary small' }, 'Guess'));
    api.el.append(tools, feed, guessForm);

    let strokes = [];
    let drawer = null;
    let mask = '';
    let myWord = null;
    let deadline = 0;
    let color = COLORS[0];
    let size = SIZES[1];
    let overlay = null;
    const amDrawer = () => drawer === api.me;

    // ---- canvas rendering ----
    const paintSeg = ([x0, y0, x1, y1, c, w]) => {
      const { ctx } = view;
      ctx.strokeStyle = c;
      ctx.lineWidth = (w / 400) * view.w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0 * view.w, y0 * view.h);
      ctx.lineTo(x1 * view.w, y1 * view.h);
      ctx.stroke();
    };
    const repaint = () => {
      view.ctx.fillStyle = '#fff';
      view.ctx.fillRect(0, 0, view.w, view.h);
      for (const s of strokes) paintSeg(s);
    };
    view.onResize = repaint;
    repaint();

    // ---- drawing input (drawer only) ----
    let last = null;
    api.listen(view.c, 'pointerdown', (e) => {
      if (!amDrawer() || overlay) return;
      view.c.setPointerCapture(e.pointerId);
      last = normPoint(view.c, e);
      const seg = [last[0], last[1], last[0], last[1], color, size];
      strokes.push(seg);
      paintSeg(seg);
      api.send({ seg });
    });
    api.listen(view.c, 'pointermove', (e) => {
      if (!last || !amDrawer()) return;
      const p = normPoint(view.c, e);
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.004) return;
      const seg = [last[0], last[1], p[0], p[1], color, size];
      last = p;
      strokes.push(seg);
      paintSeg(seg);
      api.send({ seg });
    });
    const stop = () => { last = null; };
    api.listen(view.c, 'pointerup', stop);
    api.listen(view.c, 'pointercancel', stop);

    const buildTools = () => {
      tools.innerHTML = '';
      for (const c of COLORS) {
        tools.append(h('button', { class: `sw ${c === color ? 'sel' : ''}`, style: `background:${c}`, onclick: () => { color = c; buildTools(); } }));
      }
      for (const s of SIZES) {
        const dot = h('i', { style: `width:${Math.max(4, s * 0.6)}px;height:${Math.max(4, s * 0.6)}px` });
        tools.append(h('button', { class: `sz ${s === size ? 'sel' : ''}`, onclick: () => { size = s; buildTools(); } }, dot));
      }
      tools.append(h('button', { class: 'btn ghost small', onclick: () => api.send({ clear: true }) }, '🗑️'));
    };
    buildTools();

    // ---- guessing ----
    const addFeed = (html) => {
      feed.append(h('div', {}, ''));
      feed.lastChild.innerHTML = html;
      while (feed.children.length > 60) feed.firstChild.remove();
      feed.scrollTop = feed.scrollHeight;
    };
    api.listen(guessForm, 'submit', (e) => {
      e.preventDefault();
      const text = guessInput.value.trim();
      if (!text || amDrawer() || myWord || api.spectator) return;
      api.send({ guess: text.slice(0, 40) });
      guessInput.value = '';
    });

    const renderStatus = () => {
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (!drawer) return;
      const who = amDrawer() ? '✏️ You draw' : `✏️ ${api.tag(drawer)}`;
      const word = myWord ? `<span class="dd-mask">${api.esc(myWord.toUpperCase())}</span>` : `<span class="dd-mask">${api.esc(mask)}</span>`;
      status.innerHTML = deadline ? `${who} · ${word} · ⏱️ ${secs}s` : `${who} · ${word}`;
    };
    api.every(250, renderStatus);

    const closeOverlay = () => { overlay?.remove(); overlay = null; };

    api.onState((s) => {
      if (s.scores) setScores(s.scores);
      switch (s.k) {
        case 'choose':
          closeOverlay();
          drawer = s.drawer;
          myWord = null;
          mask = '';
          strokes = [];
          repaint();
          deadline = Date.now() + CHOOSE_MS;
          tools.classList.toggle('hidden', !amDrawer());
          guessForm.classList.toggle('hidden', amDrawer() || api.spectator);
          addFeed(`<i>— Turn ${s.turn}/${s.total}: ${api.tag(drawer)} is picking a word… —</i>`);
          status.innerHTML = `${api.tag(drawer)} is choosing a word… 🤔`;
          break;
        case 'choices':
          closeOverlay();
          overlay = h('div', { class: 'dd-choices' }, h('h3', {}, 'Pick something to draw 🎨'));
          s.words.forEach((w, i) => overlay.append(h('button', {
            class: 'btn secondary', onclick: () => { api.send({ choose: i }); closeOverlay(); },
          }, w)));
          api.el.append(overlay);
          api.sfx.ding();
          break;
        case 'draw':
          closeOverlay();
          mask = s.mask;
          deadline = Date.now() + s.ms;
          if (amDrawer()) api.toast('✏️ Draw it! No letters allowed 😤');
          api.sfx.go();
          renderStatus();
          break;
        case 'word':
          myWord = s.word;
          renderStatus();
          break;
        case 'hint':
          mask = s.mask;
          renderStatus();
          break;
        case 'seg':
          if (s.from === api.me) break;
          strokes.push(s.seg);
          paintSeg(s.seg);
          break;
        case 'clear':
          strokes = [];
          repaint();
          break;
        case 'feed':
          if (s.type === 'guess') addFeed(`${api.tag(s.from)}: ${api.esc(s.text)}`);
          else if (s.type === 'ok') {
            addFeed(`<span class="ok">✅ ${api.esc(api.name(s.from))} got it! +${s.pts}</span>`);
            if (s.from === api.me) { api.sfx.coin(); api.vibrate([30, 30, 30]); } else api.sfx.ding();
          } else if (s.type === 'close') { addFeed(`<span class="close">🔥 "${api.esc(s.text)}" is SO close!</span>`); api.sfx.beep(); }
          break;
        case 'reveal':
          closeOverlay();
          deadline = 0;
          myWord = s.word;
          renderStatus();
          addFeed(`<b>The word was “${api.esc(s.word)}”</b> ${s.nobody ? '— nobody got it 💀' : ''}`);
          if (s.nobody) api.sfx.lose();
          break;
        default:
          break;
      }
    });

    if (!api.isHost) return;

    // ---------------- host ----------------
    const ids = api.players.map((p) => p.id);
    const scores = Object.fromEntries(ids.map((id) => [id, 0]));
    const rounds = ids.length === 2 ? 3 : 2;
    const order = [];
    for (let r = 0; r < rounds; r++) order.push(...ids);
    const used = new Set();
    let turn = -1;
    let t = null; // current turn
    let token = 0;
    const later = (ms, fn) => { const k = token; api.after(ms, () => { if (k === token) fn(); }); };

    const nextTurn = () => {
      token++;
      turn++;
      if (turn >= order.length) {
        api.finish(leaders(scores), 'Picasso who? 🖼️');
        return;
      }
      const choices = shuffle(WORDS.filter((w) => !used.has(w))).slice(0, 3);
      t = { drawer: order[turn], choices, word: null, guessed: new Set(), shown: new Set(), startAt: 0 };
      api.broadcast({ k: 'choose', drawer: t.drawer, turn: turn + 1, total: order.length, scores });
      api.sendTo(t.drawer, { k: 'choices', words: choices });
      later(CHOOSE_MS, () => beginDraw(0));
    };

    const beginDraw = (i) => {
      if (!t || t.word) return;
      token++;
      t.word = t.choices[i] ?? t.choices[0];
      used.add(t.word);
      t.startAt = Date.now();
      api.broadcast({ k: 'draw', mask: maskOf(t.word, t.shown), ms: DRAW_MS, scores });
      api.sendTo(t.drawer, { k: 'word', word: t.word });
      const letters = [...t.word].map((ch, idx) => (ch === ' ' ? -1 : idx)).filter((x) => x >= 0);
      const hint = () => {
        const hidden = shuffle(letters.filter((x) => !t.shown.has(x)));
        if (hidden.length <= 1) return;
        t.shown.add(hidden[0]);
        api.broadcast({ k: 'hint', mask: maskOf(t.word, t.shown) });
      };
      later(DRAW_MS * 0.5, hint);
      later(DRAW_MS * 0.75, hint);
      later(DRAW_MS, endTurn);
    };

    const endTurn = () => {
      token++;
      const nobody = t.guessed.size === 0;
      api.broadcast({ k: 'reveal', word: t.word, nobody, scores });
      later(4000, nextTurn);
    };

    api.onInput((from, d) => {
      if (!t || !d) return;
      if (from === t.drawer) {
        if (typeof d.choose === 'number' && !t.word) beginDraw(Math.max(0, Math.min(2, d.choose | 0)));
        else if (Array.isArray(d.seg) && t.word && d.seg.length === 6) {
          const [x0, y0, x1, y1, c, w] = d.seg;
          const ok = [x0, y0, x1, y1].every((v) => typeof v === 'number' && v >= 0 && v <= 1) && COLORS.includes(c) && SIZES.includes(w);
          if (ok) api.broadcast({ k: 'seg', seg: d.seg, from });
        } else if (d.clear && t.word) api.broadcast({ k: 'clear' });
        return;
      }
      if (typeof d.guess !== 'string' || !t.word || t.guessed.has(from)) return;
      const g = norm(d.guess);
      const w = norm(t.word);
      if (!g) return;
      // "its a pizza" counts (and must not be broadcast, it would spoil the word).
      if (g === w || containsAnswer(d.guess, w)) {
        const remain = Math.max(0, DRAW_MS - (Date.now() - t.startAt));
        const pts = 50 + Math.round((150 * remain) / DRAW_MS) + (t.guessed.size === 0 ? 30 : 0);
        t.guessed.add(from);
        scores[from] += pts;
        scores[t.drawer] += 40;
        api.broadcast({ k: 'feed', type: 'ok', from, pts, scores });
        api.sendTo(from, { k: 'word', word: t.word });
        if (t.guessed.size >= ids.length - 1) endTurn();
      } else if (g.includes(w) || (w.length > 3 && lev(g, w) <= (w.length > 6 ? 2 : 1))) {
        api.sendTo(from, { k: 'feed', type: 'close', text: d.guess.slice(0, 40) });
      } else {
        api.broadcast({ k: 'feed', type: 'guess', from, text: d.guess.slice(0, 40) });
      }
    });

    nextTurn();
  },
};
