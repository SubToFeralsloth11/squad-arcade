// Local profile: name, avatar, XP/levels, unlocks, per-game stats and rival records.
const KEY = 'sa.profile.v1';

export const AVATARS = [
  ['🐸', 1], ['🐱', 1], ['🐶', 1], ['🦊', 1], ['🐼', 2], ['🐵', 2],
  ['🐷', 3], ['🦄', 3], ['🤖', 4], ['👽', 5], ['🐔', 5], ['💀', 6],
  ['🤠', 7], ['🥸', 8], ['🦖', 9], ['🧌', 10], ['🦈', 11], ['🤡', 12],
  ['🧙', 14], ['🥷', 16], ['👹', 18], ['👑', 20], ['🐐', 25], ['🗿', 30],
];

const TITLES = [
  [1, 'Fresh Meat'], [2, 'Button Masher'], [3, 'Snack Enthusiast'], [4, 'Certified Goblin'],
  [5, 'Menace to Society'], [6, 'Lowkey Cracked'], [8, 'Sweaty Tryhard'], [10, 'Main Character'],
  [12, 'Touch Grass Candidate'], [15, 'Unhinged Legend'], [18, 'Final Boss'], [22, 'Literally Unbeatable'], [25, 'THE GOAT'],
];

const ADJ = ['Soggy', 'Feral', 'Spicy', 'Sneaky', 'Chunky', 'Wobbly', 'Crusty', 'Silly', 'Sweaty', 'Grumpy', 'Turbo', 'Sus', 'Moist', 'Cursed', 'Zesty', 'Goofy'];
const NOUN = ['Waffle', 'Goblin', 'Noodle', 'Potato', 'Pickle', 'Nugget', 'Gremlin', 'Burrito', 'Toaster', 'Pigeon', 'Muffin', 'Raccoon', 'Taco', 'Walrus', 'Bean', 'Gecko'];

export function randomName() {
  const p = (a) => a[Math.floor(Math.random() * a.length)];
  return p(ADJ) + ' ' + p(NOUN);
}

export function titleFor(level) {
  let t = TITLES[0][1];
  for (const [lv, name] of TITLES) if (level >= lv) t = name;
  return t;
}

// XP needed to go from `level` to `level + 1`.
export function xpForLevel(level) { return Math.round(100 * Math.pow(1.18, level - 1)); }

export function levelInfo(totalXp) {
  let level = 1, rest = totalXp;
  while (rest >= xpForLevel(level)) { rest -= xpForLevel(level); level++; }
  return { level, into: rest, need: xpForLevel(level) };
}

const today = () => new Date().toISOString().slice(0, 10);

function fresh() {
  return { name: randomName(), avatar: '🐸', xp: 0, streak: 0, lastPlayDay: null, games: {}, rivals: {} };
}

export function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    if (p && typeof p.name === 'string') return { ...fresh(), ...p };
  } catch { /* corrupted: start fresh */ }
  const p = fresh();
  saveProfile(p);
  return p;
}

export function saveProfile(p) { localStorage.setItem(KEY, JSON.stringify(p)); }

export function unlockedAvatars(level) { return AVATARS.filter(([, lv]) => lv <= level).map(([e]) => e); }

/**
 * Record a finished game. `opponents` are display names of the other participants.
 * Returns a breakdown for the results screen.
 */
export function recordGame(p, gameId, won, draw, opponents) {
  const before = levelInfo(p.xp).level;
  const lines = [];
  let xp = 20;
  lines.push('+20 for playing');
  if (won) {
    p.streak += 1;
    const bonus = 40 + 10 * Math.min(p.streak - 1, 5);
    xp += bonus;
    lines.push(`+${bonus} victory${p.streak > 1 ? ` (🔥 ${p.streak} win streak)` : ''}`);
  } else {
    if (!draw && p.streak >= 3) lines.push(`💔 ${p.streak} win streak ended`);
    if (!draw) p.streak = 0;
    if (draw) { xp += 15; lines.push('+15 draw'); }
  }
  if (p.lastPlayDay !== today()) {
    xp += 50;
    lines.push('+50 first game today');
    p.lastPlayDay = today();
  }
  p.xp += xp;
  const g = (p.games[gameId] ||= { played: 0, won: 0 });
  g.played++;
  if (won) g.won++;
  for (const name of opponents) {
    const r = (p.rivals[name] ||= { w: 0, l: 0 });
    if (won) r.w++;
    else if (!draw) r.l++;
  }
  saveProfile(p);
  const after = levelInfo(p.xp).level;
  const unlocked = AVATARS.filter(([, lv]) => lv > before && lv <= after).map(([e]) => e);
  return { xp, lines, levelUp: after > before ? after : null, unlocked };
}
