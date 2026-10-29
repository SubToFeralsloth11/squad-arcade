// Room networking over WebRTC (PeerJS). Star topology: the host's browser is the
// authority. Guests send every message to the host; the host validates, then
// broadcasts. Works across networks: PeerJS' free cloud broker does signalling
// and its STUN/TURN servers get through NATs and mobile data.
/* global Peer */

const PREFIX = 'squadarcade-v1-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const COLORS = ['#ff4d6d', '#4dabff', '#ffd43b', '#51cf66', '#cc5de8', '#ff922b', '#22d3ee', '#f783ac'];
export const MAX_PLAYERS = 8;
const PING_MS = 3000;
const DEAD_MS = 25000;
const PEER_OPTS = { debug: 1 };

const randomCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

export class Room {
  constructor(profile) {
    this.profile = profile;
    this.handlers = {};
    this.peer = null;
    this.id = null;
    this.code = null;
    this.isHost = false;
    this.closed = false;
    this.players = [];
    this.game = null;           // { id, players: [ids], seq }
    this.conns = new Map();     // host: guest id -> DataConnection
    this.hostConn = null;       // guest: connection to host
    this.lastSeen = new Map();
    this.gameSeq = 0;
    this.timer = null;
  }

  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
  player(id) { return this.players.find((p) => p.id === id); }

  // ---------- connect ----------
  host() {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const code = randomCode();
        const peer = new Peer(PREFIX + code, PEER_OPTS);
        let opened = false;
        peer.on('open', (id) => {
          opened = true;
          this.peer = peer;
          this.id = id;
          this.code = code;
          this.isHost = true;
          this.players = [this._makePlayer(id, this.profile)];
          peer.on('connection', (c) => this._onGuest(c));
          this._wirePeer();
          this.timer = setInterval(() => this._hostHeartbeat(), PING_MS);
          this._lobbyChanged();
          resolve(code);
        });
        peer.on('error', (err) => {
          if (opened) return;
          peer.destroy();
          if (err.type === 'unavailable-id' && tries++ < 5) attempt();
          else reject(new Error(err.type === 'network' || err.type === 'server-error'
            ? 'Could not reach the matchmaking server. Check your internet.' : String(err.message || err)));
        });
      };
      attempt();
    });
  }

  join(rawCode) {
    const code = clean(rawCode, 5).toUpperCase();
    return new Promise((resolve, reject) => {
      if (code.length !== 5) { reject(new Error('Room codes are 5 letters')); return; }
      const peer = new Peer(PEER_OPTS);
      let done = false;
      const fail = (e) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        peer.destroy();
        reject(e);
      };
      const timeout = setTimeout(() => fail(new Error('Room did not answer. Is the code right?')), 20000);
      peer.on('open', (id) => {
        const conn = peer.connect(PREFIX + code, {
          reliable: true,
          metadata: { name: this.profile.name, avatar: this.profile.avatar, level: this.profile.level, title: this.profile.title },
        });
        conn.on('open', () => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          this.peer = peer;
          this.id = id;
          this.code = code;
          this.hostConn = conn;
          this.lastSeen.set('host', Date.now());
          this._wirePeer();
          this.timer = setInterval(() => {
            if (Date.now() - this.lastSeen.get('host') > DEAD_MS) this._hostGone();
          }, PING_MS);
          resolve(code);
        });
        conn.on('data', (m) => { this.lastSeen.set('host', Date.now()); this._deliver(m); });
        conn.on('close', () => this._hostGone());
        conn.on('error', () => this._hostGone());
      });
      peer.on('error', (e) => {
        if (e.type === 'peer-unavailable') fail(new Error(`No room called ${code}. Check the code!`));
        else fail(new Error(e.type === 'network' || e.type === 'server-error'
          ? 'Could not reach the matchmaking server. Check your internet.' : String(e.message || e)));
      });
    });
  }

  _wirePeer() {
    this.peer.on('call', (call) => this.emit('call', call));
    this.peer.on('disconnected', () => {
      // Lost the signalling server (not the game connections). Reconnect so new
      // friends and voice calls can still find us.
      if (!this.closed) setTimeout(() => !this.closed && this.peer.disconnected && this.peer.reconnect(), 1500);
    });
  }

  _hostGone() {
    if (this.closed) return;
    this.leave();
    this.emit('hostleft');
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    try { this.peer?.destroy(); } catch { /* already gone */ }
  }

  // ---------- messaging ----------
  /** Any client -> host (host handles its own messages locally). */
  send(m) {
    if (this.closed) return;
    if (this.isHost) this._hostHandle(this.id, m);
    else if (this.hostConn?.open) this.hostConn.send(m);
  }

  /** Host -> everyone, including itself. */
  broadcast(m) {
    if (!this.isHost || this.closed) return;
    for (const c of this.conns.values()) if (c.open) c.send(m);
    this._deliver(m);
  }

  /** Host -> one player. */
  sendTo(id, m) {
    if (!this.isHost || this.closed) return;
    if (id === this.id) this._deliver(m);
    else { const c = this.conns.get(id); if (c?.open) c.send(m); }
  }

  _deliver(m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'ping') { this.send({ t: 'pong' }); return; }
    if (m.t === 'lobby') { this.players = m.players; this.game = m.game; }
    this.emit(m.t, m);
  }

  // ---------- host side ----------
  _makePlayer(id, md) {
    const used = new Set(this.players.map((p) => p.color));
    return {
      id,
      name: clean(md?.name, 16) || 'Mystery Guest',
      avatar: clean(md?.avatar, 8) || '🐸',
      level: Math.max(1, Math.min(999, Number(md?.level) || 1)),
      title: clean(md?.title, 30),
      color: COLORS.find((c) => !used.has(c)) || COLORS[this.players.length % COLORS.length],
      score: 0,
      voice: false,
    };
  }

  _onGuest(conn) {
    conn.on('open', () => {
      if (this.players.length >= MAX_PLAYERS) {
        conn.send({ t: 'full' });
        setTimeout(() => conn.close(), 500);
        return;
      }
      const p = this._makePlayer(conn.peer, conn.metadata);
      this.players.push(p);
      this.conns.set(conn.peer, conn);
      this.lastSeen.set(conn.peer, Date.now());
      this.broadcast({ t: 'sys', text: `${p.avatar} ${p.name} joined the squad` });
      this._lobbyChanged();
    });
    conn.on('data', (m) => {
      if (!this.conns.has(conn.peer)) return;
      this.lastSeen.set(conn.peer, Date.now());
      this._hostHandle(conn.peer, m);
    });
    conn.on('close', () => this._dropGuest(conn.peer));
    conn.on('error', () => this._dropGuest(conn.peer));
  }

  _hostHeartbeat() {
    const now = Date.now();
    for (const [id, c] of this.conns) {
      if (now - (this.lastSeen.get(id) || 0) > DEAD_MS) { this._dropGuest(id); continue; }
      if (c.open) c.send({ t: 'ping' });
    }
  }

  _dropGuest(id) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    this.lastSeen.delete(id);
    try { conn.close(); } catch { /* ignore */ }
    const p = this.player(id);
    this.players = this.players.filter((x) => x.id !== id);
    if (p) this.broadcast({ t: 'sys', text: `${p.avatar} ${p.name} left` });
    if (this.game?.players.includes(id)) {
      this.game = null;
      this.broadcast({ t: 'abort', text: `${p ? p.name : 'Someone'} rage quit 😤` });
    }
    this._lobbyChanged();
  }

  _lobbyChanged() {
    this.broadcast({ t: 'lobby', players: this.players, game: this.game });
  }

  _hostHandle(from, m) {
    if (!m || typeof m.t !== 'string') return;
    const p = this.player(from);
    if (!p) return;
    switch (m.t) {
      case 'chat': {
        const text = clean(m.text, 200);
        if (text) this.broadcast({ t: 'chat', from, text });
        break;
      }
      case 'react':
        this.broadcast({ t: 'react', from, e: clean(m.e, 8) });
        break;
      case 'sb':
        this.broadcast({ t: 'sb', from, s: clean(m.s, 20) });
        break;
      case 'voice':
        p.voice = !!m.on;
        this._lobbyChanged();
        break;
      case 'me':
        p.level = Math.max(1, Math.min(999, Number(m.level) || 1));
        p.title = clean(m.title, 30);
        this._lobbyChanged();
        break;
      case 'start': {
        if (this.game) break;
        const def = this.gameDefs?.[m.game];
        if (!def) break;
        if (this.players.length < def.min) break;
        let ids = this.players.map((x) => x.id);
        if (ids.length > def.max) {
          // Starter always plays; the rest of the seats are random.
          const others = ids.filter((id) => id !== from).sort(() => Math.random() - 0.5);
          ids = [from, ...others.slice(0, def.max - 1)];
        }
        this.game = { id: m.game, players: ids, seq: ++this.gameSeq };
        this._lobbyChanged();
        this.broadcast({ t: 'start', game: this.game, by: from });
        break;
      }
      case 'gin':
        if (this.game?.players.includes(from)) this.emit('ginput', from, m.d);
        break;
      case 'over': {
        if (from !== this.id || !this.game) break;
        const winners = (m.winners || []).filter((id) => this.game.players.includes(id));
        for (const id of winners) { const w = this.player(id); if (w) w.score++; }
        const game = this.game;
        this.game = null;
        this._lobbyChanged();
        this.broadcast({ t: 'over', game, winners, text: clean(m.text, 140) });
        break;
      }
      case 'quit':
        if (!this.game || !this.game.players.includes(from)) break;
        this.game = null;
        this._lobbyChanged();
        this.broadcast({ t: 'abort', text: `${p.name} ended the game` });
        break;
      default:
        break;
    }
  }
}
