// All sound is synthesised at runtime with WebAudio: no files, no network.
// Everything is wrapped defensively so a blocked AudioContext can never break the game.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.ready = false;
    this.enabled = true;
  }

  init() {
    if (this.ready) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);

      // one second of white noise, reused by every percussive sound
      const len = Math.floor(this.ctx.sampleRate * 1.0);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
      this.ready = true;
    } catch (e) {
      this.ready = false;
    }
  }

  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  get t() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  _noise(dur, gain, filterType, freq, q = 1, pan = 0) {
    if (!this.ready || !this.enabled) return;
    try {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = 1;
      const filt = ctx.createBiquadFilter();
      filt.type = filterType;
      filt.frequency.value = freq;
      filt.Q.value = q;
      const g = ctx.createGain();
      const now = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(filt).connect(g);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        g.connect(p).connect(this.master);
      } else {
        g.connect(this.master);
      }
      src.start(now);
      src.stop(now + dur + 0.02);
    } catch (e) { /* audio is a bonus, never fatal */ }
  }

  _tone(freq, dur, gain, type = 'sine', slideTo = null) {
    if (!this.ready || !this.enabled) return;
    try {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const now = ctx.currentTime;
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + dur);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(g).connect(this.master);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    } catch (e) { /* ignore */ }
  }

  shot() {
    this._noise(0.16, 0.55, 'bandpass', 1500, 0.9);
    this._noise(0.05, 0.4, 'highpass', 3800, 0.7);
    this._tone(120, 0.12, 0.42, 'triangle', 48);
  }

  enemyShot(dist) {
    const g = Math.max(0.04, 0.30 - dist * 0.006);
    this._noise(0.14, g, 'bandpass', 900, 0.8, dist > 15 ? 0.4 : 0);
  }

  impact() {
    this._noise(0.07, 0.20, 'bandpass', 2400, 1.4);
  }

  hit(head) {
    this._tone(head ? 1500 : 950, 0.07, 0.28, 'square', head ? 900 : 620);
  }

  kill() {
    this._tone(700, 0.10, 0.26, 'triangle', 420);
    this._tone(1050, 0.16, 0.16, 'sine', 620);
  }

  reload() {
    this._noise(0.05, 0.22, 'bandpass', 2600, 2.0);
  }

  reloadDone() {
    this._noise(0.06, 0.26, 'bandpass', 1800, 1.6);
    this._tone(320, 0.06, 0.12, 'square');
  }

  empty() {
    this._noise(0.04, 0.24, 'highpass', 4200, 1.2);
  }

  hurt() {
    this._noise(0.22, 0.35, 'lowpass', 480, 0.7);
    this._tone(90, 0.20, 0.3, 'sine', 55);
  }

  roundEnd(win) {
    if (win) {
      this._tone(523, 0.16, 0.22, 'triangle');
      setTimeout(() => this._tone(784, 0.22, 0.22, 'triangle'), 150);
      setTimeout(() => this._tone(1046, 0.34, 0.20, 'triangle'), 300);
    } else {
      this._tone(220, 0.36, 0.24, 'sawtooth', 90);
      setTimeout(() => this._tone(150, 0.5, 0.2, 'sawtooth', 60), 220);
    }
  }
}
