// Voice chat: a full mesh of PeerJS media calls. Anyone in the room hears people
// who turned their mic on; turning your own mic on (re)calls everyone so the
// call becomes two-way. Speaking indicators come from WebAudio analysers.
import { audioContext } from './sfx.js';

export class Voice {
  constructor(room, { onChange, onSpeaking, onAutoplayBlocked }) {
    this.room = room;
    this.local = null;
    this.muted = false;
    this.calls = new Map();     // peer id -> MediaConnection
    this.sinks = new Map();     // peer id -> { audio, analyser }
    this.onChange = onChange;
    this.onSpeaking = onSpeaking;
    this.onAutoplayBlocked = onAutoplayBlocked;
    this.localAnalyser = null;
    this.speaking = new Set();
    this.meterTimer = setInterval(() => this._meter(), 150);
    room.on('call', (call) => this._incoming(call));
    room.on('lobby', () => this._syncPeers());
  }

  get state() { return !this.local ? 'off' : this.muted ? 'muted' : 'live'; }

  async enable() {
    if (this.local) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser blocks microphones (needs HTTPS).');
    this.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.muted = false;
    this.localAnalyser = this._analyser(this.local);
    this.room.send({ t: 'voice', on: true });
    for (const p of this.room.players) if (p.id !== this.room.id) this._call(p.id);
    this.onChange();
  }

  toggleMute() {
    if (!this.local) return;
    this.muted = !this.muted;
    for (const t of this.local.getAudioTracks()) t.enabled = !this.muted;
    this.room.send({ t: 'voice', on: !this.muted });
    this.onChange();
  }

  /** Retry playback after the browser blocked autoplay; must run inside a tap. */
  resumeAudio() {
    audioContext();
    for (const { audio } of this.sinks.values()) audio.play().catch(() => {});
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
    for (const id of [...this.calls.keys()]) if (!ids.has(id)) { this.calls.get(id).close(); this.calls.delete(id); this._dropSink(id); }
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
    // Both sides called each other within the same moment: the lower id's call wins.
    const glare = mine?.outgoing && !mine.connected && Date.now() - mine.startedAt < 3000;
    if (glare && this.room.id < call.peer) { call.close(); return; }
    this.calls.delete(call.peer);
    mine?.close();
    if (this.local) call.answer(this.local);
    else call.answer();
    this._wire(call);
  }

  _wire(call) {
    this.calls.set(call.peer, call);
    call.on('stream', (stream) => { call.connected = true; this._play(call.peer, stream); });
    const end = () => {
      if (this.calls.get(call.peer) !== call) return;
      this.calls.delete(call.peer);
      this._dropSink(call.peer);
    };
    call.on('close', end);
    call.on('error', end);
  }

  _play(id, stream) {
    this._dropSink(id);
    if (!stream.getAudioTracks().length) return;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    document.getElementById('audioSinks').append(audio);
    audio.play().catch(() => this.onAutoplayBlocked());
    this.sinks.set(id, { audio, analyser: this._analyser(stream) });
  }

  _dropSink(id) {
    const s = this.sinks.get(id);
    if (!s) return;
    s.audio.srcObject = null;
    s.audio.remove();
    this.sinks.delete(id);
  }

  _analyser(stream) {
    try {
      const ctx = audioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      return { an, buf: new Uint8Array(an.fftSize) };
    } catch { return null; }
  }

  _level(a) {
    if (!a) return 0;
    a.an.getByteTimeDomainData(a.buf);
    let sum = 0;
    for (const v of a.buf) sum += (v - 128) * (v - 128);
    return Math.sqrt(sum / a.buf.length);
  }

  _meter() {
    const now = new Set();
    if (this.local && !this.muted && this._level(this.localAnalyser) > 6) now.add(this.room.id);
    for (const [id, s] of this.sinks) if (this._level(s.analyser) > 6) now.add(id);
    const changed = now.size !== this.speaking.size || [...now].some((id) => !this.speaking.has(id));
    this.speaking = now;
    if (changed) this.onSpeaking(now);
  }
}
