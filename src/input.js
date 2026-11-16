// input.js — keyboard + mouse input for FROSTLINE.
// Pointer lock for mouse look, WASD movement, Shift sprint, Ctrl/C crouch,
// RMB aim-down-sights, B buy menu, E plant/defuse hold, G grenade, Q weapon
// switch, R reload, 1/2/3 weapon slots. In ?shot= modes pointer lock is
// skipped (headless screenshots) and the sim drives the camera instead.
export class Input {
  constructor(canvas, onLockChange) {
    this.keys = new Set();
    this.mouseDX = 0; this.mouseDY = 0;
    this.mouseDown = false; this.ads = false;
    this.locked = false;
    this.shotMode = false;
    this.pressed = new Set(); // edge-triggered keys, consumed by sim
    // v3.10: edge-triggered fire queue. mouseDown is a LEVEL sampled once
    // per sim step — on a slow machine a quick click (down+up inside one
    // frame gap) never reaches a sim step and the shot silently vanishes
    // (the "kadang tidak bisa nembak" the headless 2.5 s-held-click test
    // could never see). Every real mousedown enqueues one fire attempt;
    // the sim consumes it on its next step even if the button is up again.
    this.clickQueue = 0;
    // v3.15: touch controls (touch.js) drive the same channels as
    // keyboard/mouse — one input model, two devices. Touch look feeds
    // mouseDX/mouseDY so settings.sensitivity applies to it in
    // player.update, exactly like mouse look.
    this._touchF = 0; this._touchS = 0;
    this.touchMode = false; // set by main.js when touch UI is active
    this.onLockChange = onLockChange || (() => {});
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      // v3.11: a held key auto-repeats — re-add it to `keys` on repeat so
      // movement resumes by itself after a window blur cleared the set
      // (before this, a W held through a blur never re-registered until
      // the player released and re-pressed it: "can't move" with no error).
      // Edge-triggered `pressed` is untouched by repeats.
      if (e.repeat) { this.keys.add(e.code); return; }
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'KeyR' || e.code === 'KeyB' || e.code === 'KeyG' || e.code === 'KeyQ' || e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3' || e.code === 'Digit4' || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; this.ads = false; this.clickQueue = 0; });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (e.target !== canvas) return;
      if (e.button === 0) { this.mouseDown = true; if (this.clickQueue < 5) this.clickQueue++; }
      if (e.button === 2) this.ads = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.ads = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this.onLockChange(this.locked);
    });
    canvas.addEventListener('click', () => this.requestLock());
  }
  requestLock() {
    if (this.shotMode || this.locked || this.touchMode) return; // v3.15: touch players never lock the pointer
    try {
      const p = this.canvas.requestPointerLock();
      // v3.9 (Gemini G1): Chrome returns a Promise that rejects without a
      // user gesture (e.g. re-locking when the round starts on a timer).
      // Swallow it — the next canvas click re-locks. Without this guard
      // the rejection surfaces as an uncaught page error.
      if (p && p.catch) p.catch(() => {});
    } catch { /* headless: ignore */ }
  }
  // v3.9 (Gemini G1): release the mouse so buy-menu buttons are clickable
  // without pressing Esc first. No-op when not locked (incl. headless).
  exitLock() {
    if (!this.locked) return;
    try { document.exitPointerLock(); } catch { /* ignore */ }
    // The browser fires pointerlockchange async; clear the flag now so a
    // re-lock right after (e.g. closing the buy menu) is not skipped when
    // the event is delayed or missing. The event re-asserts the same value.
    this.locked = false;
  }
  consume(code) {
    const had = this.pressed.has(code);
    if (had) this.pressed.delete(code);
    return had;
  }
  // v3.10: drop edge-triggered keys (e.g. an R pressed during freeze must
  // not leak into the round as a surprise reload). Called by sim.js on
  // every phase transition.
  clearPressed() {
    this.pressed.clear();
  }
  // v3.10: consume one queued click (see the clickQueue comment above).
  consumeClick() {
    if (this.clickQueue <= 0) return false;
    this.clickQueue--;
    return true;
  }
  takeMouse() {
    const dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = 0; this.mouseDY = 0;
    return { dx, dy };
  }
  get move() {
    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0) + this._touchF;
    const s = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0) + this._touchS;
    return { f: Math.max(-1, Math.min(1, f)), s: Math.max(-1, Math.min(1, s)) };
  }
  // v3.15: touch-control API (touch.js). Same channels as keyboard/mouse.
  setTouchMove(f, s) {
    this._touchF = Math.max(-1, Math.min(1, f));
    this._touchS = Math.max(-1, Math.min(1, s));
  }
  touchLook(dx, dy) { this.mouseDX += dx; this.mouseDY += dy; }
  touchFire(down) {
    this.mouseDown = down;
    if (down && this.clickQueue < 5) this.clickQueue++;
  }
  touchAds(down) { this.ads = down; }
  touchKey(code, down) {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }
  touchPress(code) { this.pressed.add(code); }
  get sprint() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }
  get crouch() { return this.keys.has('ControlLeft') || this.keys.has('KeyC'); }
  get jump() { return this.keys.has('Space'); } // v3.10: Space jumps
  get plantHeld() { return this.keys.has('KeyE'); }
}
