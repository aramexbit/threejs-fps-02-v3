// input.js — keyboard + mouse input for FROSTLINE.
// Pointer lock for mouse look, WASD movement, Shift sprint, Ctrl/C crouch,
// RMB aim-down-sights, B buy menu, F interact (plant/defuse hold),
// Q/E lean, mouse wheel weapon switch, G grenade, R reload, 1/2/3 slots.
// In ?shot= modes pointer lock is skipped (headless screenshots) and the
// sim drives the camera instead.
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
    // v3.16 Phase 1: mouse-wheel weapon switch — accumulate signed wheel
    // ticks; sim.consumeWheel() takes them (down = next weapon, up = prev).
    this.wheelDelta = 0;
    window.addEventListener('wheel', (e) => {
      this.wheelDelta = Math.max(-3, Math.min(3, this.wheelDelta + Math.sign(e.deltaY)));
    }, { passive: true });
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
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; this.ads = false; this.clickQueue = 0; this.wheelDelta = 0; });
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
    if (this.shotMode || this.locked) return;
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
    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const s = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    return { f: Math.max(-1, Math.min(1, f)), s: Math.max(-1, Math.min(1, s)) };
  }
  get sprint() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }
  get crouch() { return this.keys.has('ControlLeft') || this.keys.has('KeyC'); }
  get jump() { return this.keys.has('Space'); } // v3.10: Space jumps
  // v3.16 Phase 1: Q/E lean (-1 left, +1 right); F is the interact key —
  // plant/defuse hold moved here from E so E can lean (the task's mapping;
  // the audit note's "E stays plant/defuse" cannot coexist with E lean).
  get lean() { return (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0); }
  get plantHeld() { return this.keys.has('KeyF'); }
  get interact() { return this.keys.has('KeyF'); }
  consumeWheel() {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }
}
