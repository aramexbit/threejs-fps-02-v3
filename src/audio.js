// audio.js — procedural WebAudio sounds for FROSTLINE. No audio files:
// gunshots, reload clicks, hit markers, plant/defuse beeps, explosion,
// footsteps on snow. Everything is synthesized; the context is created lazily
// on first user gesture and every call is guarded so headless runs never fail.
import { settings } from './settings.js';

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.master = null;
  }
  ensure() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.applySettings(); // v3.10: volume + mute from the settings panel
      this.master.connect(this.ctx.destination);
      return true;
    } catch {
      return false;
    }
  }
  // v3.10: master gain follows the settings panel live. Mute = gain 0.
  applySettings() {
    if (!this.master) return;
    this.master.gain.value = settings.muted ? 0 : 0.35 * settings.volume;
  }
  _noiseBuf(dur = 0.3) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Seeded noise (never Math.random): same buffer every run.
    this._noiseSeed = (this._noiseSeed || 12345) + 7919;
    let a = this._noiseSeed >>> 0;
    for (let i = 0; i < len; i++) {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      d[i] = ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
    }
    return buf;
  }
  _burst(dur, filterFreq, type, gain, when = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf(dur);
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0); src.stop(t0 + dur);
  }
  _tone(freq, dur, type, gain, slideTo = null, when = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur);
  }
  shot(kind) {
    // _shotCalls counts BEFORE ensure() so headless probes can verify the
    // call path (no AudioContext there), like hurt()'s _hurtCalls.
    this._shotCalls = (this._shotCalls || 0) + 1;
    this._lastShotKind = kind;
    if (!this.ensure()) return;
    // v3.16 Phase 2: per-shot variation — the same kind never sounds
    // identical twice (filter/tone detuned ±8% each shot).
    const det = 0.92 + Math.random() * 0.16;
    if (kind === 'sniper') { this._burst(0.35, 900 * det, 'lowpass', 0.9); this._tone(160 * det, 0.18, 'sawtooth', 0.25, 60); }
    else if (kind === 'smg') { this._burst(0.12, 1600 * det, 'bandpass', 0.55); }
    else if (kind === 'pistol') { this._burst(0.16, 1200 * det, 'bandpass', 0.6); }
    else { this._burst(0.2, 1100 * det, 'bandpass', 0.7); this._tone(120 * det, 0.1, 'square', 0.12, 70); }
  }
  // v3.16 Phase 2: bullet impact sound per surface material — metal pings,
  // wood knocks, snow/sand thud soft, concrete/rock thud hard.
  impact(mat) {
    this._impactCalls = (this._impactCalls || 0) + 1;
    this._lastImpactMat = mat;
    if (!this.ensure()) return;
    if (mat === 'metal') { this._burst(0.08, 3500, 'bandpass', 0.25); this._tone(2400, 0.06, 'sine', 0.1); }
    else if (mat === 'wood') { this._burst(0.09, 900, 'bandpass', 0.25); }
    else if (mat === 'snow') { this._burst(0.12, 500, 'lowpass', 0.18); }
    else if (mat === 'sand') { this._burst(0.1, 700, 'lowpass', 0.2); }
    else if (mat === 'rock') { this._burst(0.07, 2000, 'bandpass', 0.22); }
    else { this._burst(0.09, 300, 'lowpass', 0.25); } // concrete
  }
  dryFire() { if (this.ensure()) this._tone(1400, 0.04, 'square', 0.08); }
  reload() {
    if (!this.ensure()) return;
    this._tone(700, 0.05, 'square', 0.12);
    this._tone(500, 0.05, 'square', 0.12, null, 0.35);
    this._tone(900, 0.05, 'square', 0.14, null, 0.8);
  }
  hit() { if (this.ensure()) this._tone(2400, 0.05, 'sine', 0.2); }
  // v3.14 (item 3): HURT — the player just took an enemy bullet. A low
  // thud (noise burst through a lowpass + a falling sub tone) — nothing
  // like the 2400 Hz hitmarker ping or a gunshot, so it reads instantly
  // as "I am being hit". _hurtCalls counts invocations BEFORE ensure()
  // so headless probes can verify the call path (no AudioContext there).
  hurt() {
    this._hurtCalls = (this._hurtCalls || 0) + 1;
    if (!this.ensure()) return;
    this._burst(0.18, 250, 'lowpass', 0.9);
    this._tone(110, 0.25, 'sine', 0.5, 45);
  }
  kill() { if (this.ensure()) { this._tone(1800, 0.06, 'sine', 0.22); this._tone(2400, 0.08, 'sine', 0.22, null, 0.07); } }
  beep(final = false) { if (this.ensure()) this._tone(final ? 1400 : 950, 0.09, 'sine', 0.22); }
  explosion() {
    if (!this.ensure()) return;
    this._burst(1.1, 220, 'lowpass', 1.0);
    this._tone(70, 0.9, 'sine', 0.7, 30);
  }
  step() { if (this.ensure()) this._burst(0.09, 500, 'lowpass', 0.1); }
  roundWin() {
    if (!this.ensure()) return;
    this._tone(660, 0.12, 'sine', 0.2);
    this._tone(880, 0.16, 'sine', 0.2, null, 0.12);
  }
}
