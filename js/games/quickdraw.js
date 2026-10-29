// Quick Draw: wait for BANG, tap first. Fake-outs punish the twitchy.
// Reaction time is measured on each phone (from when *it* showed BANG), so lag
// doesn't decide the winner.
import { h, pick, header, leaders } from './util.js';

const FAKES = ['BANANA 🍌', 'BAN…', 'BAND 🎸', 'BANJO 🪕', 'BANK 🏦', 'BANDANA', 'BAMBOO 🎋', 'BANG?', 'BRB', 'BONG 🔔'];
const EARLY = ['jumped the gun 🤡', 'shot their own foot 🦶', 'has itchy fingers 😳', 'panicked 💀', 'got baited LOL'];
const TOO_SLOW = ['Nobody shot. Cowards. 🐔', 'Everyone fell asleep 😴', 'Tumbleweed rolls by… 🌵'];

export default {
  id: 'quickdraw',
  title: 'Quick Draw',
  emoji: '🤠',
  blurb: 'Wait for BANG, then tap faster than everyone. Fake-outs WILL get you.',
  min: 2,
  max: 8,
  color: '#e8590c',

  start(api) {
    const target = api.players.length === 2 ? 7 : 5;
    const setScores = header(api, `🤠 First to ${target}`);
    const big = h('div', { class: 'big' }, 'Get ready…');
    const sub = h('div', { class: 'sub' }, 'Tap anywhere when you see BANG');
    const area = h('div', { class: 'qd' }, big, sub);
    api.el.append(area);
    if (api.spectator) api.el.append(h('div', { class: 'spectate' }, '👀 Spectating'));

    let phase = 'ready';
    let round = 0;
    let goAt = 0;
    let tapped = false;

    const show = (ph, text, subText = '') => {
      area.className = `qd ph-${ph}`;
      big.textContent = text;
      sub.innerHTML = subText;
    };

    api.listen(area, 'pointerdown', (e) => {
      e.preventDefault();
      if (api.spectator || tapped) return;
      if (phase === 'wait' || phase === 'fake') {
        tapped = true;
        api.send({ early: true, round });
        show('early', '🤡 TOO EARLY', 'Wait for it next time…');
        api.sfx.wrong();
        api.vibrate(200);
      } else if (phase === 'go') {
        tapped = true;
        const ms = Math.round(performance.now() - goAt);
        api.send({ ms, round });
        big.textContent = `${ms} ms`;
        api.sfx.hit();
      }
    });

    api.onState((s) => {
      setScores(s.scores);
      if (s.round) round = s.round;
      phase = s.phase;
      if (s.phase === 'ready') {
        tapped = false;
        show('ready', `Round ${s.round}`, 'Hands off the screen… 🫳');
        api.sfx.beep();
      } else if (s.phase === 'wait') {
        if (!tapped) show('wait', 'Wait for it…', s.again ? 'That wasn\'t it 😏' : '🤫');
      } else if (s.phase === 'fake') {
        if (!tapped) show('fake', s.word, '');
        api.sfx.click();
      } else if (s.phase === 'go') {
        goAt = performance.now();
        if (!tapped) show('go', 'BANG! 💥', 'TAP TAP TAP');
        api.sfx.boom();
      } else if (s.phase === 'result') {
        const lines = Object.entries(s.times).sort((a, b) => a[1] - b[1])
          .map(([id, ms]) => `${api.tag(id)} ${ms} ms`).join('<br>');
        if (s.early) {
          show('early', '🤡', `${api.tag(s.early)} ${api.esc(s.msg)}<br>Everyone else +1`);
          if (s.early !== api.me) api.sfx.rimshot();
        } else if (s.winner) {
          show('ready', s.winner === api.me ? '🎯 YOU!' : `${api.avatar(s.winner)} wins`, lines);
          if (s.winner === api.me) { api.sfx.coin(); api.vibrate([40, 30, 40]); }
        } else show('ready', '🌵', api.esc(s.msg));
      }
    });

    if (!api.isHost) return;

    // ---------------- host ----------------
    const ids = api.players.map((p) => p.id);
    const scores = Object.fromEntries(ids.map((id) => [id, 0]));
    let state = 'ready';
    let taps = {};
    let token = 0;
    const later = (ms, fn) => { const t = token; api.after(ms, () => { if (t === token) fn(); }); };

    const newRound = () => {
      token++;
      round++;
      taps = {};
      state = 'ready';
      api.broadcast({ phase: 'ready', round, scores });
      later(1300, () => {
        state = 'wait';
        api.broadcast({ phase: 'wait', round, scores });
        const delay = 1500 + Math.random() * 3500;
        const faked = Math.random() < 0.45;
        if (faked) {
          later(delay * 0.55, () => {
            state = 'fake';
            api.broadcast({ phase: 'fake', round, word: pick(FAKES), scores });
            later(800, () => { state = 'wait'; api.broadcast({ phase: 'wait', again: true, round, scores }); });
          });
        }
        later(delay + (faked ? 1300 : 0), () => {
          state = 'go';
          api.broadcast({ phase: 'go', round, scores });
          later(2500, resolve);
        });
      });
    };

    const checkEnd = () => {
      const top = leaders(scores);
      if (scores[top[0]] >= target && top.length === 1) {
        later(2200, () => api.finish(top, `Fastest hand in the west 🤠 (${scores[top[0]]} points)`));
        return true;
      }
      return false;
    };

    const resolve = () => {
      if (state !== 'go') return;
      token++;
      state = 'result';
      const entries = Object.entries(taps).sort((a, b) => a[1] - b[1]);
      const winner = entries[0]?.[0] || null;
      if (winner) scores[winner]++;
      api.broadcast({ phase: 'result', round, times: taps, winner, scores, msg: winner ? '' : pick(TOO_SLOW) });
      if (!checkEnd()) later(2600, newRound);
    };

    api.onInput((from, d) => {
      if (!d || d.round !== round || taps[from] != null) return;
      // Times are measured on the tapper's phone (so lag doesn't decide rounds);
      // anything under 90 ms is not a human reaction, so it counts as a false start.
      const robot = typeof d.ms === 'number' && d.ms < 90;
      if ((d.early || robot) && (state === 'wait' || state === 'fake' || state === 'go')) {
        token++;
        state = 'result';
        for (const id of ids) if (id !== from) scores[id]++;
        const msg = robot ? 'is tapping faster than humanly possible 🤖' : pick(EARLY);
        api.broadcast({ phase: 'result', round, times: {}, early: from, msg, scores });
        if (!checkEnd()) later(2600, newRound);
      } else if (typeof d.ms === 'number' && state === 'go') {
        taps[from] = Math.min(5000, Math.round(d.ms));
        if (Object.keys(taps).length === ids.length) resolve();
      }
    });

    newRound();
  },
};
