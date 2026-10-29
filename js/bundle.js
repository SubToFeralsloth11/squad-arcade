(() => {
  // js/net.js
  var PREFIX = "squadarcade-v1-";
  var CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  var COLORS = ["#ff4d6d", "#4dabff", "#ffd43b", "#51cf66", "#cc5de8", "#ff922b", "#22d3ee", "#f783ac"];
  var MAX_PLAYERS = 8;
  var PING_MS = 3e3;
  var DEAD_MS = 25e3;
  var PEER_OPTS = { debug: 1 };
  var SOCIAL = /* @__PURE__ */ new Set(["chat", "react", "sb", "voice", "me"]);
  var randomCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  var clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);
  var Room = class {
    constructor(profile2) {
      this.profile = profile2;
      this.handlers = {};
      this.peer = null;
      this.id = null;
      this.code = null;
      this.isHost = false;
      this.closed = false;
      this.players = [];
      this.game = null;
      this.conns = /* @__PURE__ */ new Map();
      this.hostConn = null;
      this.lastSeen = /* @__PURE__ */ new Map();
      this.gameSeq = 0;
      this.buckets = /* @__PURE__ */ new Map();
      this.timer = null;
    }
    on(ev, fn) {
      var _a;
      ((_a = this.handlers)[ev] || (_a[ev] = [])).push(fn);
    }
    emit(ev, ...args) {
      for (const fn of this.handlers[ev] || []) fn(...args);
    }
    player(id) {
      return this.players.find((p) => p.id === id);
    }
    // ---------- connect ----------
    host() {
      return new Promise((resolve, reject) => {
        let tries = 0;
        const attempt = () => {
          const code = randomCode();
          const peer = new Peer(PREFIX + code, PEER_OPTS);
          let opened = false;
          peer.on("open", (id) => {
            opened = true;
            this.peer = peer;
            this.id = id;
            this.code = code;
            this.isHost = true;
            this.players = [this._makePlayer(id, this.profile)];
            peer.on("connection", (c) => this._onGuest(c));
            this._wirePeer();
            this.timer = setInterval(() => this._hostHeartbeat(), PING_MS);
            this._lobbyChanged();
            resolve(code);
          });
          peer.on("error", (err) => {
            if (opened) return;
            peer.destroy();
            if (err.type === "unavailable-id" && tries++ < 5) attempt();
            else reject(new Error(err.type === "network" || err.type === "server-error" ? "Could not reach the matchmaking server. Check your internet." : String(err.message || err)));
          });
        };
        attempt();
      });
    }
    join(rawCode) {
      const code = clean(rawCode, 5).toUpperCase();
      return new Promise((resolve, reject) => {
        if (code.length !== 5) {
          reject(new Error("Room codes are 5 letters"));
          return;
        }
        const peer = new Peer(PEER_OPTS);
        let done = false;
        const fail = (e) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          peer.destroy();
          reject(e);
        };
        const timeout = setTimeout(() => fail(new Error("Room did not answer. Is the code right?")), 2e4);
        peer.on("open", (id) => {
          const conn = peer.connect(PREFIX + code, {
            reliable: true,
            metadata: { name: this.profile.name, avatar: this.profile.avatar, level: this.profile.level, title: this.profile.title }
          });
          conn.on("open", () => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            this.peer = peer;
            this.id = id;
            this.code = code;
            this.hostConn = conn;
            this.lastSeen.set("host", Date.now());
            this._wirePeer();
            this.timer = setInterval(() => {
              if (Date.now() - this.lastSeen.get("host") > DEAD_MS) this._hostGone();
            }, PING_MS);
            resolve(code);
          });
          conn.on("data", (m) => {
            this.lastSeen.set("host", Date.now());
            this._deliver(m);
          });
          conn.on("close", () => this._hostGone());
          conn.on("error", () => this._hostGone());
        });
        peer.on("error", (e) => {
          if (e.type === "peer-unavailable") fail(new Error(`No room called ${code}. Check the code!`));
          else fail(new Error(e.type === "network" || e.type === "server-error" ? "Could not reach the matchmaking server. Check your internet." : String(e.message || e)));
        });
      });
    }
    _wirePeer() {
      this.peer.on("call", (call) => this.emit("call", call));
      this.peer.on("disconnected", () => {
        if (!this.closed) setTimeout(() => !this.closed && this.peer.disconnected && this.peer.reconnect(), 1500);
      });
    }
    _hostGone() {
      if (this.closed) return;
      this.leave();
      this.emit("hostleft");
    }
    leave() {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.timer);
      try {
        this.peer?.destroy();
      } catch {
      }
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
      else {
        const c = this.conns.get(id);
        if (c?.open) c.send(m);
      }
    }
    _deliver(m) {
      if (!m || typeof m.t !== "string") return;
      if (m.t === "ping") {
        this.send({ t: "pong" });
        return;
      }
      if (m.t === "lobby") {
        this.players = m.players;
        this.game = m.game;
      }
      this.emit(m.t, m);
    }
    // ---------- host side ----------
    _makePlayer(id, md) {
      const used = new Set(this.players.map((p) => p.color));
      return {
        id,
        name: clean(md?.name, 16) || "Mystery Guest",
        avatar: clean(md?.avatar, 8) || "\u{1F438}",
        level: Math.max(1, Math.min(999, Number(md?.level) || 1)),
        title: clean(md?.title, 30),
        color: COLORS.find((c) => !used.has(c)) || COLORS[this.players.length % COLORS.length],
        score: 0,
        voice: false
      };
    }
    _onGuest(conn) {
      conn.on("open", () => {
        if (this.players.length >= MAX_PLAYERS) {
          conn.send({ t: "full" });
          setTimeout(() => conn.close(), 500);
          return;
        }
        const p = this._makePlayer(conn.peer, conn.metadata);
        this.players.push(p);
        this.conns.set(conn.peer, conn);
        this.lastSeen.set(conn.peer, Date.now());
        this.broadcast({ t: "sys", text: `${p.avatar} ${p.name} joined the squad` });
        this._lobbyChanged();
      });
      conn.on("data", (m) => {
        if (!this.conns.has(conn.peer)) return;
        this.lastSeen.set(conn.peer, Date.now());
        this._hostHandle(conn.peer, m);
      });
      conn.on("close", () => this._dropGuest(conn.peer));
      conn.on("error", () => this._dropGuest(conn.peer));
    }
    _hostHeartbeat() {
      const now = Date.now();
      for (const [id, c] of this.conns) {
        if (now - (this.lastSeen.get(id) || 0) > DEAD_MS) {
          this._dropGuest(id);
          continue;
        }
        if (c.open) c.send({ t: "ping" });
      }
    }
    _dropGuest(id) {
      const conn = this.conns.get(id);
      if (!conn) return;
      this.conns.delete(id);
      this.lastSeen.delete(id);
      this.buckets.delete(id);
      try {
        conn.close();
      } catch {
      }
      const p = this.player(id);
      this.players = this.players.filter((x) => x.id !== id);
      if (p) this.broadcast({ t: "sys", text: `${p.avatar} ${p.name} left` });
      if (this.game?.players.includes(id)) {
        this.game = null;
        this.broadcast({ t: "abort", text: `${p ? p.name : "Someone"} rage quit \u{1F624}` });
      }
      this._lobbyChanged();
    }
    _lobbyChanged() {
      this.broadcast({ t: "lobby", players: this.players, game: this.game });
    }
    // Token bucket for chat/reactions/sounds so one spammy phone can't flood everyone.
    _allow(id) {
      const now = Date.now();
      const b = this.buckets.get(id) || { tokens: 8, at: now };
      b.tokens = Math.min(8, b.tokens + (now - b.at) / 1e3 * 3);
      b.at = now;
      this.buckets.set(id, b);
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    }
    _hostHandle(from, m) {
      if (!m || typeof m.t !== "string") return;
      const p = this.player(from);
      if (!p) return;
      if (SOCIAL.has(m.t) && !this._allow(from)) return;
      switch (m.t) {
        case "chat": {
          const text = clean(m.text, 200);
          if (text) this.broadcast({ t: "chat", from, text });
          break;
        }
        case "react":
          this.broadcast({ t: "react", from, e: clean(m.e, 8) });
          break;
        case "sb":
          this.broadcast({ t: "sb", from, s: clean(m.s, 20) });
          break;
        case "voice":
          p.voice = !!m.on;
          this._lobbyChanged();
          break;
        case "me":
          p.level = Math.max(1, Math.min(999, Number(m.level) || 1));
          p.title = clean(m.title, 30);
          this._lobbyChanged();
          break;
        case "start": {
          if (this.game) break;
          const def = this.gameDefs?.[m.game];
          if (!def) break;
          if (this.players.length < def.min) break;
          let ids = this.players.map((x) => x.id);
          if (ids.length > def.max) {
            const others = ids.filter((id) => id !== from).sort(() => Math.random() - 0.5);
            ids = [from, ...others.slice(0, def.max - 1)];
          }
          this.game = { id: m.game, players: ids, seq: ++this.gameSeq };
          this._lobbyChanged();
          this.broadcast({ t: "start", game: this.game, by: from });
          break;
        }
        case "gin":
          if (this.game?.players.includes(from)) this.emit("ginput", from, m.d);
          break;
        case "over": {
          if (from !== this.id || !this.game) break;
          const winners = [...new Set(m.winners || [])].filter((id) => this.game.players.includes(id));
          for (const id of winners) {
            const w = this.player(id);
            if (w) w.score++;
          }
          const game = this.game;
          this.game = null;
          this._lobbyChanged();
          this.broadcast({ t: "over", game, winners, text: clean(m.text, 140) });
          break;
        }
        case "quit":
          if (!this.game || !this.game.players.includes(from)) break;
          this.game = null;
          this._lobbyChanged();
          this.broadcast({ t: "abort", text: `${p.name} ended the game` });
          break;
        default:
          break;
      }
    }
  };

  // js/sfx.js
  var ctx = null;
  var master = null;
  var muted = localStorage.getItem("sa.muted") === "1";
  function ac() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function audioContext() {
    return ac();
  }
  function isMuted() {
    return muted;
  }
  function setMuted(m) {
    muted = m;
    localStorage.setItem("sa.muted", m ? "1" : "0");
  }
  function tone({ f = 440, f2 = null, type = "sine", d = 0.15, v = 0.25, t = 0, curve = null, lp = null }) {
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
    g.gain.setValueAtTime(1e-4, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(1e-4, t0 + d);
    let out = o;
    if (lp) {
      const flt = c.createBiquadFilter();
      flt.type = "lowpass";
      flt.frequency.value = lp;
      o.connect(flt);
      out = flt;
    }
    out.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + d + 0.05);
  }
  var noiseBuf = null;
  function noise({ d = 0.3, v = 0.3, t = 0, type = "lowpass", freq = 1e3, q = 1, f2 = null }) {
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
    g.gain.exponentialRampToValueAtTime(1e-4, t0 + d);
    src.connect(flt).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + d + 0.05);
  }
  var wobble = (base, depth, n, rate) => Array.from({ length: n }, (_, i) => base + Math.sin(i * rate) * depth + (Math.random() - 0.5) * depth);
  var SOUNDS = {
    click: () => tone({ f: 700, f2: 1e3, type: "square", d: 0.05, v: 0.08 }),
    pop: () => tone({ f: 300, f2: 900, d: 0.08, v: 0.2 }),
    ding: () => {
      tone({ f: 1320, d: 0.6, v: 0.2 });
      tone({ f: 2640, d: 0.4, v: 0.06 });
    },
    coin: () => {
      tone({ f: 988, type: "square", d: 0.08, v: 0.1 });
      tone({ f: 1319, type: "square", d: 0.3, v: 0.1, t: 0.08 });
    },
    beep: () => tone({ f: 660, type: "square", d: 0.12, v: 0.1 }),
    go: () => tone({ f: 1320, type: "square", d: 0.35, v: 0.12 }),
    wrong: () => tone({ f: 160, type: "sawtooth", d: 0.35, v: 0.12, lp: 900 }),
    hit: () => {
      noise({ d: 0.12, v: 0.4, freq: 2500, type: "bandpass" });
      tone({ f: 220, f2: 80, d: 0.12, v: 0.2 });
    },
    splash: () => noise({ d: 0.5, v: 0.25, freq: 3e3, f2: 400, type: "bandpass", q: 0.7 }),
    swoosh: () => noise({ d: 0.25, v: 0.25, freq: 600, f2: 4e3, type: "bandpass", q: 2 }),
    boom: () => {
      noise({ d: 1.1, v: 0.7, freq: 900, f2: 60 });
      tone({ f: 90, f2: 30, d: 0.9, v: 0.5 });
    },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ f, type: "triangle", d: i === 3 ? 0.6 : 0.16, v: 0.22, t: i * 0.12 })),
    lose: () => {
      [392, 370, 349].forEach((f, i) => tone({ f, type: "sawtooth", d: 0.42, v: 0.16, t: i * 0.45, lp: 1400 }));
      tone({ type: "sawtooth", d: 1.2, v: 0.16, t: 1.35, lp: 1400, curve: wobble(330, 9, 40, 0.9) });
    },
    airhorn: () => [0, 0.16, 0.32].forEach((t, i) => {
      const d = i === 2 ? 0.8 : 0.13;
      tone({ f: 370, type: "sawtooth", d, v: 0.18, t, lp: 2600 });
      tone({ f: 466, type: "sawtooth", d, v: 0.15, t, lp: 2600 });
      tone({ f: 554, type: "sawtooth", d, v: 0.1, t, lp: 2600 });
    }),
    fart: () => {
      const d = 0.5 + Math.random() * 0.6;
      tone({ type: "sawtooth", d, v: 0.5, lp: 380, curve: wobble(70 + Math.random() * 30, 25, 60, 2.7) });
      noise({ d, v: 0.12, freq: 220, type: "lowpass" });
    },
    rimshot: () => {
      tone({ f: 220, f2: 120, d: 0.12, v: 0.4 });
      tone({ f: 180, f2: 100, d: 0.15, v: 0.4, t: 0.15 });
      noise({ d: 0.9, v: 0.3, freq: 7e3, type: "highpass", t: 0.42 });
      tone({ f: 120, f2: 60, d: 0.2, v: 0.4, t: 0.42 });
    },
    boing: () => tone({ type: "sine", d: 0.6, v: 0.3, curve: Array.from({ length: 50 }, (_, i) => 160 + 420 * Math.abs(Math.sin(i / 5)) * (1 - i / 60)) }),
    siren: () => tone({ type: "square", d: 1.6, v: 0.08, lp: 2e3, curve: Array.from({ length: 64 }, (_, i) => 750 + 350 * Math.sin(i / 5)) }),
    honk: () => {
      tone({ f: 520, type: "square", d: 0.15, v: 0.12, lp: 1500 });
      tone({ f: 410, type: "square", d: 0.25, v: 0.12, lp: 1500, t: 0.2 });
    },
    crickets: () => {
      for (let k = 0; k < 6; k++) for (let j = 0; j < 3; j++) tone({ f: 4600, d: 0.03, v: 0.05, t: k * 0.3 + j * 0.05 });
    },
    dundun: () => [[294, 0.25], [277, 0.25], [262, 1.3]].reduce((t, [f, d]) => {
      tone({ f, type: "sawtooth", d, v: 0.18, t, lp: 1600 });
      tone({ f: f / 2, type: "triangle", d, v: 0.2, t });
      return t + d + 0.05;
    }, 0),
    bonk: () => {
      tone({ f: 900, f2: 300, d: 0.12, v: 0.3, type: "triangle" });
      noise({ d: 0.08, v: 0.3, freq: 1800, type: "bandpass" });
    }
  };
  function play(name) {
    if (muted || !SOUNDS[name]) return;
    try {
      SOUNDS[name]();
    } catch {
    }
  }
  var sfx = new Proxy({}, { get: (_, name) => () => play(name) });
  function vibrate(pattern) {
    if (!muted && navigator.vibrate) navigator.vibrate(pattern);
  }
  var SOUNDBOARD = [
    ["\u{1F4EF}", "Air horn", "airhorn"],
    ["\u{1F4A8}", "Fart", "fart"],
    ["\u{1F941}", "Ba dum tss", "rimshot"],
    ["\u{1F3BA}", "Sad trombone", "lose"],
    ["\u{1F998}", "Boing", "boing"],
    ["\u{1F4A5}", "Boom", "boom"],
    ["\u{1F6A8}", "Siren", "siren"],
    ["\u{1F921}", "Clown honk", "honk"],
    ["\u{1F997}", "Crickets", "crickets"],
    ["\u{1F631}", "Dun dun DUN", "dundun"],
    ["\u{1F514}", "Ding", "ding"],
    ["\u{1F528}", "Bonk", "bonk"]
  ];

  // js/voice.js
  var Voice = class {
    constructor(room2, { onChange, onSpeaking, onAutoplayBlocked }) {
      this.room = room2;
      this.local = null;
      this.muted = false;
      this.calls = /* @__PURE__ */ new Map();
      this.sinks = /* @__PURE__ */ new Map();
      this.onChange = onChange;
      this.onSpeaking = onSpeaking;
      this.onAutoplayBlocked = onAutoplayBlocked;
      this.localAnalyser = null;
      this.speaking = /* @__PURE__ */ new Set();
      this.meterTimer = setInterval(() => this._meter(), 150);
      room2.on("call", (call) => this._incoming(call));
      room2.on("lobby", () => this._syncPeers());
    }
    get state() {
      return !this.local ? "off" : this.muted ? "muted" : "live";
    }
    async enable() {
      if (this.local) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser blocks microphones (needs HTTPS).");
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      this.muted = false;
      this.localAnalyser = this._analyser(this.local);
      this.room.send({ t: "voice", on: true });
      for (const p of this.room.players) if (p.id !== this.room.id) this._call(p.id);
      this.onChange();
    }
    toggleMute() {
      if (!this.local) return;
      this.muted = !this.muted;
      for (const t of this.local.getAudioTracks()) t.enabled = !this.muted;
      this.room.send({ t: "voice", on: !this.muted });
      this.onChange();
    }
    /** Retry playback after the browser blocked autoplay; must run inside a tap. */
    resumeAudio() {
      audioContext();
      for (const { audio } of this.sinks.values()) audio.play().catch(() => {
      });
    }
    destroy() {
      clearInterval(this.meterTimer);
      for (const c of this.calls.values()) c.close();
      for (const id of [...this.sinks.keys()]) this._dropSink(id);
      this.local?.getTracks().forEach((t) => t.stop());
      this.local = null;
    }
    // New players should hear us; departed players get cleaned up.
    _syncPeers() {
      const ids = new Set(this.room.players.map((p) => p.id));
      for (const id of [...this.calls.keys()]) if (!ids.has(id)) {
        this.calls.get(id).close();
        this.calls.delete(id);
        this._dropSink(id);
      }
      if (!this.local) return;
      for (const id of ids) if (id !== this.room.id && !this.calls.has(id)) this._call(id);
    }
    _call(id) {
      const old = this.calls.get(id);
      this.calls.delete(id);
      old?.close();
      const call = this.room.peer.call(id, this.local);
      if (!call) return;
      call.outgoing = true;
      call.startedAt = Date.now();
      this._wire(call);
    }
    _incoming(call) {
      const mine = this.calls.get(call.peer);
      const glare = mine?.outgoing && !mine.connected && Date.now() - mine.startedAt < 3e3;
      if (glare && this.room.id < call.peer) {
        call.close();
        return;
      }
      this.calls.delete(call.peer);
      mine?.close();
      if (this.local) call.answer(this.local);
      else call.answer();
      this._wire(call);
    }
    _wire(call) {
      this.calls.set(call.peer, call);
      call.on("stream", (stream) => {
        call.connected = true;
        this._play(call.peer, stream);
      });
      const end = () => {
        if (this.calls.get(call.peer) !== call) return;
        this.calls.delete(call.peer);
        this._dropSink(call.peer);
      };
      call.on("close", end);
      call.on("error", end);
    }
    _play(id, stream) {
      this._dropSink(id);
      if (!stream.getAudioTracks().length) return;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.srcObject = stream;
      document.getElementById("audioSinks").append(audio);
      audio.play().catch(() => this.onAutoplayBlocked());
      this.sinks.set(id, { audio, analyser: this._analyser(stream) });
    }
    _dropSink(id) {
      const s = this.sinks.get(id);
      if (!s) return;
      s.audio.srcObject = null;
      s.audio.remove();
      s.analyser?.src.disconnect();
      this.sinks.delete(id);
    }
    _analyser(stream) {
      try {
        const ctx2 = audioContext();
        const src = ctx2.createMediaStreamSource(stream);
        const an = ctx2.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        return { an, src, buf: new Uint8Array(an.fftSize) };
      } catch {
        return null;
      }
    }
    _level(a) {
      if (!a) return 0;
      a.an.getByteTimeDomainData(a.buf);
      let sum = 0;
      for (const v of a.buf) sum += (v - 128) * (v - 128);
      return Math.sqrt(sum / a.buf.length);
    }
    _meter() {
      const now = /* @__PURE__ */ new Set();
      if (this.local && !this.muted && this._level(this.localAnalyser) > 6) now.add(this.room.id);
      for (const [id, s] of this.sinks) if (this._level(s.analyser) > 6) now.add(id);
      const changed = now.size !== this.speaking.size || [...now].some((id) => !this.speaking.has(id));
      this.speaking = now;
      if (changed) this.onSpeaking(now);
    }
  };

  // js/profile.js
  var KEY = "sa.profile.v1";
  var AVATARS = [
    ["\u{1F438}", 1],
    ["\u{1F431}", 1],
    ["\u{1F436}", 1],
    ["\u{1F98A}", 1],
    ["\u{1F43C}", 2],
    ["\u{1F435}", 2],
    ["\u{1F437}", 3],
    ["\u{1F984}", 3],
    ["\u{1F916}", 4],
    ["\u{1F47D}", 5],
    ["\u{1F414}", 5],
    ["\u{1F480}", 6],
    ["\u{1F920}", 7],
    ["\u{1F978}", 8],
    ["\u{1F996}", 9],
    ["\u{1F9CC}", 10],
    ["\u{1F988}", 11],
    ["\u{1F921}", 12],
    ["\u{1F9D9}", 14],
    ["\u{1F977}", 16],
    ["\u{1F479}", 18],
    ["\u{1F451}", 20],
    ["\u{1F410}", 25],
    ["\u{1F5FF}", 30]
  ];
  var TITLES = [
    [1, "Fresh Meat"],
    [2, "Button Masher"],
    [3, "Snack Enthusiast"],
    [4, "Certified Goblin"],
    [5, "Menace to Society"],
    [6, "Lowkey Cracked"],
    [8, "Sweaty Tryhard"],
    [10, "Main Character"],
    [12, "Touch Grass Candidate"],
    [15, "Unhinged Legend"],
    [18, "Final Boss"],
    [22, "Literally Unbeatable"],
    [25, "THE GOAT"]
  ];
  var ADJ = ["Soggy", "Feral", "Spicy", "Sneaky", "Chunky", "Wobbly", "Crusty", "Silly", "Sweaty", "Grumpy", "Turbo", "Sus", "Moist", "Cursed", "Zesty", "Goofy"];
  var NOUN = ["Waffle", "Goblin", "Noodle", "Potato", "Pickle", "Nugget", "Gremlin", "Burrito", "Toaster", "Pigeon", "Muffin", "Raccoon", "Taco", "Walrus", "Bean", "Gecko"];
  function randomName() {
    const p = (a) => a[Math.floor(Math.random() * a.length)];
    return p(ADJ) + " " + p(NOUN);
  }
  function titleFor(level) {
    let t = TITLES[0][1];
    for (const [lv, name] of TITLES) if (level >= lv) t = name;
    return t;
  }
  function xpForLevel(level) {
    return Math.round(100 * Math.pow(1.18, level - 1));
  }
  function levelInfo(totalXp) {
    let level = 1, rest = totalXp;
    while (rest >= xpForLevel(level)) {
      rest -= xpForLevel(level);
      level++;
    }
    return { level, into: rest, need: xpForLevel(level) };
  }
  var today = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  function fresh() {
    const starters = unlockedAvatars(1);
    return { name: randomName(), avatar: starters[Math.floor(Math.random() * starters.length)], xp: 0, streak: 0, lastPlayDay: null, games: {}, rivals: {} };
  }
  function loadProfile() {
    try {
      const p2 = JSON.parse(localStorage.getItem(KEY));
      if (p2 && typeof p2.name === "string") return { ...fresh(), ...p2 };
    } catch {
    }
    const p = fresh();
    saveProfile(p);
    return p;
  }
  function saveProfile(p) {
    localStorage.setItem(KEY, JSON.stringify(p));
  }
  function unlockedAvatars(level) {
    return AVATARS.filter(([, lv]) => lv <= level).map(([e]) => e);
  }
  function recordGame(p, gameId, won, draw, opponents) {
    var _a, _b;
    const before = levelInfo(p.xp).level;
    const lines = [];
    let xp = 20;
    lines.push("+20 for playing");
    if (won) {
      p.streak += 1;
      const bonus = 40 + 10 * Math.min(p.streak - 1, 5);
      xp += bonus;
      lines.push(`+${bonus} victory${p.streak > 1 ? ` (\u{1F525} ${p.streak} win streak)` : ""}`);
    } else {
      if (!draw && p.streak >= 3) lines.push(`\u{1F494} ${p.streak} win streak ended`);
      if (!draw) p.streak = 0;
      if (draw) {
        xp += 15;
        lines.push("+15 draw");
      }
    }
    if (p.lastPlayDay !== today()) {
      xp += 50;
      lines.push("+50 first game today");
      p.lastPlayDay = today();
    }
    p.xp += xp;
    const g = (_a = p.games)[gameId] || (_a[gameId] = { played: 0, won: 0 });
    g.played++;
    if (won) g.won++;
    for (const name of opponents) {
      const r = (_b = p.rivals)[name] || (_b[name] = { w: 0, l: 0 });
      if (won) r.w++;
      else if (!draw) r.l++;
    }
    saveProfile(p);
    const after = levelInfo(p.xp).level;
    const unlocked = AVATARS.filter(([, lv]) => lv > before && lv <= after).map(([e]) => e);
    return { xp, lines, levelUp: after > before ? after : null, unlocked };
  }

  // js/games/util.js
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) el.append(k);
    return el;
  }
  function makeCanvas(api, parent, aspect) {
    const wrap = h("div", { class: "cv-wrap" });
    const c = h("canvas");
    wrap.append(c);
    parent.append(wrap);
    const view = { c, ctx: c.getContext("2d"), w: 1, h: 1, scale: 1, onResize: null };
    const fit = () => {
      const r = wrap.getBoundingClientRect();
      let w = r.width - 8, ht = r.height - 8;
      if (w <= 0 || ht <= 0) return;
      if (w / ht > aspect) w = ht * aspect;
      else ht = w / aspect;
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
  function normPoint(c, e) {
    const r = c.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  }
  var pick = (a) => a[Math.floor(Math.random() * a.length)];
  function shuffle(a) {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }
  var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function header(api, title) {
    const scores = h("div", { class: "gscores" });
    api.el.append(h("div", { class: "ghead" }, h("span", { class: "ttl" }, title), scores));
    return (map) => {
      scores.innerHTML = api.players.map((p) => `<span style="color:${p.color}">${api.esc(p.avatar)}<b>${map[p.id] ?? 0}</b></span>`).join("");
    };
  }
  function leaders(scores) {
    const best = Math.max(...Object.values(scores));
    return Object.keys(scores).filter((id) => scores[id] === best);
  }
  function emoji(ctx2, e, x, y, size) {
    ctx2.font = `${size}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx2.textAlign = "center";
    ctx2.textBaseline = "middle";
    ctx2.fillStyle = "#000";
    ctx2.fillText(e, x, y);
  }

  // js/games/quickdraw.js
  var FAKES = ["BANANA \u{1F34C}", "BAN\u2026", "BAND \u{1F3B8}", "BANJO \u{1FA95}", "BANK \u{1F3E6}", "BANDANA", "BAMBOO \u{1F38B}", "BANG?", "BRB", "BONG \u{1F514}"];
  var EARLY = ["jumped the gun \u{1F921}", "shot their own foot \u{1F9B6}", "has itchy fingers \u{1F633}", "panicked \u{1F480}", "got baited LOL"];
  var TOO_SLOW = ["Nobody shot. Cowards. \u{1F414}", "Everyone fell asleep \u{1F634}", "Tumbleweed rolls by\u2026 \u{1F335}"];
  var quickdraw_default = {
    id: "quickdraw",
    title: "Quick Draw",
    emoji: "\u{1F920}",
    blurb: "Wait for BANG, then tap faster than everyone. Fake-outs WILL get you.",
    min: 2,
    max: 8,
    color: "#e8590c",
    start(api) {
      const target = api.players.length === 2 ? 7 : 5;
      const setScores = header(api, `\u{1F920} First to ${target}`);
      const big = h("div", { class: "big" }, "Get ready\u2026");
      const sub = h("div", { class: "sub" }, "Tap anywhere when you see BANG");
      const area = h("div", { class: "qd" }, big, sub);
      api.el.append(area);
      if (api.spectator) api.el.append(h("div", { class: "spectate" }, "\u{1F440} Spectating"));
      let phase = "ready";
      let round = 0;
      let goAt = 0;
      let tapped = false;
      const show = (ph, text, subText = "") => {
        area.className = `qd ph-${ph}`;
        big.textContent = text;
        sub.innerHTML = subText;
      };
      api.listen(area, "pointerdown", (e) => {
        e.preventDefault();
        if (api.spectator || tapped) return;
        if (phase === "wait" || phase === "fake") {
          tapped = true;
          api.send({ early: true, round });
          show("early", "\u{1F921} TOO EARLY", "Wait for it next time\u2026");
          api.sfx.wrong();
          api.vibrate(200);
        } else if (phase === "go") {
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
        if (s.phase === "ready") {
          tapped = false;
          show("ready", `Round ${s.round}`, "Hands off the screen\u2026 \u{1FAF3}");
          api.sfx.beep();
        } else if (s.phase === "wait") {
          if (!tapped) show("wait", "Wait for it\u2026", s.again ? "That wasn't it \u{1F60F}" : "\u{1F92B}");
        } else if (s.phase === "fake") {
          if (!tapped) show("fake", s.word, "");
          api.sfx.click();
        } else if (s.phase === "go") {
          goAt = performance.now();
          if (!tapped) show("go", "BANG! \u{1F4A5}", "TAP TAP TAP");
          api.sfx.boom();
        } else if (s.phase === "result") {
          const lines = Object.entries(s.times).sort((a, b) => a[1] - b[1]).map(([id, ms]) => `${api.tag(id)} ${ms} ms`).join("<br>");
          if (s.early) {
            show("early", "\u{1F921}", `${api.tag(s.early)} ${api.esc(s.msg)}<br>Everyone else +1`);
            if (s.early !== api.me) api.sfx.rimshot();
          } else if (s.winner) {
            show("ready", s.winner === api.me ? "\u{1F3AF} YOU!" : `${api.avatar(s.winner)} wins`, lines);
            if (s.winner === api.me) {
              api.sfx.coin();
              api.vibrate([40, 30, 40]);
            }
          } else show("ready", "\u{1F335}", api.esc(s.msg));
        }
      });
      if (!api.isHost) return;
      const ids = api.players.map((p) => p.id);
      const scores = Object.fromEntries(ids.map((id) => [id, 0]));
      let state = "ready";
      let taps = {};
      let token = 0;
      const later = (ms, fn) => {
        const t = token;
        api.after(ms, () => {
          if (t === token) fn();
        });
      };
      const newRound = () => {
        token++;
        round++;
        taps = {};
        state = "ready";
        api.broadcast({ phase: "ready", round, scores });
        later(1300, () => {
          state = "wait";
          api.broadcast({ phase: "wait", round, scores });
          const delay = 1500 + Math.random() * 3500;
          const faked = Math.random() < 0.45;
          if (faked) {
            later(delay * 0.55, () => {
              state = "fake";
              api.broadcast({ phase: "fake", round, word: pick(FAKES), scores });
              later(800, () => {
                state = "wait";
                api.broadcast({ phase: "wait", again: true, round, scores });
              });
            });
          }
          later(delay + (faked ? 1300 : 0), () => {
            state = "go";
            api.broadcast({ phase: "go", round, scores });
            later(2500, resolve);
          });
        });
      };
      const checkEnd = () => {
        const top = leaders(scores);
        if (scores[top[0]] >= target && top.length === 1) {
          later(2200, () => api.finish(top, `Fastest hand in the west \u{1F920} (${scores[top[0]]} points)`));
          return true;
        }
        return false;
      };
      const resolve = () => {
        if (state !== "go") return;
        token++;
        state = "result";
        const entries = Object.entries(taps).sort((a, b) => a[1] - b[1]);
        const winner = entries[0]?.[0] || null;
        if (winner) scores[winner]++;
        api.broadcast({ phase: "result", round, times: taps, winner, scores, msg: winner ? "" : pick(TOO_SLOW) });
        if (!checkEnd()) later(2600, newRound);
      };
      api.onInput((from, d) => {
        if (!d || d.round !== round || taps[from] != null) return;
        const robot = typeof d.ms === "number" && d.ms < 90;
        if ((d.early || robot) && (state === "wait" || state === "fake" || state === "go")) {
          token++;
          state = "result";
          for (const id of ids) if (id !== from) scores[id]++;
          const msg = robot ? "is tapping faster than humanly possible \u{1F916}" : pick(EARLY);
          api.broadcast({ phase: "result", round, times: {}, early: from, msg, scores });
          if (!checkEnd()) later(2600, newRound);
        } else if (typeof d.ms === "number" && state === "go") {
          taps[from] = Math.min(5e3, Math.round(d.ms));
          if (Object.keys(taps).length === ids.length) resolve();
        }
      });
      newRound();
    }
  };

  // js/games/doodle.js
  var WORDS = `pizza,toilet,banana,unicorn,zombie,spaghetti,dinosaur,hamburger,skateboard,volcano,mermaid,ninja,robot,cactus,octopus,
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
sweat,tears,angry mom,stinky cheese,running late,traffic jam,bad haircut,food fight,pillow fight,sleepwalking,monday`.split(",").map((w) => w.trim()).filter(Boolean);
  var COLORS2 = ["#111111", "#ffffff", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#007aff", "#af52de", "#8b5a2b", "#ff7eb6"];
  var SIZES = [4, 9, 18, 34];
  var DRAW_MS = 8e4;
  var CHOOSE_MS = 15e3;
  var norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  function containsAnswer(guess, w) {
    const words = String(guess).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      let joined = "";
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
  var maskOf = (word, shown) => [...word].map((ch, i) => ch === " " ? " " : shown.has(i) ? ch : "_").join("");
  var doodle_default = {
    id: "doodle",
    title: "Doodle Duel",
    emoji: "\u{1F3A8}",
    blurb: "Draw terribly. Guess wildly. Everyone sees your wrong guesses.",
    min: 2,
    max: 8,
    color: "#7048e8",
    start(api) {
      const setScores = header(api, "\u{1F3A8} Doodle Duel");
      const status = h("div", { class: "status" });
      api.el.append(status);
      const view = makeCanvas(api, api.el, 1);
      const tools = h("div", { class: "dd-tools hidden" });
      const feed = h("div", { class: "dd-feed" });
      const guessInput = h("input", { maxlength: "40", placeholder: "Type your guess\u2026", autocomplete: "off", enterkeyhint: "send" });
      const guessForm = h("form", { class: "dd-guess" }, guessInput, h("button", { class: "btn primary small" }, "Guess"));
      api.el.append(tools, feed, guessForm);
      let strokes = [];
      let drawer = null;
      let mask = "";
      let myWord = null;
      let deadline = 0;
      let color = COLORS2[0];
      let size = SIZES[1];
      let overlay = null;
      const amDrawer = () => drawer === api.me;
      const paintSeg = ([x0, y0, x1, y1, c, w]) => {
        const { ctx: ctx2 } = view;
        ctx2.strokeStyle = c;
        ctx2.lineWidth = w / 400 * view.w;
        ctx2.lineCap = "round";
        ctx2.beginPath();
        ctx2.moveTo(x0 * view.w, y0 * view.h);
        ctx2.lineTo(x1 * view.w, y1 * view.h);
        ctx2.stroke();
      };
      const repaint = () => {
        view.ctx.fillStyle = "#fff";
        view.ctx.fillRect(0, 0, view.w, view.h);
        for (const s of strokes) paintSeg(s);
      };
      view.onResize = repaint;
      repaint();
      let last = null;
      api.listen(view.c, "pointerdown", (e) => {
        if (!amDrawer() || overlay) return;
        view.c.setPointerCapture(e.pointerId);
        last = normPoint(view.c, e);
        const seg = [last[0], last[1], last[0], last[1], color, size];
        strokes.push(seg);
        paintSeg(seg);
        api.send({ seg });
      });
      api.listen(view.c, "pointermove", (e) => {
        if (!last || !amDrawer()) return;
        const p = normPoint(view.c, e);
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 4e-3) return;
        const seg = [last[0], last[1], p[0], p[1], color, size];
        last = p;
        strokes.push(seg);
        paintSeg(seg);
        api.send({ seg });
      });
      const stop = () => {
        last = null;
      };
      api.listen(view.c, "pointerup", stop);
      api.listen(view.c, "pointercancel", stop);
      const buildTools = () => {
        tools.innerHTML = "";
        for (const c of COLORS2) {
          tools.append(h("button", { class: `sw ${c === color ? "sel" : ""}`, style: `background:${c}`, onclick: () => {
            color = c;
            buildTools();
          } }));
        }
        for (const s of SIZES) {
          const dot = h("i", { style: `width:${Math.max(4, s * 0.6)}px;height:${Math.max(4, s * 0.6)}px` });
          tools.append(h("button", { class: `sz ${s === size ? "sel" : ""}`, onclick: () => {
            size = s;
            buildTools();
          } }, dot));
        }
        tools.append(h("button", { class: "btn ghost small", onclick: () => api.send({ clear: true }) }, "\u{1F5D1}\uFE0F"));
      };
      buildTools();
      const addFeed = (html) => {
        feed.append(h("div", {}, ""));
        feed.lastChild.innerHTML = html;
        while (feed.children.length > 60) feed.firstChild.remove();
        feed.scrollTop = feed.scrollHeight;
      };
      api.listen(guessForm, "submit", (e) => {
        e.preventDefault();
        const text = guessInput.value.trim();
        if (!text || amDrawer() || myWord || api.spectator) return;
        api.send({ guess: text.slice(0, 40) });
        guessInput.value = "";
      });
      const renderStatus = () => {
        const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1e3));
        if (!drawer) return;
        const who = amDrawer() ? "\u270F\uFE0F You draw" : `\u270F\uFE0F ${api.tag(drawer)}`;
        const word = myWord ? `<span class="dd-mask">${api.esc(myWord.toUpperCase())}</span>` : `<span class="dd-mask">${api.esc(mask)}</span>`;
        status.innerHTML = deadline ? `${who} \xB7 ${word} \xB7 \u23F1\uFE0F ${secs}s` : `${who} \xB7 ${word}`;
      };
      api.every(250, renderStatus);
      const closeOverlay = () => {
        overlay?.remove();
        overlay = null;
      };
      api.onState((s) => {
        if (s.scores) setScores(s.scores);
        switch (s.k) {
          case "choose":
            closeOverlay();
            drawer = s.drawer;
            myWord = null;
            mask = "";
            strokes = [];
            repaint();
            deadline = Date.now() + CHOOSE_MS;
            tools.classList.toggle("hidden", !amDrawer());
            guessForm.classList.toggle("hidden", amDrawer() || api.spectator);
            addFeed(`<i>\u2014 Turn ${s.turn}/${s.total}: ${api.tag(drawer)} is picking a word\u2026 \u2014</i>`);
            status.innerHTML = `${api.tag(drawer)} is choosing a word\u2026 \u{1F914}`;
            break;
          case "choices":
            closeOverlay();
            overlay = h("div", { class: "dd-choices" }, h("h3", {}, "Pick something to draw \u{1F3A8}"));
            s.words.forEach((w, i) => overlay.append(h("button", {
              class: "btn secondary",
              onclick: () => {
                api.send({ choose: i });
                closeOverlay();
              }
            }, w)));
            api.el.append(overlay);
            api.sfx.ding();
            break;
          case "draw":
            closeOverlay();
            mask = s.mask;
            deadline = Date.now() + s.ms;
            if (amDrawer()) api.toast("\u270F\uFE0F Draw it! No letters allowed \u{1F624}");
            api.sfx.go();
            renderStatus();
            break;
          case "word":
            myWord = s.word;
            renderStatus();
            break;
          case "hint":
            mask = s.mask;
            renderStatus();
            break;
          case "seg":
            if (s.from === api.me) break;
            strokes.push(s.seg);
            paintSeg(s.seg);
            break;
          case "clear":
            strokes = [];
            repaint();
            break;
          case "feed":
            if (s.type === "guess") addFeed(`${api.tag(s.from)}: ${api.esc(s.text)}`);
            else if (s.type === "ok") {
              addFeed(`<span class="ok">\u2705 ${api.esc(api.name(s.from))} got it! +${s.pts}</span>`);
              if (s.from === api.me) {
                api.sfx.coin();
                api.vibrate([30, 30, 30]);
              } else api.sfx.ding();
            } else if (s.type === "close") {
              addFeed(`<span class="close">\u{1F525} "${api.esc(s.text)}" is SO close!</span>`);
              api.sfx.beep();
            }
            break;
          case "reveal":
            closeOverlay();
            deadline = 0;
            myWord = s.word;
            renderStatus();
            addFeed(`<b>The word was \u201C${api.esc(s.word)}\u201D</b> ${s.nobody ? "\u2014 nobody got it \u{1F480}" : ""}`);
            if (s.nobody) api.sfx.lose();
            break;
          default:
            break;
        }
      });
      if (!api.isHost) return;
      const ids = api.players.map((p) => p.id);
      const scores = Object.fromEntries(ids.map((id) => [id, 0]));
      const rounds = ids.length === 2 ? 3 : 2;
      const order = [];
      for (let r = 0; r < rounds; r++) order.push(...ids);
      const used = /* @__PURE__ */ new Set();
      let turn = -1;
      let t = null;
      let token = 0;
      const later = (ms, fn) => {
        const k = token;
        api.after(ms, () => {
          if (k === token) fn();
        });
      };
      const nextTurn = () => {
        token++;
        turn++;
        if (turn >= order.length) {
          api.finish(leaders(scores), "Picasso who? \u{1F5BC}\uFE0F");
          return;
        }
        const choices = shuffle(WORDS.filter((w) => !used.has(w))).slice(0, 3);
        t = { drawer: order[turn], choices, word: null, guessed: /* @__PURE__ */ new Set(), shown: /* @__PURE__ */ new Set(), startAt: 0 };
        api.broadcast({ k: "choose", drawer: t.drawer, turn: turn + 1, total: order.length, scores });
        api.sendTo(t.drawer, { k: "choices", words: choices });
        later(CHOOSE_MS, () => beginDraw(0));
      };
      const beginDraw = (i) => {
        if (!t || t.word) return;
        token++;
        t.word = t.choices[i] ?? t.choices[0];
        used.add(t.word);
        t.startAt = Date.now();
        api.broadcast({ k: "draw", mask: maskOf(t.word, t.shown), ms: DRAW_MS, scores });
        api.sendTo(t.drawer, { k: "word", word: t.word });
        const letters = [...t.word].map((ch, idx) => ch === " " ? -1 : idx).filter((x) => x >= 0);
        const hint = () => {
          const hidden = shuffle(letters.filter((x) => !t.shown.has(x)));
          if (hidden.length <= 1) return;
          t.shown.add(hidden[0]);
          api.broadcast({ k: "hint", mask: maskOf(t.word, t.shown) });
        };
        later(DRAW_MS * 0.5, hint);
        later(DRAW_MS * 0.75, hint);
        later(DRAW_MS, endTurn);
      };
      const endTurn = () => {
        token++;
        const nobody = t.guessed.size === 0;
        api.broadcast({ k: "reveal", word: t.word, nobody, scores });
        later(4e3, nextTurn);
      };
      api.onInput((from, d) => {
        if (!t || !d) return;
        if (from === t.drawer) {
          if (typeof d.choose === "number" && !t.word) beginDraw(Math.max(0, Math.min(2, d.choose | 0)));
          else if (Array.isArray(d.seg) && t.word && d.seg.length === 6) {
            const [x0, y0, x1, y1, c, w2] = d.seg;
            const ok = [x0, y0, x1, y1].every((v) => typeof v === "number" && v >= 0 && v <= 1) && COLORS2.includes(c) && SIZES.includes(w2);
            if (ok) api.broadcast({ k: "seg", seg: d.seg, from });
          } else if (d.clear && t.word) api.broadcast({ k: "clear" });
          return;
        }
        if (typeof d.guess !== "string" || !t.word || t.guessed.has(from)) return;
        const g = norm(d.guess);
        const w = norm(t.word);
        if (!g) return;
        if (g === w || containsAnswer(d.guess, w)) {
          const remain = Math.max(0, DRAW_MS - (Date.now() - t.startAt));
          const pts = 50 + Math.round(150 * remain / DRAW_MS) + (t.guessed.size === 0 ? 30 : 0);
          t.guessed.add(from);
          scores[from] += pts;
          scores[t.drawer] += 40;
          api.broadcast({ k: "feed", type: "ok", from, pts, scores });
          api.sendTo(from, { k: "word", word: t.word });
          if (t.guessed.size >= ids.length - 1) endTurn();
        } else if (g.includes(w) || w.length > 3 && lev(g, w) <= (w.length > 6 ? 2 : 1)) {
          api.sendTo(from, { k: "feed", type: "close", text: d.guess.slice(0, 40) });
        } else {
          api.broadcast({ k: "feed", type: "guess", from, text: d.guess.slice(0, 40) });
        }
      });
      nextTurn();
    }
  };

  // js/games/tron.js
  var W = 30;
  var H = 42;
  var SPAWNS = [[0.35, 0.9, 0], [0.65, 0.1, 2], [0.07, 0.35, 1], [0.93, 0.65, 3], [0.07, 0.65, 1], [0.93, 0.35, 3]];
  var DX = [0, 1, 0, -1];
  var DY = [-1, 0, 1, 0];
  var CRASH = ["ate the wall \u{1F9F1}", "forgot how to turn \u{1F480}", "got boxed in \u{1F4E6}", "crashed and burned \u{1F525}", "speedran a loss \u{1F3C3}", "is now a pancake \u{1F95E}"];
  var tron_default = {
    id: "tron",
    title: "Light Cycles",
    emoji: "\u{1F3CD}\uFE0F",
    blurb: "Swipe to steer. Trap your friends with your trail. It gets FAST.",
    min: 2,
    max: 6,
    color: "#0c8599",
    start(api) {
      const target = api.players.length === 2 ? 5 : 3;
      const setScores = header(api, `\u{1F3CD}\uFE0F First to ${target}`);
      const status = h("div", { class: "status" }, "Get ready\u2026");
      api.el.append(status);
      const view = makeCanvas(api, api.el, W / H);
      const center = h("div", { class: "center-msg" });
      view.c.parentElement.append(center);
      const pad = h("div", { class: "dpad" });
      const dirs = [["u", "\u2B06\uFE0F", 0], ["l", "\u2B05\uFE0F", 3], ["d", "\u2B07\uFE0F", 2], ["r", "\u27A1\uFE0F", 1]];
      for (const [cls, label, d] of dirs) {
        const b = h("button", { class: cls }, label);
        api.listen(b, "pointerdown", (e) => {
          e.preventDefault();
          steer(d);
        });
        pad.append(b);
      }
      if (!api.spectator) api.el.append(pad);
      const myIdx = api.players.findIndex((p) => p.id === api.me);
      let grid = new Int8Array(W * H);
      let heads = [];
      let alive = [];
      let running = false;
      let countdownEnd = 0;
      let flash = [];
      function steer(d) {
        if (api.spectator) return;
        api.send({ d });
      }
      let sx = 0, sy = 0, swiping = false;
      api.listen(view.c, "pointerdown", (e) => {
        swiping = true;
        sx = e.clientX;
        sy = e.clientY;
      });
      api.listen(view.c, "pointermove", (e) => {
        if (!swiping) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.hypot(dx, dy) < 24) return;
        steer(Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 1 : 3 : dy > 0 ? 2 : 0);
        sx = e.clientX;
        sy = e.clientY;
      });
      api.listen(view.c, "pointerup", () => {
        swiping = false;
      });
      api.listen(window, "keydown", (e) => {
        const k = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 }[e.code];
        if (k != null) {
          e.preventDefault();
          steer(k);
        }
      });
      api.loop(() => {
        const { ctx: ctx2 } = view;
        const cs = view.w / W;
        ctx2.fillStyle = "#07061a";
        ctx2.fillRect(0, 0, view.w, view.h);
        ctx2.strokeStyle = "#ffffff0d";
        ctx2.lineWidth = 1;
        ctx2.beginPath();
        for (let x = 0; x <= W; x++) {
          ctx2.moveTo(x * cs, 0);
          ctx2.lineTo(x * cs, view.h);
        }
        for (let y = 0; y <= H; y++) {
          ctx2.moveTo(0, y * cs);
          ctx2.lineTo(view.w, y * cs);
        }
        ctx2.stroke();
        for (let i = 0; i < grid.length; i++) {
          const o = grid[i];
          if (!o) continue;
          ctx2.fillStyle = api.players[o - 1].color;
          ctx2.globalAlpha = alive[o - 1] ? 0.85 : 0.3;
          ctx2.fillRect(i % W * cs + 1, Math.floor(i / W) * cs + 1, cs - 2, cs - 2);
        }
        ctx2.globalAlpha = 1;
        heads.forEach(([x, y], i) => {
          if (!alive[i]) return;
          ctx2.shadowColor = api.players[i].color;
          ctx2.shadowBlur = cs * 1.2;
          ctx2.fillStyle = "#fff";
          ctx2.fillRect(x * cs, y * cs, cs, cs);
          ctx2.shadowBlur = 0;
          if (!running || i === myIdx) emoji(ctx2, api.players[i].avatar, x * cs + cs / 2, y * cs - cs * (i === myIdx && !running ? 1.6 : 0.9), cs * (i === myIdx && !running ? 2 : 1.2));
        });
        const now = performance.now();
        flash = flash.filter((f) => now - f.t < 600);
        for (const f of flash) {
          const k = (now - f.t) / 600;
          ctx2.globalAlpha = 1 - k;
          ctx2.fillStyle = "#ffd43b";
          ctx2.beginPath();
          ctx2.arc((f.x + 0.5) * cs, (f.y + 0.5) * cs, cs * (1 + k * 4), 0, Math.PI * 2);
          ctx2.fill();
          ctx2.globalAlpha = 1;
        }
        if (countdownEnd) {
          const left = Math.ceil((countdownEnd - Date.now()) / 1e3);
          center.textContent = left > 0 ? String(left) : "";
          if (left <= 0) countdownEnd = 0;
        }
      });
      api.onState((s) => {
        if (s.scores) setScores(s.scores);
        if (s.k === "r") {
          grid = new Int8Array(W * H);
          heads = s.spawns.map(([x, y]) => [x, y]);
          alive = s.spawns.map(() => true);
          heads.forEach(([x, y], i) => {
            grid[y * W + x] = i + 1;
          });
          running = false;
          countdownEnd = Date.now() + s.wait;
          status.innerHTML = myIdx >= 0 ? `Round ${s.round} \u2014 you're <b style="color:${api.players[myIdx].color}">this colour</b> ${api.esc(api.players[myIdx].avatar)}` : `Round ${s.round}`;
          api.sfx.beep();
        } else if (s.k === "t") {
          if (!running) {
            running = true;
            center.textContent = "";
            api.sfx.go();
          }
          s.h.forEach((p, i) => {
            if (!p) return;
            heads[i] = p;
            grid[p[1] * W + p[0]] = i + 1;
          });
          for (const i of s.dead || []) {
            alive[i] = false;
            flash.push({ x: heads[i][0], y: heads[i][1], t: performance.now() });
            const pl = api.players[i];
            status.innerHTML = `\u{1F4A5} ${api.tag(pl.id)} ${api.esc(s.msg)}`;
            if (i === myIdx) {
              api.sfx.boom();
              api.vibrate(300);
              api.shake();
            } else api.sfx.hit();
          }
        } else if (s.k === "e") {
          running = false;
          if (s.winner) {
            center.textContent = s.winner === api.me ? "\u{1F3C6}" : api.avatar(s.winner);
            status.innerHTML = `${api.tag(s.winner)} survives the round!`;
            if (s.winner === api.me) api.sfx.coin();
          } else {
            center.textContent = "\u{1F91D}";
            status.textContent = "Everybody died. Beautiful.";
          }
        }
      });
      if (!api.isHost) return;
      const ids = api.players.map((p) => p.id);
      const n = ids.length;
      const scores = Object.fromEntries(ids.map((id) => [id, 0]));
      let hGrid, hHeads, hDir, hAlive, queues, ticks, round = 0, token = 0;
      const later = (ms, fn) => {
        const k = token;
        api.after(ms, () => {
          if (k === token) fn();
        });
      };
      const newRound = () => {
        token++;
        round++;
        hGrid = new Uint8Array(W * H);
        hHeads = [];
        hDir = [];
        hAlive = [];
        queues = [];
        ticks = 0;
        for (let i = 0; i < n; i++) {
          const [fx, fy, d] = SPAWNS[i];
          const x = Math.round(fx * (W - 1)), y = Math.round(fy * (H - 1));
          hHeads.push([x, y]);
          hDir.push(d);
          hAlive.push(true);
          queues.push([]);
          hGrid[y * W + x] = 1;
        }
        api.broadcast({ k: "r", round, wait: 3e3, spawns: hHeads.map(([x, y], i) => [x, y, hDir[i]]), scores });
        later(3e3, tick);
      };
      const tick = () => {
        ticks++;
        const next = [];
        for (let i = 0; i < n; i++) {
          if (!hAlive[i]) {
            next.push(null);
            continue;
          }
          const q = queues[i];
          while (q.length) {
            const d = q.shift();
            if (d !== hDir[i] && (d + 2) % 4 !== hDir[i]) {
              hDir[i] = d;
              break;
            }
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
        const moved = next.map((p, i) => p && !dead.includes(i) ? p : null);
        moved.forEach((p, i) => {
          if (p) {
            hHeads[i] = p;
            hGrid[p[1] * W + p[0]] = 1;
          }
        });
        for (const i of dead) hAlive[i] = false;
        api.broadcast({ k: "t", h: moved, dead, msg: dead.length ? CRASH[Math.floor(Math.random() * CRASH.length)] : "" });
        const left = hAlive.map((a, i) => a ? i : -1).filter((i) => i >= 0);
        if (left.length <= 1) {
          token++;
          const winner = left.length === 1 ? ids[left[0]] : null;
          if (winner) scores[winner]++;
          api.broadcast({ k: "e", winner, scores });
          const top = leaders(scores);
          if (top.length === 1 && scores[top[0]] >= target) later(2200, () => api.finish(top, "Undisputed lord of the grid \u{1F3CD}\uFE0F"));
          else later(2500, newRound);
          return;
        }
        const speed = Math.max(55, 115 - Math.floor(ticks / 12) * 3);
        later(speed, tick);
      };
      api.onInput((from, d) => {
        const i = ids.indexOf(from);
        if (i < 0 || !queues || typeof d?.d !== "number" || d.d < 0 || d.d > 3) return;
        if (queues[i].length < 3) queues[i].push(d.d | 0);
      });
      newRound();
    }
  };

  // js/games/hockey.js
  var TW = 1;
  var TH = 1.6;
  var MR = 0.085;
  var PR = 0.05;
  var GOAL = 0.36;
  var MAX_PUCK = 3.2;
  var MAX_MALLET = 5;
  var TARGET = 7;
  var TAUNTS = ["\u{1F945} GOOOAL!", "\u{1F680} ROCKET!", "\u{1F9C8} Butter fingers!", "\u{1F624} Not again!", "\u{1F3AF} Sniped!", "\u{1FAA6} RIP defence"];
  var hockey_default = {
    id: "hockey",
    title: "Air Hockey",
    emoji: "\u{1F3D2}",
    blurb: "Drag your mallet, smash the puck. First to 7. Pure chaos on a phone.",
    min: 2,
    max: 2,
    color: "#1c7ed6",
    start(api) {
      const setScores = header(api, `\u{1F3D2} First to ${TARGET}`);
      const status = h("div", { class: "status" }, "Drag your mallet!");
      api.el.append(status);
      const view = makeCanvas(api, api.el, TW / TH);
      const center = h("div", { class: "center-msg" });
      view.c.parentElement.append(center);
      const side = api.players.findIndex((p2) => p2.id === api.me);
      const flip = side === 1;
      const toView = (x, y) => flip ? [TW - x, TH - y] : [x, y];
      let puck = [TW / 2, TH / 2];
      let shownPuck = [...puck];
      let mallets = [[TW / 2, TH - 0.2], [TW / 2, 0.2]];
      let shown = mallets.map((m2) => [...m2]);
      let mine = null;
      let lastSend = 0;
      let trail = [];
      const aim = (e) => {
        if (side < 0) return;
        const [nx, ny] = normPoint(view.c, e);
        let x = nx * TW, y = ny * TH - 0.06;
        if (flip) {
          x = TW - x;
          y = TH - y;
        }
        const lo = side === 0 ? TH / 2 + MR : MR;
        const hi = side === 0 ? TH - MR : TH / 2 - MR;
        mine = [clamp(x, MR, TW - MR), clamp(y, lo, hi)];
        const now = performance.now();
        if (now - lastSend > 16) {
          lastSend = now;
          api.send({ m: mine });
        }
      };
      api.listen(view.c, "pointerdown", (e) => {
        view.c.setPointerCapture(e.pointerId);
        aim(e);
      });
      api.listen(view.c, "pointermove", (e) => {
        if (e.buttons || e.pointerType === "touch") aim(e);
      });
      api.loop(() => {
        const { ctx: ctx2 } = view;
        const s = view.w / TW;
        for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) shown[k][j] += (mallets[k][j] - shown[k][j]) * 0.45;
        if (mine) shown[side] = mine;
        for (let j = 0; j < 2; j++) shownPuck[j] += (puck[j] - shownPuck[j]) * 0.6;
        ctx2.fillStyle = "#e9f4ff";
        ctx2.fillRect(0, 0, view.w, view.h);
        ctx2.strokeStyle = "#ff4d6d66";
        ctx2.lineWidth = s * 0.012;
        ctx2.beginPath();
        ctx2.moveTo(0, view.h / 2);
        ctx2.lineTo(view.w, view.h / 2);
        ctx2.stroke();
        ctx2.beginPath();
        ctx2.arc(view.w / 2, view.h / 2, s * 0.16, 0, Math.PI * 2);
        ctx2.stroke();
        const gx = (TW - GOAL) / 2 * s;
        ctx2.fillStyle = "#212529";
        ctx2.fillRect(gx, 0, GOAL * s, s * 0.025);
        ctx2.fillRect(gx, view.h - s * 0.025, GOAL * s, s * 0.025);
        ctx2.strokeStyle = "#4dabff66";
        ctx2.beginPath();
        ctx2.arc(view.w / 2, view.h, s * 0.22, Math.PI, 0);
        ctx2.stroke();
        ctx2.beginPath();
        ctx2.arc(view.w / 2, 0, s * 0.22, 0, Math.PI);
        ctx2.stroke();
        const [px, py] = toView(...shownPuck);
        trail.push([px, py]);
        if (trail.length > 8) trail.shift();
        trail.forEach(([x, y], i) => {
          ctx2.globalAlpha = i / trail.length * 0.25;
          ctx2.fillStyle = "#212529";
          ctx2.beginPath();
          ctx2.arc(x * s, y * s, PR * s, 0, Math.PI * 2);
          ctx2.fill();
        });
        ctx2.globalAlpha = 1;
        ctx2.fillStyle = "#212529";
        ctx2.beginPath();
        ctx2.arc(px * s, py * s, PR * s, 0, Math.PI * 2);
        ctx2.fill();
        ctx2.strokeStyle = "#ffd43b";
        ctx2.lineWidth = s * 8e-3;
        ctx2.beginPath();
        ctx2.arc(px * s, py * s, PR * s * 0.6, 0, Math.PI * 2);
        ctx2.stroke();
        api.players.forEach((p2, i) => {
          const [mx, my] = toView(...shown[i]);
          ctx2.fillStyle = p2.color;
          ctx2.beginPath();
          ctx2.arc(mx * s, my * s, MR * s, 0, Math.PI * 2);
          ctx2.fill();
          ctx2.fillStyle = "#ffffff55";
          ctx2.beginPath();
          ctx2.arc(mx * s, my * s, MR * s * 0.55, 0, Math.PI * 2);
          ctx2.fill();
          emoji(ctx2, p2.avatar, mx * s, my * s, MR * s * 1.1);
        });
      });
      api.onState((st) => {
        if (st.p) {
          puck = st.p;
          mallets = st.m;
        }
        if (st.sc) setScores(Object.fromEntries(api.players.map((p2, i) => [p2.id, st.sc[i]])));
        if (st.hit) {
          api.sfx.bonk();
          if (st.hit === side + 1) api.vibrate(25);
        }
        if (st.wall) api.sfx.click();
        if (st.goal != null) {
          const scorer = api.players[st.goal];
          center.textContent = st.goal === side ? "\u{1F945} GOAL!" : side < 0 ? "\u{1F945}" : "\u{1F631}";
          status.innerHTML = `${api.tag(scorer.id)} \u2014 ${api.esc(st.taunt)}`;
          if (st.goal === side) {
            api.sfx.airhorn();
            api.vibrate([50, 40, 50]);
          } else {
            api.sfx.boom();
            api.shake();
          }
          trail = [];
          api.after(1200, () => {
            center.textContent = "";
          });
        }
      });
      if (!api.isHost) return;
      const ids = api.players.map((p2) => p2.id);
      const sc = [0, 0];
      const p = { x: TW / 2, y: TH / 2, vx: 0, vy: 0 };
      const m = [{ x: TW / 2, y: TH - 0.2, tx: TW / 2, ty: TH - 0.2, vx: 0, vy: 0 }, { x: TW / 2, y: 0.2, tx: TW / 2, ty: 0.2, vx: 0, vy: 0 }];
      let frozenUntil = performance.now() + 1500;
      let events = {};
      let ended = false;
      const servePuck = (toward) => {
        p.x = TW / 2;
        p.y = toward === 0 ? TH / 2 + 0.15 : TH / 2 - 0.15;
        p.vx = 0;
        p.vy = 0;
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
          if (dist > maxStep) {
            dx *= maxStep / dist;
            dy *= maxStep / dist;
          }
          mk.vx = dx / DT;
          mk.vy = dy / DT;
          mk.x += dx;
          mk.y += dy;
        }
        if (performance.now() < frozenUntil) return;
        p.x += p.vx * DT;
        p.y += p.vy * DT;
        p.vx *= 0.9975;
        p.vy *= 0.9975;
        if (p.x < PR) {
          p.x = PR;
          p.vx = Math.abs(p.vx);
          events.wall = 1;
        }
        if (p.x > TW - PR) {
          p.x = TW - PR;
          p.vx = -Math.abs(p.vx);
          events.wall = 1;
        }
        const inMouth = Math.abs(p.x - TW / 2) < GOAL / 2 - PR * 0.3;
        if (!inMouth) {
          if (p.y < PR) {
            p.y = PR;
            p.vy = Math.abs(p.vy);
            events.wall = 1;
          }
          if (p.y > TH - PR) {
            p.y = TH - PR;
            p.vy = -Math.abs(p.vy);
            events.wall = 1;
          }
        }
        for (let k = 0; k < 2; k++) {
          const mk = m[k];
          const dx = p.x - mk.x, dy = p.y - mk.y;
          const d = Math.hypot(dx, dy);
          if (d < MR + PR && d > 1e-6) {
            const nx = dx / d, ny = dy / d;
            p.x = mk.x + nx * (MR + PR);
            p.y = mk.y + ny * (MR + PR);
            const rvx = p.vx - mk.vx, rvy = p.vy - mk.vy;
            const vn = rvx * nx + rvy * ny;
            if (vn < 0) {
              p.vx -= 1.9 * vn * nx;
              p.vy -= 1.9 * vn * ny;
            }
            p.vx += mk.vx * 0.15;
            p.vy += mk.vy * 0.15;
            events.hit = k + 1;
          }
        }
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > MAX_PUCK) {
          p.vx *= MAX_PUCK / sp;
          p.vy *= MAX_PUCK / sp;
        }
        const scorer = p.y < -PR ? 0 : p.y > TH + PR ? 1 : -1;
        if (scorer >= 0 && !ended) {
          sc[scorer]++;
          events.goal = scorer;
          events.taunt = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
          servePuck(1 - scorer);
          frozenUntil = performance.now() + 1500;
          if (sc[scorer] >= TARGET) {
            ended = true;
            api.after(1600, () => api.finish([ids[scorer]], `${sc[0]} \u2013 ${sc[1]}. Absolute demolition.`));
          }
        }
      };
      let acc = 0;
      let last = performance.now();
      api.every(16, () => {
        const now = performance.now();
        acc = Math.min(acc + (now - last) / 1e3, 0.1);
        last = now;
        while (acc >= DT) {
          step();
          acc -= DT;
        }
      });
      let sendTick = 0;
      api.every(33, () => {
        sendTick++;
        const r = (v) => Math.round(v * 1e3) / 1e3;
        const msg = { p: [r(p.x), r(p.y)], m: m.map((mk) => [r(mk.x), r(mk.y)]), ...events };
        if (events.goal != null || sendTick % 15 === 0) msg.sc = sc;
        events = {};
        api.broadcast(msg);
      });
      api.broadcast({ sc });
    }
  };

  // js/games/sumo.js
  var R0 = 1;
  var RMIN = 0.45;
  var SHRINK_S = 40;
  var BR = 0.11;
  var ACCEL = 3.2;
  var DASH = 2.6;
  var DASH_CD = 1500;
  var BOUNCE = 1.5;
  var FALL = ["yeeted into the void \u{1F573}\uFE0F", "took a swim \u{1F30A}", "did a sick backflip off the edge \u{1F938}", "got sumo'd \u{1F359}", "fell off like my grades \u{1F4C9}"];
  var sumo_default = {
    id: "sumo",
    title: "Bumper Sumo",
    emoji: "\u{1F359}",
    blurb: "Shove your friends off a shrinking arena. DASH to body-slam. Last one standing.",
    min: 2,
    max: 8,
    color: "#c2255c",
    start(api) {
      const target = api.players.length === 2 ? 5 : 3;
      const setScores = header(api, `\u{1F359} First to ${target}`);
      const status = h("div", { class: "status" }, "Drag to move \xB7 DASH to slam");
      api.el.append(status);
      const view = makeCanvas(api, api.el, 1);
      const center = h("div", { class: "center-msg" });
      view.c.parentElement.append(center);
      const dashBtn = h("button", { class: "btn primary", style: "margin:6px auto 10px;display:block;width:70%;font-size:26px" }, "\u{1F4A8} DASH");
      if (!api.spectator) api.el.append(dashBtn);
      const myIdx = api.players.findIndex((p) => p.id === api.me);
      let ps = api.players.map(() => [0, 0, 1, 0]);
      let shown = ps.map((p) => [...p]);
      let radius = R0;
      let lastDash = 0;
      let stick = null;
      let lastSend = 0;
      let splats = [];
      const sendAxis = (force) => {
        const now = performance.now();
        if (!force && now - lastSend < 50) return;
        lastSend = now;
        let ax = 0, ay = 0;
        if (stick) {
          const dx = stick.x - stick.ox, dy = stick.y - stick.oy;
          const len = Math.hypot(dx, dy);
          const max = 50;
          if (len > 4) {
            const k = Math.min(1, len / max) / len;
            ax = dx * k;
            ay = dy * k;
          }
        }
        api.send({ a: [Math.round(ax * 100) / 100, Math.round(ay * 100) / 100] });
      };
      api.listen(view.c, "pointerdown", (e) => {
        if (api.spectator) return;
        view.c.setPointerCapture(e.pointerId);
        stick = { ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
        sendAxis(true);
      });
      api.listen(view.c, "pointermove", (e) => {
        if (stick) {
          stick.x = e.clientX;
          stick.y = e.clientY;
          sendAxis(false);
        }
      });
      const release = () => {
        stick = null;
        sendAxis(true);
      };
      api.listen(view.c, "pointerup", release);
      api.listen(view.c, "pointercancel", release);
      const dash = (e) => {
        e?.preventDefault();
        if (performance.now() - lastDash < DASH_CD) return;
        lastDash = performance.now();
        api.send({ dash: true });
        api.sfx.swoosh();
      };
      api.listen(dashBtn, "pointerdown", dash);
      api.listen(window, "keydown", (e) => {
        if (e.code === "Space" && !e.repeat) dash(e);
      });
      api.loop(() => {
        const { ctx: ctx2 } = view;
        const s = view.w / 2.4;
        const cx = view.w / 2, cy = view.h / 2;
        for (let i = 0; i < ps.length; i++) for (let j = 0; j < 2; j++) shown[i][j] += (ps[i][j] - shown[i][j]) * 0.5;
        ctx2.fillStyle = "#0b0a1f";
        ctx2.fillRect(0, 0, view.w, view.h);
        ctx2.fillStyle = "#ff6b2c22";
        ctx2.beginPath();
        ctx2.arc(cx, cy, R0 * s * 1.15, 0, Math.PI * 2);
        ctx2.fill();
        const g = ctx2.createRadialGradient(cx, cy, radius * s * 0.2, cx, cy, radius * s);
        g.addColorStop(0, "#f3d9a4");
        g.addColorStop(1, "#d9a75b");
        ctx2.fillStyle = g;
        ctx2.beginPath();
        ctx2.arc(cx, cy, radius * s, 0, Math.PI * 2);
        ctx2.fill();
        ctx2.strokeStyle = "#fff";
        ctx2.lineWidth = s * 0.03;
        ctx2.stroke();
        ctx2.strokeStyle = "#c92a2a";
        ctx2.lineWidth = s * 0.012;
        ctx2.beginPath();
        ctx2.arc(cx, cy, radius * s * 0.5, 0, Math.PI * 2);
        ctx2.stroke();
        const now = performance.now();
        splats = splats.filter((sp) => now - sp.t < 900);
        for (const sp of splats) {
          const k = (now - sp.t) / 900;
          ctx2.globalAlpha = 1 - k;
          emoji(ctx2, "\u{1F4AB}", cx + sp.x * s, cy + sp.y * s - k * 40, s * 0.2);
          ctx2.globalAlpha = 1;
        }
        api.players.forEach((p, i) => {
          const [, , alive, dashing] = ps[i];
          if (!alive) return;
          const [sx, sy] = shown[i];
          ctx2.fillStyle = "#0005";
          ctx2.beginPath();
          ctx2.ellipse(cx + sx * s, cy + sy * s + BR * s * 0.6, BR * s, BR * s * 0.45, 0, 0, Math.PI * 2);
          ctx2.fill();
          ctx2.fillStyle = p.color;
          ctx2.beginPath();
          ctx2.arc(cx + sx * s, cy + sy * s, BR * s * (dashing ? 1.12 : 1), 0, Math.PI * 2);
          ctx2.fill();
          if (i === myIdx) {
            ctx2.strokeStyle = "#fff";
            ctx2.lineWidth = s * 0.015;
            ctx2.stroke();
          }
          emoji(ctx2, p.avatar, cx + sx * s, cy + sy * s, BR * s * 1.25);
        });
        if (stick) {
          const r = view.c.getBoundingClientRect();
          const k = view.w / r.width;
          ctx2.strokeStyle = "#ffffff55";
          ctx2.lineWidth = 3 * k;
          ctx2.beginPath();
          ctx2.arc((stick.ox - r.left) * k, (stick.oy - r.top) * k, 50 * k, 0, Math.PI * 2);
          ctx2.stroke();
          ctx2.fillStyle = "#ffffff88";
          const dx = stick.x - stick.ox, dy = stick.y - stick.oy, len = Math.hypot(dx, dy), c = len > 50 ? 50 / len : 1;
          ctx2.beginPath();
          ctx2.arc((stick.ox + dx * c - r.left) * k, (stick.oy + dy * c - r.top) * k, 20 * k, 0, Math.PI * 2);
          ctx2.fill();
        }
        const cd = Math.max(0, DASH_CD - (performance.now() - lastDash));
        dashBtn.disabled = cd > 0;
        dashBtn.textContent = cd > 0 ? `\u{1F4A8} ${(cd / 1e3).toFixed(1)}` : "\u{1F4A8} DASH";
      });
      api.onState((st) => {
        if (st.scores) setScores(st.scores);
        if (st.k === "r") {
          ps = st.ps;
          shown = ps.map((p) => [...p]);
          radius = R0;
          center.textContent = "3";
          api.after(1e3, () => {
            center.textContent = "2";
          });
          api.after(2e3, () => {
            center.textContent = "1";
          });
          api.after(3e3, () => {
            center.textContent = "";
          });
          status.textContent = `Round ${st.round} \u2014 drag to move, DASH to slam`;
          api.sfx.beep();
        } else if (st.k === "s") {
          ps = st.ps;
          radius = st.R;
          if (st.bump) {
            api.sfx.bonk();
            if (st.bump.includes(myIdx)) api.vibrate(30);
            splats.push({ x: st.bx, y: st.by, t: performance.now() });
          }
          if (st.go) api.sfx.go();
          for (const i of st.fell || []) {
            status.innerHTML = `${api.tag(api.players[i].id)} ${api.esc(st.msg)}`;
            if (i === myIdx) {
              api.sfx.lose();
              api.vibrate(300);
              api.shake();
            } else api.sfx.splash();
          }
        } else if (st.k === "e") {
          center.textContent = st.winner ? st.winner === api.me ? "\u{1F3C6}" : api.avatar(st.winner) : "\u{1F91D}";
          status.innerHTML = st.winner ? `${api.tag(st.winner)} is the last one standing!` : "Double knockout! \u{1F480}";
          if (st.winner === api.me) api.sfx.coin();
        }
      });
      if (!api.isHost) return;
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
      const later = (ms, fn) => {
        const k = token;
        api.after(ms, () => {
          if (k === token) fn();
        });
      };
      const rMin = RMIN + 0.05 * (n - 2);
      const newRound = () => {
        token++;
        round++;
        R = R0;
        b = ids.map((_, i) => {
          const a = i / n * Math.PI * 2 + Math.PI / 2;
          return { x: Math.cos(a) * 0.6, y: Math.sin(a) * 0.6, vx: 0, vy: 0, ax: 0, ay: 0, alive: true, dashUntil: 0, lastDash: 0 };
        });
        live = false;
        api.broadcast({ k: "r", round, ps: snap(), scores });
        later(3e3, () => {
          live = true;
          startAt = performance.now();
          ev.go = 1;
        });
      };
      const snap = () => b.map((o) => [Math.round(o.x * 1e3) / 1e3, Math.round(o.y * 1e3) / 1e3, o.alive ? 1 : 0, performance.now() < o.dashUntil ? 1 : 0]);
      api.onInput((from, d) => {
        const i = ids.indexOf(from);
        if (i < 0 || !b[i]) return;
        if (Array.isArray(d?.a)) {
          let [ax, ay] = d.a.map(Number);
          if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;
          const len = Math.hypot(ax, ay);
          if (len > 1) {
            ax /= len;
            ay /= len;
          }
          b[i].ax = ax;
          b[i].ay = ay;
        }
        if (d?.dash && live && b[i].alive && performance.now() - b[i].lastDash > DASH_CD - 100) {
          const o = b[i];
          o.lastDash = performance.now();
          o.dashUntil = o.lastDash + 250;
          let dx = o.ax, dy = o.ay;
          if (Math.hypot(dx, dy) < 0.1) {
            dx = o.vx;
            dy = o.vy;
          }
          const len = Math.hypot(dx, dy) || 1;
          o.vx += dx / len * DASH;
          o.vy += dy / len * DASH;
        }
      });
      const DT = 1 / 60;
      api.every(16, () => {
        if (!live) return;
        const t = (performance.now() - startAt) / 1e3;
        R = Math.max(rMin, R0 - (R0 - rMin) * Math.min(1, t / SHRINK_S));
        for (const o of b) {
          if (!o.alive) continue;
          o.vx += o.ax * ACCEL * DT;
          o.vy += o.ay * ACCEL * DT;
          o.vx *= 0.97;
          o.vy *= 0.97;
          o.x += o.vx * DT;
          o.y += o.vy * DT;
        }
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const A = b[i], B = b[j];
          if (!A.alive || !B.alive) continue;
          const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
          if (d >= BR * 2 || d < 1e-6) continue;
          const nx = dx / d, ny = dy / d, overlap = BR * 2 - d;
          A.x -= nx * overlap / 2;
          A.y -= ny * overlap / 2;
          B.x += nx * overlap / 2;
          B.y += ny * overlap / 2;
          const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
          if (rv < 0) {
            const now = performance.now();
            const ka = now < A.dashUntil ? 1.6 : 1, kb = now < B.dashUntil ? 1.6 : 1;
            const imp = -rv * BOUNCE;
            A.vx -= imp * nx * kb;
            A.vy -= imp * ny * kb;
            B.vx += imp * nx * ka;
            B.vy += imp * ny * ka;
            if (-rv > 0.4) {
              ev.bump = [i, j];
              ev.bx = (A.x + B.x) / 2;
              ev.by = (A.y + B.y) / 2;
            }
          }
        }
        const fell = [];
        b.forEach((o, i) => {
          if (o.alive && Math.hypot(o.x, o.y) > R + BR * 0.3) {
            o.alive = false;
            fell.push(i);
          }
        });
        if (fell.length) {
          ev.fell = fell;
          ev.msg = FALL[Math.floor(Math.random() * FALL.length)];
        }
        const left = b.map((o, i) => o.alive ? i : -1).filter((i) => i >= 0);
        if (left.length <= 1) {
          live = false;
          later(700, () => {
            const winner = left.length === 1 ? ids[left[0]] : null;
            if (winner) scores[winner]++;
            api.broadcast({ k: "e", winner, scores });
            const top = leaders(scores);
            if (top.length === 1 && scores[top[0]] >= target) later(2200, () => api.finish(top, "Sumo grand champion \u{1F359}"));
            else later(2500, newRound);
          });
        }
      });
      api.every(33, () => {
        if (!b.length) return;
        api.broadcast({ k: "s", ps: snap(), R: Math.round(R * 1e3) / 1e3, ...ev });
        ev = {};
      });
      newRound();
    }
  };

  // js/games/connect4.js
  var COLS = 7;
  var ROWS = 6;
  var TURN_MS = 2e4;
  var BRAIN = ["\u{1F9E0} big brain move", "\u{1F914} interesting choice\u2026", "\u{1F62C} bold", "\u{1F3AF} calculated", "\u{1F648} oops?", "\u{1F525} spicy"];
  function findWin(b, r, c) {
    const who = b[r * COLS + c];
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const cells = [[r, c]];
      for (const s of [1, -1]) {
        let rr = r + dr * s, cc = c + dc * s;
        while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && b[rr * COLS + cc] === who) {
          cells.push([rr, cc]);
          rr += dr * s;
          cc += dc * s;
        }
      }
      if (cells.length >= 4) return cells.map(([a, d]) => a * COLS + d);
    }
    return null;
  }
  var connect4_default = {
    id: "connect4",
    title: "Connect Four",
    emoji: "\u{1F534}",
    blurb: "The classic, with a 20s shot clock. Line up 4 before your friend does.",
    min: 2,
    max: 2,
    color: "#2f9e44",
    start(api) {
      header(api, "\u{1F534} Connect Four");
      const status = h("div", { class: "status" });
      const board = h("div", { class: "c4board" });
      api.el.append(status, h("div", { class: "c4" }, board));
      const cols = [];
      const cells = [];
      for (let c = 0; c < COLS; c++) {
        const col = h("div", { class: "c4col" });
        for (let r = 0; r < ROWS; r++) {
          const cell = h("div", { class: "c4cell" });
          col.append(cell);
          cells[r * COLS + c] = cell;
        }
        api.listen(col, "pointerenter", (e) => {
          if (e.pointerType === "mouse") col.classList.add("hover");
        });
        api.listen(col, "pointerleave", () => col.classList.remove("hover"));
        api.listen(col, "click", () => {
          if (myTurn()) api.send({ col: c });
        });
        board.append(col);
        cols.push(col);
      }
      let st = null;
      let deadline = 0;
      const myTurn = () => st && !st.win && !st.draw && st.turn === api.me;
      const colorOf = (v) => v ? api.players[v - 1].color : "";
      const renderStatus = () => {
        if (!st) return;
        const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1e3));
        if (st.win || st.draw) return;
        status.innerHTML = myTurn() ? `\u{1FAF5} <b>Your move</b> \xB7 \u23F1\uFE0F ${secs}s` : `${api.tag(st.turn)} is thinking\u2026 \u23F1\uFE0F ${secs}s${st.note ? ` \xB7 ${api.esc(st.note)}` : ""}`;
      };
      api.every(250, renderStatus);
      api.onState((s) => {
        st = s;
        deadline = Date.now() + (s.ms || 0);
        s.b.forEach((v, i) => {
          const cell = cells[i];
          cell.className = `c4cell ${v ? `p${v}` : ""}`;
          cell.style.background = v ? colorOf(v) : "";
        });
        if (s.last != null) {
          cells[s.last].classList.add("drop");
          api.sfx.pop();
          api.vibrate(15);
        }
        for (const i of s.win || []) cells[i].classList.add("win");
        board.style.opacity = myTurn() || s.win || s.draw ? 1 : 0.85;
        if (s.win) status.innerHTML = `${api.tag(s.winner)} connects four! \u{1F389}`;
        else if (s.draw) status.textContent = "Board full. Nobody wins. \u{1FAE0}";
        else if (s.timeout) api.toast(`\u23F0 ${api.esc(api.name(s.timeout))} took too long \u2014 random drop!`);
        if (myTurn()) api.sfx.beep();
        renderStatus();
      });
      if (!api.isHost) return;
      const ids = api.players.map((p) => p.id);
      const b = new Array(COLS * ROWS).fill(0);
      let turn = Math.random() < 0.5 ? 0 : 1;
      let token = 0;
      let over = false;
      const later = (ms, fn) => {
        const k = token;
        api.after(ms, () => {
          if (k === token) fn();
        });
      };
      const push = (extra = {}) => api.broadcast({ b, turn: ids[turn], ms: TURN_MS, ...extra });
      const drop = (c, timeout) => {
        let r = ROWS - 1;
        while (r >= 0 && b[r * COLS + c]) r--;
        if (r < 0) return false;
        token++;
        b[r * COLS + c] = turn + 1;
        const win = findWin(b, r, c);
        const last = r * COLS + c;
        if (win) {
          over = true;
          push({ last, win, winner: ids[turn] });
          const w = ids[turn];
          later(2500, () => api.finish([w], "Four in a row. Cleanest W in history."));
          return true;
        }
        if (b.every((v) => v)) {
          over = true;
          push({ last, draw: true });
          later(2500, () => api.finish([], "The board is full. Both of you lost, honestly."));
          return true;
        }
        const mover = ids[turn];
        turn = 1 - turn;
        push({ last, note: BRAIN[Math.floor(Math.random() * BRAIN.length)], timeout: timeout ? mover : null });
        later(TURN_MS, randomDrop);
        return true;
      };
      const randomDrop = () => {
        if (over) return;
        const open = [...Array(COLS).keys()].filter((c) => !b[c]);
        drop(open[Math.floor(Math.random() * open.length)], true);
      };
      api.onInput((from, d) => {
        if (over || from !== ids[turn]) return;
        const c = Number(d?.col);
        if (Number.isInteger(c) && c >= 0 && c < COLS) drop(c, false);
      });
      push();
      later(TURN_MS, randomDrop);
    }
  };

  // js/games/battleship.js
  var N = 8;
  var SHIPS = [4, 3, 3, 2, 2];
  var TURN_MS2 = 3e4;
  var HIT_LINES = ["\u{1F4A5} DIRECT HIT", "\u{1F3AF} Bullseye!", "\u{1F525} Got one!", "\u{1F608} Boom."];
  var MISS_LINES = ["\u{1F30A} Splash\u2026", "\u{1F41F} You hit a fish", "\u{1F4A7} Nothing but water", "\u{1F980} The crab says no"];
  function randomFleet() {
    for (; ; ) {
      const taken = /* @__PURE__ */ new Set();
      const fleet = [];
      let ok = true;
      for (const len of SHIPS) {
        let placed = false;
        for (let t = 0; t < 200 && !placed; t++) {
          const horiz = Math.random() < 0.5;
          const r = Math.floor(Math.random() * (horiz ? N : N - len + 1));
          const c = Math.floor(Math.random() * (horiz ? N - len + 1 : N));
          const cells = Array.from({ length: len }, (_, k) => horiz ? r * N + c + k : (r + k) * N + c);
          if (cells.some((x) => taken.has(x))) continue;
          cells.forEach((x) => taken.add(x));
          fleet.push(cells);
          placed = true;
        }
        if (!placed) {
          ok = false;
          break;
        }
      }
      if (ok) return fleet;
    }
  }
  function validFleet(f) {
    if (!Array.isArray(f) || f.length !== SHIPS.length) return false;
    const lens = f.map((s) => Array.isArray(s) ? s.length : 0).sort((a, b) => b - a);
    if (lens.join() !== [...SHIPS].sort((a, b) => b - a).join()) return false;
    const seen = /* @__PURE__ */ new Set();
    for (const ship of f) {
      if (!ship.every((x) => Number.isInteger(x) && x >= 0 && x < N * N && !seen.has(x))) return false;
      ship.forEach((x) => seen.add(x));
      const s = [...ship].sort((a, b) => a - b);
      const horiz = s.every((x, i) => i === 0 || x === s[i - 1] + 1 && Math.floor(x / N) === Math.floor(s[0] / N));
      const vert = s.every((x, i) => i === 0 || x === s[i - 1] + N);
      if (!horiz && !vert) return false;
    }
    return true;
  }
  var battleship_default = {
    id: "battleship",
    title: "Battleship",
    emoji: "\u{1F6A2}",
    blurb: "Hide your fleet, hunt theirs. Hits fire again. Long, tense, salty.",
    min: 2,
    max: 2,
    color: "#1864ab",
    start(api) {
      header(api, "\u{1F6A2} Battleship");
      const status = h("div", { class: "status" });
      const wrap = h("div", { class: "bs" });
      api.el.append(status, wrap);
      const me = api.spectator ? api.players[0].id : api.me;
      const them = api.players.find((p) => p.id !== me);
      let fleet = api.spectator ? [] : randomFleet();
      let locked = false;
      let st = { ph: "place", ready: {} };
      let deadline = 0;
      const grid = (cls, onTap) => {
        const g = h("div", { class: `bsgrid ${cls}` });
        for (let i = 0; i < N * N; i++) {
          const cell = h("div", { class: "bscell" });
          if (onTap) cell.addEventListener("click", () => onTap(i));
          g.append(cell);
        }
        return g;
      };
      const render = () => {
        wrap.innerHTML = "";
        if (st.ph === "place") {
          const ready2 = st.ready[me];
          status.innerHTML = api.spectator ? "\u{1F440} Admirals are hiding their fleets\u2026" : ready2 ? `Waiting for ${api.tag(them.id)} to place ships\u2026 \u23F3` : "Shuffle until you like your fleet, then lock it in";
          const g = grid("");
          const shipCells2 = new Set(fleet.flat());
          [...g.children].forEach((c, i) => {
            if (shipCells2.has(i)) c.classList.add("ship");
          });
          wrap.append(g);
          if (!locked && !api.spectator) {
            wrap.append(h(
              "div",
              { class: "modalbtns" },
              h("button", { class: "btn secondary", onclick: () => {
                fleet = randomFleet();
                api.sfx.swoosh();
                render();
              } }, "\u{1F500} Shuffle"),
              h("button", { class: "btn primary", onclick: () => {
                locked = true;
                api.send({ fleet });
                api.sfx.ding();
                render();
              } }, "\u2705 Ready!")
            ));
          }
          return;
        }
        if (api.spectator && st.fleets) fleet = st.fleets[me];
        const myShots = st.shots[me] || {};
        const theirShots = st.shots[them.id] || {};
        const myTurn = st.turn === api.me && !st.done;
        battleStatus();
        const enemy = grid(myTurn ? "armed" : "", (i) => {
          if (myTurn && !myShots[i]) api.send({ shot: i });
        });
        const sunkThem = new Set((st.sunk[them.id] || []).flat());
        [...enemy.children].forEach((c, i) => {
          if (myShots[i] === "h") {
            c.classList.add(sunkThem.has(i) ? "sunk" : "hit");
            c.textContent = sunkThem.has(i) ? "\u2620\uFE0F" : "\u{1F4A5}";
          } else if (myShots[i] === "m") {
            c.classList.add("miss");
            c.textContent = "\xB7";
          } else if (st.fleets && st.fleets[them.id]?.flat().includes(i)) c.classList.add("ship");
          if (st.last?.by === me && st.last.idx === i) c.classList.add("last");
        });
        const mine = grid("mine");
        const shipCells = new Set(fleet.flat());
        const sunkMine = new Set((st.sunk[me] || []).flat());
        [...mine.children].forEach((c, i) => {
          if (shipCells.has(i)) c.classList.add("ship");
          if (theirShots[i] === "h") {
            c.classList.add(sunkMine.has(i) ? "sunk" : "hit");
            c.textContent = "\u{1F4A5}";
          } else if (theirShots[i] === "m") {
            c.classList.add("miss");
            c.textContent = "\xB7";
          }
          if (st.last?.by === them.id && st.last.idx === i) c.classList.add("last");
        });
        const left = (id) => SHIPS.length - (st.sunk[id] || []).length;
        wrap.append(
          h("div", { class: "bslabel" }, `${api.spectator ? api.name(them.id) : "Enemy waters"} \u2014 ${left(them.id)} ships left`),
          enemy,
          h("div", { class: "bslabel" }, `${api.spectator ? api.name(me) : "Your fleet"} \u2014 ${left(me)} ships left`),
          mine
        );
      };
      function battleStatus() {
        if (st.ph !== "battle" || st.done) return;
        const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1e3));
        status.innerHTML = st.turn === api.me ? `\u{1F3AF} <b>Your shot!</b> Tap enemy waters \xB7 \u23F1\uFE0F ${secs}s` : `${api.tag(st.turn)} is aiming\u2026 \u23F1\uFE0F ${secs}s`;
      }
      api.every(1e3, battleStatus);
      api.onState((s) => {
        const prev = st;
        st = s;
        if (s.ready?.[api.me]) locked = true;
        deadline = Date.now() + (s.ms || 0);
        if (s.ph === "battle" && prev.ph === "place") api.sfx.go();
        if (s.last && s.last.seq !== prev.last?.seq) {
          const mineHit = s.last.by !== api.me && !api.spectator;
          if (s.last.res === "h") {
            api.sfx.boom();
            if (mineHit) {
              api.vibrate(200);
              api.shake();
            }
            api.toast(s.last.sunk ? `\u2620\uFE0F ${api.esc(api.name(s.last.by))} SANK a ${s.last.sunk}-ship!` : `${api.esc(api.name(s.last.by))}: ${HIT_LINES[s.last.seq % HIT_LINES.length]}`, 1600);
          } else {
            api.sfx.splash();
            if (!mineHit) api.toast(MISS_LINES[s.last.seq % MISS_LINES.length], 1200);
          }
        }
        if (s.done) status.innerHTML = `${api.tag(s.winner)} sank the whole fleet! \u{1F3F4}\u200D\u2620\uFE0F`;
        render();
      });
      render();
      if (!api.isHost) return;
      const ids = api.players.map((p) => p.id);
      const fleets = {};
      const shots = Object.fromEntries(ids.map((id) => [id, {}]));
      const sunk = Object.fromEntries(ids.map((id) => [id, []]));
      const ready = {};
      let ph = "place";
      let turn = null;
      let last = null;
      let seq = 0;
      let token = 0;
      let done = false;
      const later = (ms, fn) => {
        const k = token;
        api.after(ms, () => {
          if (k === token) fn();
        });
      };
      const other = (id) => ids.find((x) => x !== id);
      const push = (extra = {}) => api.broadcast({ ph, ready, turn, shots, sunk, last, ms: ph === "battle" ? TURN_MS2 : 0, ...extra });
      const fire = (by, idx, auto = false) => {
        if (shots[by][idx]) return;
        token++;
        const target = other(by);
        const ship = fleets[target].find((s) => s.includes(idx));
        shots[by][idx] = ship ? "h" : "m";
        let sunkLen = 0;
        if (ship && ship.every((x) => shots[by][x] === "h")) {
          sunk[target].push(ship);
          sunkLen = ship.length;
        }
        last = { by, idx, res: ship ? "h" : "m", sunk: sunkLen, seq: ++seq };
        if (sunk[target].length === SHIPS.length) {
          done = true;
          push({ done: true, winner: by, fleets });
          later(3500, () => api.finish([by], `Sent ${sunk[target].length} ships to Davy Jones \u{1F3F4}\u200D\u2620\uFE0F`));
          return;
        }
        if (!ship || auto) turn = other(by);
        push();
        later(TURN_MS2, autoFire);
      };
      const autoFire = () => {
        if (done || ph !== "battle") return;
        const open = [...Array(N * N).keys()].filter((i) => !shots[turn][i]);
        fire(turn, open[Math.floor(Math.random() * open.length)], true);
      };
      api.onInput((from, d) => {
        if (done) return;
        if (ph === "place" && d?.fleet && !ready[from] && validFleet(d.fleet)) {
          fleets[from] = d.fleet;
          ready[from] = true;
          if (ids.every((id) => ready[id])) {
            ph = "battle";
            turn = ids[Math.floor(Math.random() * 2)];
            later(TURN_MS2, autoFire);
          }
          push();
        } else if (ph === "battle" && from === turn && Number.isInteger(d?.shot) && d.shot >= 0 && d.shot < N * N) {
          fire(from, d.shot);
        }
      });
      push();
    }
  };

  // js/games/mindreader.js
  var QUESTIONS = [
    ["fight 1 horse-sized duck", "fight 100 duck-sized horses"],
    ["have spaghetti for hair", "sweat maple syrup"],
    ["always smell like onions", "always hear the Wii shop music"],
    ["sneeze every time you laugh", "laugh every time you sneeze"],
    ["only whisper forever", "only yell forever"],
    ["have a rewind button for life", "have a pause button for life"],
    ["be a famous YouTuber", "be a secret billionaire"],
    ["lose your phone for a month", "lose your eyebrows for a year"],
    ["eat a bug every day", "never eat pizza again"],
    ["have fingers as long as legs", "legs as long as fingers"],
    ["talk to animals", "speak every human language"],
    ["be stuck in a lift with your teacher", "be stuck in a lift with your ex"],
    ["have your search history leaked", "have your camera roll leaked"],
    ["be always 10 minutes late", "be always 2 hours early"],
    ["live in a giant shoe", "live in a giant pumpkin"],
    ["have a pet dinosaur", "have a pet dragon"],
    ["only eat cold food", "only eat spicy food"],
    ["be invisible", "be able to fly"],
    ["never use social media again", "never watch another movie or show"],
    ["have a personal chef", "have a personal driver"],
    ["wear clown shoes forever", "wear a clown nose forever"],
    ["meow after every sentence", "bark when someone says your name"],
    ["be the funniest person in the room", "be the smartest person in the room"],
    ["explore space", "explore the deep ocean"],
    ["go back to the dinosaurs", "go 1000 years into the future"],
    ["have unlimited robux/vbucks", "have unlimited snacks"],
    ["fart loudly in an exam", "burp loudly at a wedding"],
    ["get a tattoo of your friend's face", "let your friend pick your haircut"],
    ["have no wifi forever", "have no air conditioning/heating forever"],
    ["be a wizard", "be a superhero"],
    ["have a third arm", "have a third eye"],
    ["live without music", "live without TV/movies"],
    ["be famous for something dumb", "be unknown for something amazing"],
    ["eat a raw onion like an apple", "drink a cup of pickle juice"],
    ["always lose at games", "never be allowed to play games"],
    ["have to sing everything you say", "have to dance everywhere you walk"],
    ["know when you'll die", "know how you'll die"],
    ["swim in a pool of jelly", "swim in a pool of baked beans"],
    ["be a cat", "be a dog"],
    ["have super speed", "have super strength"],
    ["have your mum read your texts", "have your crush read your texts"],
    ["only be able to eat with chopsticks", "only be able to eat with your hands"],
    ["live in Minecraft", "live in GTA"],
    ["never be bored again", "never be tired again"],
    ["have hiccups for a year", "feel like you need to sneeze for a year"],
    ["be a world-class athlete", "be a world-class musician"],
    ["give up cheese", "give up chocolate"],
    ["have a lightsaber", "have a magic wand"],
    ["have a boring life that lasts forever", "a crazy life that lasts 40 years"],
    ["be trapped in a room with a mosquito", "be trapped in a room with a toddler"],
    ["speak only in questions", "speak only in rhymes"],
    ["own a time machine", "own a teleporter"],
    ["always step on Lego", "always have a wet sock"],
    ["be 3 feet tall", "be 9 feet tall"],
    ["get free food forever", "get free travel forever"],
    ["have an annoying laugh", "have an annoying sneeze"],
    ["marry someone rich and boring", "marry someone broke and hilarious"],
    ["be stranded on an island alone", "be stranded with someone you hate"],
    ["have a rap battle with your grandma", "have a dance battle with your teacher"],
    ["never be able to close doors", "never be able to turn off lights"],
    ["have everything you draw become real", "have everything you write become true"],
    ["be a ghost", "be a vampire"],
    ["lick a public handrail", "eat a crisp off the cinema floor"],
    ["have squeaky shoes", "have a squeaky chair everywhere"],
    ["win the lottery", "live twice as long"],
    ["always know when someone is lying", "always get away with lying"],
    ["have your life narrated by Morgan Freeman", "have a theme song play when you walk in"],
    ["wake up as the opposite gender for a day", "wake up as your best friend for a day"],
    ["live in a treehouse", "live on a boat"],
    ["have unlimited battery on all devices", "have unlimited free wifi everywhere"]
  ];
  var ANSWER_MS = 2e4;
  var CORRECT = ["\u{1F9E0} MIND READER", "\u{1F52E} psychic!", "\u{1F91D} knows them too well", "\u{1F441}\uFE0F saw that coming"];
  var WRONG = ["\u274C who even are you", "\u{1F928} do you even know them?", "\u{1F480} wrong", "\u{1F648} stranger danger"];
  var mindreader_default = {
    id: "mindreader",
    title: "Mind Reader",
    emoji: "\u{1F52E}",
    blurb: "Unhinged would-you-rather. Guess what your friend picked. Friendships WILL be tested.",
    min: 2,
    max: 8,
    color: "#d6336c",
    start(api) {
      const setScores = header(api, "\u{1F52E} Mind Reader");
      const box = h("div", { class: "mr" });
      api.el.append(box);
      let st = null;
      let picked = null;
      let deadline = 0;
      let bar = null;
      const draw = () => {
        box.innerHTML = "";
        if (!st) return;
        const iAmHot = st.hot === api.me;
        const reveal2 = st.k === "r";
        const who = reveal2 ? `${api.tag(st.hot)} picked\u2026` : api.spectator ? `${api.tag(st.hot)} is in the hot seat` : iAmHot ? "\u{1F525} <b>You're in the hot seat.</b> Answer honestly!" : `What would ${api.tag(st.hot)} pick?`;
        box.append(h("div", { class: "who" }));
        box.lastChild.innerHTML = `${who} <span style="opacity:.6">(${st.round}/${st.total})</span>`;
        box.append(h("div", { class: "q" }, "Would you rather\u2026"));
        st.q.forEach((text, i) => {
          let cls = `opt ${i ? "b" : "a"}`;
          if (reveal2) cls += st.hotPick === i ? " sel" : " dim";
          else if (picked === i) cls += " sel";
          const b = h("button", { class: cls }, text);
          if (!reveal2 && !api.spectator) b.addEventListener("click", () => {
            if (picked == null) {
              picked = i;
              api.send({ pick: i });
              api.sfx.pop();
              draw();
            }
          });
          box.append(b);
          if (i === 0) box.append(h("div", { class: "or" }, "OR"));
        });
        if (!reveal2) {
          bar = h("i");
          box.append(h("div", { class: "timer" }, bar));
          const p = h("div", { class: "pickers" });
          p.innerHTML = (st.done || []).map((id) => `<span title="${api.esc(api.name(id))}">${api.esc(api.avatar(id))}\u2705</span>`).join("");
          box.append(p);
        } else {
          const p = h("div", { class: "pickers" });
          p.innerHTML = st.hotPick == null ? `${api.tag(st.hot)} froze \u{1F976} \u2014 nobody scores` : api.players.filter((pl) => pl.id !== st.hot).map((pl) => {
            const g = st.picks[pl.id];
            const ok = g === st.hotPick;
            return `<span>${api.tag(pl.id)} ${g == null ? "\u{1F634}" : ok ? "\u2705" : "\u274C"}</span>`;
          }).join(" ");
          box.append(p);
        }
      };
      api.loop(() => {
        if (bar && deadline) bar.style.width = `${Math.max(0, (deadline - Date.now()) / ANSWER_MS * 100)}%`;
      });
      api.onState((s) => {
        setScores(s.scores);
        if (s.k === "q") {
          st = s;
          picked = null;
          deadline = Date.now() + s.ms;
          api.sfx.ding();
        } else if (s.k === "p") {
          if (st) st.done = s.done;
        } else if (s.k === "r") {
          st = s;
          deadline = 0;
          if (s.hotPick != null && s.hot !== api.me && !api.spectator) {
            const ok = s.picks[api.me] === s.hotPick;
            api.toast(ok ? CORRECT[s.round % CORRECT.length] : WRONG[s.round % WRONG.length]);
            if (ok) api.sfx.coin();
            else api.sfx.wrong();
          } else api.sfx.rimshot();
        }
        draw();
      });
      if (!api.isHost) return;
      const ids = api.players.map((p) => p.id);
      const scores = Object.fromEntries(ids.map((id) => [id, 0]));
      const total = Math.min(12, ids.length * (ids.length === 2 ? 5 : 2));
      const qs = shuffle(QUESTIONS).slice(0, total);
      const hotOrder = shuffle(ids);
      let round = 0;
      let cur = null;
      let token = 0;
      const later = (ms, fn) => {
        const k = token;
        api.after(ms, () => {
          if (k === token) fn();
        });
      };
      const ask = () => {
        token++;
        if (round >= total) {
          api.finish(leaders(scores), "Certified friendship expert \u{1F52E}");
          return;
        }
        const hot = hotOrder[round % hotOrder.length];
        cur = { hot, q: qs[round], picks: {} };
        round++;
        api.broadcast({ k: "q", round, total, hot, q: cur.q, ms: ANSWER_MS, done: [], scores });
        later(ANSWER_MS, reveal);
      };
      const reveal = () => {
        if (cur.revealed) return;
        cur.revealed = true;
        token++;
        const hotPick = cur.picks[cur.hot] ?? null;
        if (hotPick != null) {
          for (const id of ids) if (id !== cur.hot && cur.picks[id] === hotPick) scores[id] += 100;
          const right = ids.filter((id) => id !== cur.hot && cur.picks[id] === hotPick).length;
          scores[cur.hot] += right * 40;
        }
        api.broadcast({ k: "r", round, total, hot: cur.hot, q: cur.q, hotPick, picks: cur.picks, scores });
        later(5500, ask);
      };
      api.onInput((from, d) => {
        if (!cur || cur.revealed || cur.picks[from] != null || d?.pick !== 0 && d?.pick !== 1) return;
        cur.picks[from] = d.pick;
        api.broadcast({ k: "p", done: Object.keys(cur.picks), scores });
        if (ids.every((id) => cur.picks[id] != null)) reveal();
      });
      ask();
    }
  };

  // js/games/index.js
  var GAME_LIST = [doodle_default, quickdraw_default, hockey_default, sumo_default, tron_default, mindreader_default, battleship_default, connect4_default];
  var GAMES = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));

  // js/app.js
  var $ = (s) => document.querySelector(s);
  var esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  var REACTIONS = ["\u{1F602}", "\u{1F480}", "\u{1F525}", "\u{1F62D}", "\u{1F921}", "\u{1F624}", "\u{1F451}", "\u{1FAE1}", "\u{1F4A9}", "\u{1F92F}", "\u{1F608}", "\u{1F64F}", "\u{1F440}", "\u{1F976}", "\u{1F9C2}", "\u{1F410}", "\u2764\uFE0F", "\u{1F595}"];
  var QUICK = ["gg ez \u{1F60E}", "skill issue", "I let you win", "rematch. NOW.", "bro what \u{1F480}", "LAG \u{1F624}", "one more game", "ur cooked", "that was luck", "touch grass", "nah ur hacking", "im so back"];
  var WIN_ROASTS = ["Absolutely diabolical.", "Someone call an ambulance\u2026 not for the winner.", "Rent free in their head now.", "Built different.", "Victory royale (unofficial).", "Mom, come pick me up, I'm scared."];
  var LOSE_ROASTS = ["Skill issue detected. \u{1F9C2}", "Have you tried being better?", "Uninstall? No. Rematch.", "That was painful to watch. \u{1F480}", "Bro got cooked.", "L + ratio + rematch"];
  var profile = loadProfile();
  var room = null;
  var voice = null;
  var current = null;
  var lastGameId = null;
  var unread = 0;
  var lastSb = 0;
  function lvl() {
    return levelInfo(profile.xp);
  }
  function renderProfile() {
    const li = lvl();
    $("#avatarBtn").textContent = profile.avatar;
    $("#nameInput").value = profile.name;
    $("#lvlLabel").textContent = `LV ${li.level}`;
    $("#titleLabel").textContent = titleFor(li.level);
    $("#xpFill").style.width = `${li.into / li.need * 100}%`;
    $("#xpText").textContent = `${li.into} / ${li.need} XP${profile.streak > 1 ? ` \xB7 \u{1F525} ${profile.streak} win streak` : ""}`;
    $("#muteBtn").textContent = isMuted() ? "\u{1F507} Sound off" : "\u{1F50A} Sound on";
    renderStats();
  }
  function renderPicker() {
    const level = lvl().level;
    $("#avatarPicker").innerHTML = AVATARS.map(([e, lv]) => `<button data-e="${e}" data-lvl="LV${lv}" class="${lv > level ? "locked" : ""} ${e === profile.avatar ? "sel" : ""}">${e}</button>`).join("");
  }
  function renderStats() {
    const rows = GAME_LIST.map((g) => {
      const s = profile.games[g.id] || { played: 0, won: 0 };
      return `<tr><td>${g.emoji} ${g.title}</td><td>${s.played}</td><td>${s.won}</td><td>${s.played ? Math.round(s.won / s.played * 100) : 0}%</td></tr>`;
    }).join("");
    const rivals = Object.entries(profile.rivals).sort((a, b) => b[1].w + b[1].l - (a[1].w + a[1].l)).slice(0, 10).map(([n, r]) => `<tr><td>${esc(n)}</td><td>${r.w}</td><td>${r.l}</td><td>${r.w > r.l ? "\u{1F60E} owns them" : r.w < r.l ? "\u{1F630} your nemesis" : "\u2694\uFE0F even"}</td></tr>`).join("");
    $("#statsBody").innerHTML = `<table><tr><th>Game</th><th>Played</th><th>Won</th><th>Win%</th></tr>${rows}</table>` + (rivals ? `<table><tr><th>Rival</th><th>W</th><th>L</th><th></th></tr>${rivals}</table>` : '<p class="hint">Play friends to build rivalries.</p>');
  }
  $("#avatarBtn").onclick = () => {
    renderPicker();
    $("#avatarPicker").classList.toggle("hidden");
    sfx.pop();
  };
  $("#avatarPicker").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("locked")) {
      toast(`\u{1F512} Unlocks at ${b.dataset.lvl}. Go win some games!`);
      sfx.wrong();
      return;
    }
    profile.avatar = b.dataset.e;
    saveProfile(profile);
    $("#avatarPicker").classList.add("hidden");
    renderProfile();
    sfx.coin();
  };
  $("#nameInput").oninput = (e) => {
    profile.name = e.target.value.slice(0, 16) || randomName();
    saveProfile(profile);
  };
  $("#diceBtn").onclick = () => {
    profile.name = randomName();
    saveProfile(profile);
    renderProfile();
    sfx.boing();
  };
  $("#muteBtn").onclick = () => {
    setMuted(!isMuted());
    renderProfile();
    sfx.click();
  };
  function toast(html, ms = 2600) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = html;
    $("#toasts").append(t);
    setTimeout(() => t.remove(), ms);
    while ($("#toasts").children.length > 4) $("#toasts").firstElementChild.remove();
  }
  function floatEmoji(e, label) {
    const f = document.createElement("div");
    f.className = "floater";
    f.style.left = `${8 + Math.random() * 78}%`;
    f.innerHTML = `${esc(e)}<small>${esc(label)}</small>`;
    $("#floaters").append(f);
    setTimeout(() => f.remove(), 2700);
  }
  function netUser() {
    const li = lvl();
    return { name: profile.name.trim() || randomName(), avatar: profile.avatar, level: li.level, title: titleFor(li.level) };
  }
  async function enterRoom(action) {
    audioContext();
    if (typeof Peer === "undefined") {
      $("#homeMsg").textContent = "Networking library failed to load. Refresh?";
      return;
    }
    $("#createBtn").disabled = $("#joinBtn").disabled = true;
    $("#homeMsg").textContent = action === "host" ? "Opening room\u2026" : "Knocking on the door\u2026";
    const r = new Room(netUser());
    r.gameDefs = GAMES;
    try {
      if (action === "host") await r.host();
      else await r.join($("#codeInput").value);
    } catch (e) {
      $("#homeMsg").textContent = `\u{1F62C} ${e.message}`;
      sfx.wrong();
      $("#createBtn").disabled = $("#joinBtn").disabled = false;
      return;
    }
    room = r;
    wireRoom();
    $("#homeMsg").textContent = "";
    $("#createBtn").disabled = $("#joinBtn").disabled = false;
    $("#home").classList.add("hidden");
    $("#room").classList.remove("hidden");
    $("#codeLabel").textContent = $("#bigCode").textContent = room.code;
    history.replaceState(null, "", `?room=${room.code}`);
    $("#chatLog").innerHTML = "";
    sysMsg(room.isHost ? `Room ${room.code} is open. Share the code!` : `Joined room ${room.code} \u{1F389}`);
    sfx.win();
    renderLobby();
  }
  $("#createBtn").onclick = () => enterRoom("host");
  $("#joinBtn").onclick = () => enterRoom("join");
  $("#codeInput").onkeydown = (e) => {
    if (e.key === "Enter") enterRoom("join");
  };
  $("#codeInput").oninput = (e) => {
    const v = e.target.value.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ2-9]/g, "");
    if (v !== e.target.value) e.target.value = v;
  };
  function exitRoom(msg) {
    endGame();
    voice?.destroy();
    voice = null;
    room?.leave();
    room = null;
    closeDrawers();
    $("#result").classList.add("hidden");
    $("#room").classList.add("hidden");
    $("#home").classList.remove("hidden");
    $("#audioUnlock").classList.add("hidden");
    updateMic();
    history.replaceState(null, "", location.pathname);
    $("#homeMsg").textContent = msg || "";
    renderProfile();
  }
  $("#leaveBtn").onclick = async () => {
    if (await askConfirm("Leave the room?")) exitRoom();
  };
  async function shareInvite() {
    const base = location.protocol === "file:" ? "https://subtoferalsloth11.github.io/squad-arcade/" : `${location.origin}${location.pathname}`;
    const url = `${base}?room=${room.code}`;
    const text = `Join my Squad Arcade room! Code: ${room.code}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Squad Arcade", text, url });
        return;
      }
    } catch (e) {
      if (e.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast("\u{1F4CB} Invite link copied!");
    } catch {
      toast(`Code: <b>${room.code}</b>`);
    }
  }
  $("#shareBtn").onclick = shareInvite;
  $("#codeChip").onclick = shareInvite;
  function wireRoom() {
    voice = new Voice(room, {
      onChange: updateMic,
      onSpeaking: (set) => document.querySelectorAll(".pchip").forEach((el) => el.classList.toggle("speaking", set.has(el.dataset.id))),
      onAutoplayBlocked: () => $("#audioUnlock").classList.remove("hidden")
    });
    room.on("lobby", () => {
      renderLobby();
    });
    room.on("sys", (m) => {
      sysMsg(m.text);
      toast(esc(m.text));
    });
    room.on("chat", (m) => onChat(m));
    room.on("react", (m) => {
      const p = room.player(m.from);
      floatEmoji(m.e, p ? p.name : "");
      sfx.pop();
    });
    room.on("sb", (m) => {
      const p = room.player(m.from);
      const sb = SOUNDBOARD.find((s) => s[2] === m.s);
      if (!sb) return;
      play(m.s);
      toast(`${sb[0]} <b>${esc(p ? p.name : "?")}</b> played ${sb[1]}`, 1800);
    });
    room.on("start", (m) => startGame(m));
    room.on("gst", (m) => {
      if (current) for (const fn of current.stateH) fn(m.d);
    });
    room.on("ginput", (from, d) => {
      if (current) for (const fn of current.inputH) fn(from, d);
    });
    room.on("over", (m) => showResult(m));
    room.on("abort", (m) => {
      endGame();
      renderLobby();
      toast(esc(m.text));
      sfx.dundun();
      sysMsg(m.text);
    });
    room.on("full", () => exitRoom("That room is full (8 max) \u{1F62D}"));
    room.on("hostleft", () => exitRoom("The host left \u2014 room closed. \u{1F44B}"));
  }
  function renderLobby() {
    if (!room) return;
    const strip = room.players.map((p) => `<button class="pchip avatar" data-id="${esc(p.id)}" style="border-color:${p.color}" title="${esc(p.name)}">${esc(p.avatar)}${p.voice ? '<span class="mic">\u{1F399}\uFE0F</span>' : ""}</button>`).join("");
    $("#playerStrip").innerHTML = strip;
    if (voice) document.querySelectorAll(".pchip").forEach((el) => el.classList.toggle("speaking", voice.speaking.has(el.dataset.id)));
    $("#inviteCard").classList.toggle("hidden", room.players.length > 1);
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    $("#scoreboard").innerHTML = sorted.map((p, i) => `<div class="sbrow">
      <span class="avatar pchip" style="border-color:${p.color}">${esc(p.avatar)}</span>
      <span class="nm">${i === 0 && p.score > 0 ? "\u{1F451} " : ""}${esc(p.name)}${p.id === room.id ? " (you)" : ""}<br><span class="lv">LV ${p.level} \xB7 ${esc(p.title || "")}</span></span>
      <span class="sc">${p.score}</span></div>`).join("");
    const n = room.players.length;
    $("#gameGrid").innerHTML = GAME_LIST.map((g) => {
      const s = profile.games[g.id];
      return `<button class="gcard ${n < g.min ? "disabled" : ""}" data-g="${g.id}" style="background:linear-gradient(160deg, ${g.color}, ${g.color}99)">
      <span class="ge">${g.emoji}</span><span class="gt">${g.title}</span><span class="gb">${g.blurb}</span>
      <span class="gm"><span>\u{1F465} ${g.min === g.max ? g.min : `${g.min}-${g.max}`}</span><span>${s ? `\u{1F3C6} ${s.won}/${s.played}` : "NEW"}</span></span></button>`;
    }).join("");
  }
  $("#gameGrid").onclick = (e) => {
    const b = e.target.closest(".gcard");
    if (!b || !room) return;
    const g = GAMES[b.dataset.g];
    if (room.players.length < g.min) {
      toast(`Need ${g.min}+ players. Invite your friend! \u{1F4E4}`);
      sfx.wrong();
      return;
    }
    if (room.game) {
      const running = GAMES[room.game.id];
      toast(`\u23F3 ${running ? running.title : "A game"} is in progress \u2014 you're in the next one!`);
      return;
    }
    sfx.click();
    room.send({ t: "start", game: g.id });
  };
  function sysMsg(text) {
    const d = document.createElement("div");
    d.className = "cmsg sys";
    d.textContent = text;
    appendChat(d);
  }
  function appendChat(el) {
    const log = $("#chatLog");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(el);
    while (log.children.length > 200) log.firstElementChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function onChat(m) {
    const p = room.player(m.from);
    const d = document.createElement("div");
    d.className = `cmsg ${m.from === room.id ? "mine" : ""}`;
    d.innerHTML = `<b style="color:${p ? p.color : "#fff"}">${esc(p ? `${p.avatar} ${p.name}` : "???")}</b>${esc(m.text)}`;
    appendChat(d);
    if (m.from !== room.id) {
      if ($("#chatDrawer").classList.contains("hidden")) {
        unread++;
        $("#chatBadge").textContent = unread;
        $("#chatBadge").classList.remove("hidden");
        toast(`\u{1F4AC} <b>${esc(p ? p.name : "?")}</b>: ${esc(m.text)}`, 3200);
      }
      sfx.pop();
    }
  }
  $("#quickLines").innerHTML = QUICK.map((q) => `<button>${esc(q)}</button>`).join("");
  $("#quickLines").onclick = (e) => {
    const b = e.target.closest("button");
    if (b) room?.send({ t: "chat", text: b.textContent });
  };
  $("#chatForm").onsubmit = (e) => {
    e.preventDefault();
    const text = $("#chatInput").value.trim();
    if (!text || !room) return;
    room.send({ t: "chat", text });
    $("#chatInput").value = "";
  };
  var DRAWERS = ["chatDrawer", "reactDrawer", "sbDrawer"];
  function closeDrawers() {
    for (const d of DRAWERS) $(`#${d}`).classList.add("hidden");
  }
  function toggleDrawer(id) {
    const open = $(`#${id}`).classList.contains("hidden");
    closeDrawers();
    $("#room").style.setProperty("--dock-h", `${$(".dock").offsetHeight}px`);
    if (open) $(`#${id}`).classList.remove("hidden");
    if (id === "chatDrawer" && open) {
      unread = 0;
      $("#chatBadge").classList.add("hidden");
      $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
    }
  }
  document.querySelectorAll("[data-close]").forEach((b) => {
    b.onclick = () => $(`#${b.dataset.close}`).classList.add("hidden");
  });
  $("#chatBtn").onclick = () => toggleDrawer("chatDrawer");
  $("#reactBtn").onclick = () => toggleDrawer("reactDrawer");
  $("#sbBtn").onclick = () => toggleDrawer("sbDrawer");
  $("#reactGrid").innerHTML = REACTIONS.map((e) => `<button>${e}</button>`).join("");
  $("#reactGrid").onclick = (e) => {
    const b = e.target.closest("button");
    if (b) room?.send({ t: "react", e: b.textContent });
  };
  $("#sbGrid").innerHTML = SOUNDBOARD.map(([e, label, id]) => `<button data-s="${id}">${e}<span>${label}</span></button>`).join("");
  $("#sbGrid").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || !room) return;
    if (Date.now() - lastSb < 700) return;
    lastSb = Date.now();
    room.send({ t: "sb", s: b.dataset.s });
  };
  function updateMic() {
    const st = voice ? voice.state : "off";
    $("#micBtn").classList.toggle("live", st === "live");
    $("#micBtn").classList.toggle("muted", st === "muted");
    $("#micBtn").firstChild.textContent = st === "muted" ? "\u{1F507}" : "\u{1F399}\uFE0F";
    $("#micLabel").textContent = st === "off" ? "Voice" : st === "live" ? "Live" : "Muted";
  }
  $("#micBtn").onclick = async () => {
    if (!voice) return;
    if (voice.state === "off") {
      $("#micLabel").textContent = "\u2026";
      try {
        await voice.enable();
        toast("\u{1F399}\uFE0F You're live! Everyone in the room can hear you.");
        sfx.ding();
      } catch (e) {
        toast(`\u{1F399}\uFE0F Mic blocked: ${esc(e.message || e.name)}. Allow microphone access in your browser settings.`, 4500);
        updateMic();
      }
    } else voice.toggleMute();
  };
  $("#audioUnlock").onclick = () => {
    voice?.resumeAudio();
    $("#audioUnlock").classList.add("hidden");
  };
  function startGame(m) {
    endGame();
    closeDrawers();
    $("#result").classList.add("hidden");
    const def = GAMES[m.game.id];
    if (!def) return;
    lastGameId = def.id;
    const el = $("#game");
    el.innerHTML = "";
    el.classList.remove("hidden");
    $("#lobby").classList.add("hidden");
    const inputH = [], stateH = [], cleanups = [];
    const players = m.game.players.map((id) => room.player(id)).filter(Boolean).map((p) => ({ ...p }));
    const spectator = !m.game.players.includes(room.id);
    $("#quitGameBtn").classList.toggle("hidden", spectator);
    const byId = (id) => players.find((p) => p.id === id) || room.player(id) || { name: "???", avatar: "\u2754", color: "#888" };
    const api = {
      me: room.id,
      isHost: room.isHost,
      players,
      spectator,
      el,
      send: (d) => room.send({ t: "gin", d }),
      broadcast: (d) => room.broadcast({ t: "gst", d }),
      sendTo: (id, d) => room.sendTo(id, { t: "gst", d }),
      onInput: (fn) => inputH.push(fn),
      onState: (fn) => stateH.push(fn),
      finish: (winners, text = "") => {
        if (room.isHost) room.send({ t: "over", winners, text });
      },
      after: (ms, fn) => {
        const t = setTimeout(fn, ms);
        cleanups.push(() => clearTimeout(t));
        return t;
      },
      every: (ms, fn) => {
        const t = setInterval(fn, ms);
        cleanups.push(() => clearInterval(t));
        return t;
      },
      loop: (fn) => {
        let last = performance.now();
        let id = 0;
        const tick = (t) => {
          fn(Math.min(0.05, (t - last) / 1e3), t);
          last = t;
          id = requestAnimationFrame(tick);
        };
        id = requestAnimationFrame(tick);
        cleanups.push(() => cancelAnimationFrame(id));
      },
      listen: (target, ev, fn, opt) => {
        target.addEventListener(ev, fn, opt);
        cleanups.push(() => target.removeEventListener(ev, fn, opt));
      },
      onCleanup: (fn) => cleanups.push(fn),
      name: (id) => byId(id).name,
      avatar: (id) => byId(id).avatar,
      color: (id) => byId(id).color,
      tag: (id) => `<b style="color:${byId(id).color}">${esc(byId(id).avatar)} ${esc(byId(id).name)}</b>`,
      esc,
      sfx,
      vibrate,
      toast,
      shake: () => {
        el.classList.remove("shake");
        void el.offsetWidth;
        el.classList.add("shake");
      }
    };
    current = { def, api, inputH, stateH, cleanups };
    def.start(api);
    if (spectator) toast("\u{1F440} Game is full \u2014 you're spectating this one");
  }
  function endGame() {
    if (!current) return;
    for (const fn of current.cleanups) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
    current = null;
    $("#game").innerHTML = "";
    $("#game").classList.add("hidden");
    $("#lobby").classList.remove("hidden");
    $("#quitGameBtn").classList.add("hidden");
  }
  $("#quitGameBtn").onclick = async () => {
    if (await askConfirm("End this game for everyone?")) room?.send({ t: "quit" });
  };
  function askConfirm(text) {
    return new Promise((resolve) => {
      $("#confirmText").textContent = text;
      $("#confirm").classList.remove("hidden");
      const done = (v) => {
        $("#confirm").classList.add("hidden");
        resolve(v);
      };
      $("#confirmYes").onclick = () => done(true);
      $("#confirmNo").onclick = () => done(false);
    });
  }
  function showResult(m) {
    const wasPlaying = current && !current.api.spectator;
    const players = current ? current.api.players : [];
    endGame();
    renderLobby();
    const winners = m.winners || [];
    const iWon = winners.includes(room.id);
    const draw = winners.length === 0;
    const names = winners.map((id) => room.player(id)?.name || "???");
    $("#resultEmoji").textContent = draw ? "\u{1F91D}" : iWon ? "\u{1F3C6}" : wasPlaying ? "\u{1F480}" : "\u{1F389}";
    $("#resultTitle").textContent = draw ? "DRAW!" : iWon ? winners.length > 1 ? "YOU (ALL) WIN!" : "YOU WIN!" : `${names.join(" & ")} WINS`;
    $("#resultText").textContent = m.text || "";
    const pick2 = (a) => a[Math.floor(Math.random() * a.length)];
    $("#resultRoast").textContent = draw ? "Nobody wins. Everybody loses. Beautiful." : iWon ? pick2(WIN_ROASTS) : wasPlaying ? pick2(LOSE_ROASTS) : "";
    if (wasPlaying) {
      const opponents = players.filter((p) => p.id !== room.id).map((p) => p.name);
      const r = recordGame(profile, m.game.id, iWon, draw, opponents);
      $("#resultXp").innerHTML = `<b>+${r.xp} XP</b><br>${r.lines.map(esc).join("<br>")}` + (r.levelUp ? `<span class="up">\u2B06\uFE0F LEVEL ${r.levelUp}! "${esc(titleFor(r.levelUp))}"</span>` : "") + (r.unlocked.length ? `<span class="up">\u{1F513} Unlocked avatar ${r.unlocked.join(" ")}</span>` : "");
      if (r.levelUp) room.send({ t: "me", level: r.levelUp, title: titleFor(r.levelUp) });
      $("#resultXp").classList.remove("hidden");
    } else $("#resultXp").classList.add("hidden");
    $("#result").classList.remove("hidden");
    if (draw) sfx.honk();
    else if (iWon) {
      sfx.win();
      vibrate([60, 40, 60, 40, 200]);
    } else if (wasPlaying) sfx.lose();
    else sfx.ding();
  }
  $("#rematchBtn").onclick = () => {
    $("#result").classList.add("hidden");
    if (!room || !lastGameId) return;
    if (room.players.length < GAMES[lastGameId].min) {
      toast("Not enough players for a rematch \u{1F622}");
      return;
    }
    room.send({ t: "start", game: lastGameId });
  };
  $("#lobbyBtn").onclick = () => $("#result").classList.add("hidden");
  var qp = new URLSearchParams(location.search).get("room");
  if (qp) {
    $("#codeInput").value = qp.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    $("#homeMsg").textContent = "\u{1F446} Pick a name, then tap Join!";
  }
  renderProfile();
  window.addEventListener("beforeunload", () => room?.leave());
  window.addEventListener("pointerdown", () => audioContext(), { passive: true });
})();
