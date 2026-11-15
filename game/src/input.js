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
    this.onLockChange = onLockChange || (() => {});
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'KeyR' || e.code === 'KeyB' || e.code === 'KeyG' || e.code === 'KeyQ' || e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3' || e.code === 'Digit4') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; this.ads = false; });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (e.target !== canvas) return;
      if (e.button === 0) this.mouseDown = true;
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
  takeMouse() {
    const dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = 0; this.mouseDY = 0;
    return { dx, dy };
  }
  get move() {
    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const s = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    return { f, s };
  }
  get sprint() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }
  get crouch() { return this.keys.has('ControlLeft') || this.keys.has('KeyC'); }
  get plantHeld() { return this.keys.has('KeyE'); }
}
