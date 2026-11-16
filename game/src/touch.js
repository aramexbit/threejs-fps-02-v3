// touch.js — Android touch controls for FROSTLINE (v3.15).
// Virtual joystick (left), FIRE / AIM / RELOAD / JUMP / CROUCH + E
// (plant/defuse) buttons (right), touch-look drag on the right half of the
// screen. Multitouch: every finger is tracked by pointerId (joystick, look
// and buttons are independent), so joystick + look + fire work at once.
// The touch UI only exists on touch devices (pointer: coarse or
// maxTouchPoints > 0) or with ?touch=1 (probe override). PC input is
// untouched — keyboard/mouse flow through input.js exactly as before, and
// both feed the SAME channels (move vector, look deltas, fire/ADS/keys),
// so the settings sensitivity applies to touch look too (player.update
// multiplies takeMouse() by settings.sensitivity once).
export class TouchControls {
  constructor(input, hud) {
    this.input = input; this.hud = hud;
    const params = new URLSearchParams(location.search);
    const forced = params.get('touch') === '1';
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.enabled = forced || coarse || hasTouch;
    this.lookId = null; this.lookLast = null;
    this.stickId = null;
    if (!this.enabled) return;
    document.body.classList.add('touch');
    this._build();
    // Touch players never get pointer lock: the start screen is tapped,
    // not clicked-into. Describe touch controls there instead of keys.
    const controls = document.querySelector('.overlay .controls');
    if (controls) controls.innerHTML = 'Joystick kiri: gerak · Drag kanan: aim<br>FIRE tembak · AIM bidik · R reload · JUMP lompat · CROUCH jongkok · E pasang/defuse bom';
  }

  _el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  _build() {
    // --- Joystick (left-bottom) ---
    this.stickZone = this._el('div', 'stick-zone touch-ui', document.body);
    this.stickNub = this._el('div', 'stick-nub', this.stickZone);
    const R = 48; // nub travel radius (px)
    const stickMove = (e) => {
      const r = this.stickZone.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      this.stickNub.style.transform = `translate(${dx}px, ${dy}px)`;
      // Up on the stick = forward; right = strafe right. Analog: further
      // push = faster (the vector is normalised by player.update).
      this.input.setTouchMove(-dy / R, dx / R);
    };
    const stickEnd = () => {
      this.stickId = null;
      this.stickNub.style.transform = '';
      this.input.setTouchMove(0, 0);
    };
    this.stickZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      this.stickZone.setPointerCapture(e.pointerId);
      stickMove(e);
    });
    this.stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) stickMove(e);
    });
    this.stickZone.addEventListener('pointerup', (e) => { if (e.pointerId === this.stickId) stickEnd(); });
    this.stickZone.addEventListener('pointercancel', (e) => { if (e.pointerId === this.stickId) stickEnd(); });

    // --- Touch look: drag anywhere on the canvas (right half). The
    // start overlay covers the screen until play starts, so this only
    // fires in-game. Buttons stopPropagation, so a drag starting on a
    // button never turns the camera.
    const canvas = document.getElementById('game');
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this.lookId !== null) return;
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId || !this.lookLast) return;
      this.input.touchLook(e.clientX - this.lookLast.x, e.clientY - this.lookLast.y);
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    const lookEnd = (e) => {
      if (e.pointerId === this.lookId) { this.lookId = null; this.lookLast = null; }
    };
    canvas.addEventListener('pointerup', lookEnd);
    canvas.addEventListener('pointercancel', lookEnd);

    // --- Buttons (right-bottom cluster) ---
    const btn = (label, cls, down, up) => {
      const b = this._el('button', `tbtn ${cls} touch-ui`, document.body, label);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        b.classList.add('on');
        down();
      });
      const end = (e) => {
        b.classList.remove('on');
        if (up) up();
      };
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    btn('FIRE', 'tbtn-fire', () => this.input.touchFire(true), () => this.input.touchFire(false));
    btn('AIM', 'tbtn-aim', () => this.input.touchAds(true), () => this.input.touchAds(false));
    btn('R', 'tbtn-reload', () => this.input.touchPress('KeyR'), null);
    btn('JUMP', 'tbtn-jump', () => this.input.touchKey('Space', true), () => this.input.touchKey('Space', false));
    btn('CROUCH', 'tbtn-crouch', () => this.input.touchKey('KeyC', true), () => this.input.touchKey('KeyC', false));
    btn('E', 'tbtn-action', () => this.input.touchKey('KeyE', true), () => this.input.touchKey('KeyE', false));
  }
}
