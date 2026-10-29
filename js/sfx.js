// All sounds are synthesised with WebAudio: no audio files to load.
let ctx = null;
let master = null;
let muted = localStorage.getItem('sa.muted') === '1';

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function audioContext() { return ac(); }
export function isMuted() { return muted; }
export function setMuted(m) { muted = m; localStorage.setItem('sa.muted', m ? '1' : '0'); }

function tone({ f = 440, f2 = null, type = 'sine', d = 0.15, v = 0.25, t = 0, curve = null, lp = null }) {
  const c = ac();
  const t0 = c.currentTime + t;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  if (curve) o.frequency.setValueCurveAtTime(Float32Array.from(curve), t0, d);
  else {
    o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + d);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(v, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  let out = o;
  if (lp) {
    const flt = c.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = lp;
    o.connect(flt);
    out = flt;
  }
  out.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + d + 0.05);
}

let noiseBuf = null;
function noise({ d = 0.3, v = 0.3, t = 0, type = 'lowpass', freq = 1000, q = 1, f2 = null }) {
  const c = ac();
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t0 = c.currentTime + t;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const flt = c.createBiquadFilter();
  flt.type = type;
  flt.frequency.setValueAtTime(freq, t0);
  if (f2) flt.frequency.exponentialRampToValueAtTime(f2, t0 + d);
  flt.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(v, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  src.connect(flt).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + d + 0.05);
}

const wobble = (base, depth, n, rate) => Array.from({ length: n }, (_, i) => base + Math.sin(i * rate) * depth + (Math.random() - 0.5) * depth);

const SOUNDS = {
  click: () => tone({ f: 700, f2: 1000, type: 'square', d: 0.05, v: 0.08 }),
  pop: () => tone({ f: 300, f2: 900, d: 0.08, v: 0.2 }),
  ding: () => { tone({ f: 1320, d: 0.6, v: 0.2 }); tone({ f: 2640, d: 0.4, v: 0.06 }); },
  coin: () => { tone({ f: 988, type: 'square', d: 0.08, v: 0.1 }); tone({ f: 1319, type: 'square', d: 0.3, v: 0.1, t: 0.08 }); },
  beep: () => tone({ f: 660, type: 'square', d: 0.12, v: 0.1 }),
  go: () => tone({ f: 1320, type: 'square', d: 0.35, v: 0.12 }),
  wrong: () => tone({ f: 160, type: 'sawtooth', d: 0.35, v: 0.12, lp: 900 }),
  hit: () => { noise({ d: 0.12, v: 0.4, freq: 2500, type: 'bandpass' }); tone({ f: 220, f2: 80, d: 0.12, v: 0.2 }); },
  splash: () => noise({ d: 0.5, v: 0.25, freq: 3000, f2: 400, type: 'bandpass', q: 0.7 }),
  swoosh: () => noise({ d: 0.25, v: 0.25, freq: 600, f2: 4000, type: 'bandpass', q: 2 }),
  boom: () => { noise({ d: 1.1, v: 0.7, freq: 900, f2: 60 }); tone({ f: 90, f2: 30, d: 0.9, v: 0.5 }); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ f, type: 'triangle', d: i === 3 ? 0.6 : 0.16, v: 0.22, t: i * 0.12 })),
  lose: () => {
    [392, 370, 349].forEach((f, i) => tone({ f, type: 'sawtooth', d: 0.42, v: 0.16, t: i * 0.45, lp: 1400 }));
    tone({ type: 'sawtooth', d: 1.2, v: 0.16, t: 1.35, lp: 1400, curve: wobble(330, 9, 40, 0.9) });
  },
  airhorn: () => [0, 0.16, 0.32].forEach((t, i) => {
    const d = i === 2 ? 0.8 : 0.13;
    tone({ f: 370, type: 'sawtooth', d, v: 0.18, t, lp: 2600 });
    tone({ f: 466, type: 'sawtooth', d, v: 0.15, t, lp: 2600 });
    tone({ f: 554, type: 'sawtooth', d, v: 0.1, t, lp: 2600 });
  }),
  fart: () => {
    const d = 0.5 + Math.random() * 0.6;
    tone({ type: 'sawtooth', d, v: 0.5, lp: 380, curve: wobble(70 + Math.random() * 30, 25, 60, 2.7) });
    noise({ d, v: 0.12, freq: 220, type: 'lowpass' });
  },
  rimshot: () => {
    tone({ f: 220, f2: 120, d: 0.12, v: 0.4 });
    tone({ f: 180, f2: 100, d: 0.15, v: 0.4, t: 0.15 });
    noise({ d: 0.9, v: 0.3, freq: 7000, type: 'highpass', t: 0.42 });
    tone({ f: 120, f2: 60, d: 0.2, v: 0.4, t: 0.42 });
  },
  boing: () => tone({ type: 'sine', d: 0.6, v: 0.3, curve: Array.from({ length: 50 }, (_, i) => 160 + 420 * Math.abs(Math.sin(i / 5)) * (1 - i / 60)) }),
  siren: () => tone({ type: 'square', d: 1.6, v: 0.08, lp: 2000, curve: Array.from({ length: 64 }, (_, i) => 750 + 350 * Math.sin(i / 5)) }),
  honk: () => { tone({ f: 520, type: 'square', d: 0.15, v: 0.12, lp: 1500 }); tone({ f: 410, type: 'square', d: 0.25, v: 0.12, lp: 1500, t: 0.2 }); },
  crickets: () => { for (let k = 0; k < 6; k++) for (let j = 0; j < 3; j++) tone({ f: 4600, d: 0.03, v: 0.05, t: k * 0.3 + j * 0.05 }); },
  dundun: () => [[294, 0.25], [277, 0.25], [262, 1.3]].reduce((t, [f, d]) => { tone({ f, type: 'sawtooth', d, v: 0.18, t, lp: 1600 }); tone({ f: f / 2, type: 'triangle', d, v: 0.2, t }); return t + d + 0.05; }, 0),
  bonk: () => { tone({ f: 900, f2: 300, d: 0.12, v: 0.3, type: 'triangle' }); noise({ d: 0.08, v: 0.3, freq: 1800, type: 'bandpass' }); },
};

export function play(name) {
  if (muted || !SOUNDS[name]) return;
  try { SOUNDS[name](); } catch { /* audio unavailable */ }
}

export const sfx = new Proxy({}, { get: (_, name) => () => play(name) });

export function vibrate(pattern) {
  if (!muted && navigator.vibrate) navigator.vibrate(pattern);
}

export const SOUNDBOARD = [
  ['📯', 'Air horn', 'airhorn'],
  ['💨', 'Fart', 'fart'],
  ['🥁', 'Ba dum tss', 'rimshot'],
  ['🎺', 'Sad trombone', 'lose'],
  ['🦘', 'Boing', 'boing'],
  ['💥', 'Boom', 'boom'],
  ['🚨', 'Siren', 'siren'],
  ['🤡', 'Clown honk', 'honk'],
  ['🦗', 'Crickets', 'crickets'],
  ['😱', 'Dun dun DUN', 'dundun'],
  ['🔔', 'Ding', 'ding'],
  ['🔨', 'Bonk', 'bonk'],
];
