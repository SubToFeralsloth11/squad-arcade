// Mind Reader: unhinged would-you-rather. One player answers honestly, everyone
// else predicts what they picked. Find out how well you really know your friends.
import { h, shuffle, header, leaders } from './util.js';

const QUESTIONS = [
  ['fight 1 horse-sized duck', 'fight 100 duck-sized horses'],
  ['have spaghetti for hair', 'sweat maple syrup'],
  ['always smell like onions', 'always hear the Wii shop music'],
  ['sneeze every time you laugh', 'laugh every time you sneeze'],
  ['only whisper forever', 'only yell forever'],
  ['have a rewind button for life', 'have a pause button for life'],
  ['be a famous YouTuber', 'be a secret billionaire'],
  ['lose your phone for a month', 'lose your eyebrows for a year'],
  ['eat a bug every day', 'never eat pizza again'],
  ['have fingers as long as legs', 'legs as long as fingers'],
  ['talk to animals', 'speak every human language'],
  ['be stuck in a lift with your teacher', 'be stuck in a lift with your ex'],
  ['have your search history leaked', 'have your camera roll leaked'],
  ['be always 10 minutes late', 'be always 2 hours early'],
  ['live in a giant shoe', 'live in a giant pumpkin'],
  ['have a pet dinosaur', 'have a pet dragon'],
  ['only eat cold food', 'only eat spicy food'],
  ['be invisible', 'be able to fly'],
  ['never use social media again', 'never watch another movie or show'],
  ['have a personal chef', 'have a personal driver'],
  ['wear clown shoes forever', 'wear a clown nose forever'],
  ['meow after every sentence', 'bark when someone says your name'],
  ['be the funniest person in the room', 'be the smartest person in the room'],
  ['explore space', 'explore the deep ocean'],
  ['go back to the dinosaurs', 'go 1000 years into the future'],
  ['have unlimited robux/vbucks', 'have unlimited snacks'],
  ['fart loudly in an exam', 'burp loudly at a wedding'],
  ['get a tattoo of your friend\'s face', 'let your friend pick your haircut'],
  ['have no wifi forever', 'have no air conditioning/heating forever'],
  ['be a wizard', 'be a superhero'],
  ['have a third arm', 'have a third eye'],
  ['live without music', 'live without TV/movies'],
  ['be famous for something dumb', 'be unknown for something amazing'],
  ['eat a raw onion like an apple', 'drink a cup of pickle juice'],
  ['always lose at games', 'never be allowed to play games'],
  ['have to sing everything you say', 'have to dance everywhere you walk'],
  ['know when you\'ll die', 'know how you\'ll die'],
  ['swim in a pool of jelly', 'swim in a pool of baked beans'],
  ['be a cat', 'be a dog'],
  ['have super speed', 'have super strength'],
  ['have your mum read your texts', 'have your crush read your texts'],
  ['only be able to eat with chopsticks', 'only be able to eat with your hands'],
  ['live in Minecraft', 'live in GTA'],
  ['never be bored again', 'never be tired again'],
  ['have hiccups for a year', 'feel like you need to sneeze for a year'],
  ['be a world-class athlete', 'be a world-class musician'],
  ['give up cheese', 'give up chocolate'],
  ['have a lightsaber', 'have a magic wand'],
  ['have a boring life that lasts forever', 'a crazy life that lasts 40 years'],
  ['be trapped in a room with a mosquito', 'be trapped in a room with a toddler'],
  ['speak only in questions', 'speak only in rhymes'],
  ['own a time machine', 'own a teleporter'],
  ['always step on Lego', 'always have a wet sock'],
  ['be 3 feet tall', 'be 9 feet tall'],
  ['get free food forever', 'get free travel forever'],
  ['have an annoying laugh', 'have an annoying sneeze'],
  ['marry someone rich and boring', 'marry someone broke and hilarious'],
  ['be stranded on an island alone', 'be stranded with someone you hate'],
  ['have a rap battle with your grandma', 'have a dance battle with your teacher'],
  ['never be able to close doors', 'never be able to turn off lights'],
  ['have everything you draw become real', 'have everything you write become true'],
  ['be a ghost', 'be a vampire'],
  ['lick a public handrail', 'eat a crisp off the cinema floor'],
  ['have squeaky shoes', 'have a squeaky chair everywhere'],
  ['win the lottery', 'live twice as long'],
  ['always know when someone is lying', 'always get away with lying'],
  ['have your life narrated by Morgan Freeman', 'have a theme song play when you walk in'],
  ['wake up as the opposite gender for a day', 'wake up as your best friend for a day'],
  ['live in a treehouse', 'live on a boat'],
  ['have unlimited battery on all devices', 'have unlimited free wifi everywhere'],
];
const ANSWER_MS = 20000;
const CORRECT = ['🧠 MIND READER', '🔮 psychic!', '🤝 knows them too well', '👁️ saw that coming'];
const WRONG = ['❌ who even are you', '🤨 do you even know them?', '💀 wrong', '🙈 stranger danger'];

export default {
  id: 'mindreader',
  title: 'Mind Reader',
  emoji: '🔮',
  blurb: 'Unhinged would-you-rather. Guess what your friend picked. Friendships WILL be tested.',
  min: 2,
  max: 8,
  color: '#d6336c',

  start(api) {
    const setScores = header(api, '🔮 Mind Reader');
    const box = h('div', { class: 'mr' });
    api.el.append(box);
    let st = null;
    let picked = null;
    let deadline = 0;
    let bar = null;

    const draw = () => {
      box.innerHTML = '';
      if (!st) return;
      const iAmHot = st.hot === api.me;
      const reveal = st.k === 'r';
      const who = reveal ? `${api.tag(st.hot)} picked…`
        : api.spectator ? `${api.tag(st.hot)} is in the hot seat`
          : iAmHot ? '🔥 <b>You\'re in the hot seat.</b> Answer honestly!'
            : `What would ${api.tag(st.hot)} pick?`;
      box.append(h('div', { class: 'who' }));
      box.lastChild.innerHTML = `${who} <span style="opacity:.6">(${st.round}/${st.total})</span>`;
      box.append(h('div', { class: 'q' }, 'Would you rather…'));
      st.q.forEach((text, i) => {
        let cls = `opt ${i ? 'b' : 'a'}`;
        if (reveal) cls += st.hotPick === i ? ' sel' : ' dim';
        else if (picked === i) cls += ' sel';
        const b = h('button', { class: cls }, text);
        if (!reveal && !api.spectator) b.addEventListener('click', () => { if (picked == null) { picked = i; api.send({ pick: i }); api.sfx.pop(); draw(); } });
        box.append(b);
        if (i === 0) box.append(h('div', { class: 'or' }, 'OR'));
      });
      if (!reveal) {
        bar = h('i');
        box.append(h('div', { class: 'timer' }, bar));
        const p = h('div', { class: 'pickers' });
        p.innerHTML = (st.done || []).map((id) => `<span title="${api.esc(api.name(id))}">${api.esc(api.avatar(id))}✅</span>`).join('');
        box.append(p);
      } else {
        const p = h('div', { class: 'pickers' });
        p.innerHTML = st.hotPick == null ? `${api.tag(st.hot)} froze 🥶 — nobody scores`
          : api.players.filter((pl) => pl.id !== st.hot).map((pl) => {
            const g = st.picks[pl.id];
            const ok = g === st.hotPick;
            return `<span>${api.tag(pl.id)} ${g == null ? '😴' : ok ? '✅' : '❌'}</span>`;
          }).join(' ');
        box.append(p);
      }
    };

    api.loop(() => {
      if (bar && deadline) bar.style.width = `${Math.max(0, ((deadline - Date.now()) / ANSWER_MS) * 100)}%`;
    });

    api.onState((s) => {
      setScores(s.scores);
      if (s.k === 'q') {
        st = s; picked = null; deadline = Date.now() + s.ms;
        api.sfx.ding();
      } else if (s.k === 'p') {
        if (st) st.done = s.done;
      } else if (s.k === 'r') {
        st = s; deadline = 0;
        if (s.hotPick != null && s.hot !== api.me && !api.spectator) {
          const ok = s.picks[api.me] === s.hotPick;
          api.toast(ok ? CORRECT[s.round % CORRECT.length] : WRONG[s.round % WRONG.length]);
          if (ok) api.sfx.coin(); else api.sfx.wrong();
        } else api.sfx.rimshot();
      }
      draw();
    });

    if (!api.isHost) return;

    // ---------------- host ----------------
    const ids = api.players.map((p) => p.id);
    const scores = Object.fromEntries(ids.map((id) => [id, 0]));
    const total = Math.min(12, ids.length * (ids.length === 2 ? 5 : 2));
    const qs = shuffle(QUESTIONS).slice(0, total);
    const hotOrder = shuffle(ids);
    let round = 0;
    let cur = null;
    let token = 0;
    const later = (ms, fn) => { const k = token; api.after(ms, () => { if (k === token) fn(); }); };

    const ask = () => {
      token++;
      if (round >= total) { api.finish(leaders(scores), 'Certified friendship expert 🔮'); return; }
      const hot = hotOrder[round % hotOrder.length];
      cur = { hot, q: qs[round], picks: {} };
      round++;
      api.broadcast({ k: 'q', round, total, hot, q: cur.q, ms: ANSWER_MS, done: [], scores });
      later(ANSWER_MS, reveal);
    };

    const reveal = () => {
      if (cur.revealed) return;
      cur.revealed = true;
      token++;
      const hotPick = cur.picks[cur.hot] ?? null;
      if (hotPick != null) {
        for (const id of ids) if (id !== cur.hot && cur.picks[id] === hotPick) scores[id] += 100;
        // The hot seat also scores for every friend who read them correctly.
        const right = ids.filter((id) => id !== cur.hot && cur.picks[id] === hotPick).length;
        scores[cur.hot] += right * 40;
      }
      api.broadcast({ k: 'r', round, total, hot: cur.hot, q: cur.q, hotPick, picks: cur.picks, scores });
      later(5500, ask);
    };

    api.onInput((from, d) => {
      if (!cur || cur.revealed || cur.picks[from] != null || (d?.pick !== 0 && d?.pick !== 1)) return;
      cur.picks[from] = d.pick;
      api.broadcast({ k: 'p', done: Object.keys(cur.picks), scores });
      if (ids.every((id) => cur.picks[id] != null)) reveal();
    });

    ask();
  },
};
