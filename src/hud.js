// hud.js — the FROSTLINE HUD: DOM + one 2D canvas minimap.
// The minimap is drawn from the REAL map data (bounds, colliders, sites,
// spawns) every frame — never a static picture — so it always agrees with
// the level: round outline, player arrow, teammates, A/B markers, bomb
// carrier and planted-bomb pulse. Everything else (health, big ammo, timer,
// money, score, kill feed, buy menu, banners) is plain DOM.
import { WEAPONS } from './weapons.js';
import { MAX_ROUNDS } from './sim.js';
import { settings, saveSettings, DIFFICULTY, DIFFICULTY_IDS } from './settings.js';
import { hasLOS } from './bots.js'; // v3.15: compass enemy markers (real LOS)

// (v3.13: the buy-menu weapon images are gone — the shop is text-only now,
// so there is no icon table anymore.)

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export class HUD {
  constructor(map, player, sim) {
    this.map = map; this.player = player; this.sim = sim;
    this.root = el('div', 'hud', document.body);
    // --- Minimap (v3.16 Phase 3a: TOP-LEFT, square, dark — reference-style) ---
    const mmWrap = el('div', 'minimap-wrap', this.root);
    this.minimap = el('canvas', 'minimap', mmWrap);
    this.minimap.width = 168; this.minimap.height = 168;
    this.mm = this.minimap.getContext('2d');
    // --- v3.16 Phase 3a: map location label under the minimap (reference:
    // "HOLLOWVENT - PUMP HALL"). Zone from the player's real position.
    this.mapLabel = el('div', 'maplabel', this.root);
    this._mapLabel = '';
    // --- v3.15: COMPASS (top-centre, below the score bar) — canvas 2D,
    // drawn every frame from the player's yaw + real site/enemy/bomb
    // positions (never static). Slimmer in 3a (280 px) so the top cluster
    // stays light.
    const compassWrap = el('div', 'compass', this.root);
    this.compass = el('canvas', '', compassWrap);
    this.compass.width = 280; this.compass.height = 34;
    this.cx = this.compass.getContext('2d');
    // --- v3.15: damage-direction indicator — 4 arcs around the crosshair.
    // The lit arc points at where the shot came from (front/right/back/
    // left relative to where the player faces). Driven by sim 'damage'
    // events, which carry the shooter's position (see sim.js onBotShot).
    this.dmgDir = el('div', 'dmgdir', this.root);
    this._dmgArcs = {};
    for (const d of ['n', 'e', 's', 'w']) this._dmgArcs[d] = el('div', `dmg-arc dmg-${d}`, this.dmgDir);
    this._dmgDirT = 0;
    // --- Score + round (v3.16 Phase 3a: ONE top-centre bar, reference-style:
    // SOLARA 1 · LIVE · 1:26 · ROUND 6/9 · 4 BASTION). The timer div moves
    // INSIDE the bar (class .timer kept, so probes/verify keep working).
    const score = el('div', 'score', this.root);
    this.scoreSol = el('span', 'score-sol', score);
    this.scoreStatus = el('span', 'score-status', score);
    this._scoreStatus = '';
    this.scoreMid = el('span', 'score-mid', score);
    this.scoreBas = el('span', 'score-bas', score);
    this.timer = el('div', 'timer', this.root);
    score.insertBefore(this.timer, this.scoreMid);
    this.bombStatus = el('div', 'bomb-status', this.root);
    // --- Team alive pips (top-centre, under the timer) ---
    this.pips = el('div', 'pips', this.root);
    this.pipsSol = el('div', 'pips-sol', this.pips);
    this.pipsBas = el('div', 'pips-bas', this.pips);
    for (let i = 0; i < 5; i++) { el('i', '', this.pipsSol); el('i', '', this.pipsBas); }
    // --- Kill feed (top-right) ---
    this.feed = el('div', 'feed', this.root);
    // --- Team chat / radio (bottom-left, above health) ---
    this.chat = el('div', 'chat', this.root);
    this.chatItems = [];
    // --- Flashbang white overlay ---
    this.flashFx = el('div', 'flashfx', this.root);
    // --- Banner (centre) ---
    this.banner = el('div', 'banner', this.root);
    // --- v3.11 death overlay: unmissable — the "freeze after 2 kills"
    // report is most plausibly a death the player never noticed (the old
    // death notice was one small status line, while dead players can't
    // move and holding teammates look frozen). Inline styles on purpose:
    // no index.html touch (UI builder's file). pointer-events none so it
    // never blocks clicks / re-locking.
    this.deathOverlay = el('div', 'death-overlay hidden', this.root);
    Object.assign(this.deathOverlay.style, {
      position: 'fixed', left: '50%', top: '34%', transform: 'translate(-50%,-50%)',
      textAlign: 'center', pointerEvents: 'none', zIndex: '60',
      background: 'rgba(10,10,14,0.72)', border: '2px solid #e0352b',
      borderRadius: '14px', padding: '18px 34px',
    });
    this.deathTitle = el('div', 'death-title', this.deathOverlay);
    Object.assign(this.deathTitle.style, {
      color: '#ff5a4e', fontSize: '44px', fontWeight: '900', letterSpacing: '2px',
      textShadow: '0 2px 12px rgba(0,0,0,0.8)',
    });
    this.deathTitle.textContent = '☠ YOU ARE DEAD';
    this.deathSub = el('div', 'death-sub', this.deathOverlay);
    Object.assign(this.deathSub.style, {
      color: '#fff', fontSize: '17px', fontWeight: '600', marginTop: '6px',
    });
    // --- v3.8 kill banners: HEADSHOT (top-right) + multi-kill (centre-low) ---
    this.killBanner = el('div', 'killbanner hidden', this.root);
    this.multiBanner = el('div', 'multibanner hidden', this.root);
    this._killBannerT = 0;
    this._multiBannerT = 0;
    this._hitT = 0; // hitmarker display timer (v3.9)
    // --- Crosshair (centre) ---
    this.cross = el('div', 'cross', this.root);
    for (let i = 0; i < 4; i++) el('i', '', this.cross);
    this.hitmarker = el('div', 'hitmarker', this.root);
    // --- v3.11 (OhMyGames): HP / ARMOR / CASH panel — v3.15 bottom-LEFT
    // (tactical). Three labelled rows, not one packed line.
    const bl = el('div', 'bl', this.root);
    this.hpPanel = bl;
    const hpRow = el('div', 'hp-row', bl);
    el('span', 'row-label hp-label', hpRow).textContent = '♥ HP';
    this.hpText = el('span', 'hptext', hpRow);
    this.hpBar = el('div', 'hpbar', bl);
    this.hpFill = el('div', 'hpfill', this.hpBar);
    const armorRow = el('div', 'armor-row', bl);
    el('span', 'row-label armor-label', armorRow).textContent = '🛡 ARMOR';
    this.armorText = el('span', 'armor-val', armorRow);
    const moneyRow = el('div', 'money-row', bl);
    el('span', 'row-label cash-label', moneyRow).textContent = '$ CASH';
    this.money = el('span', 'money', moneyRow);
    // --- Bottom-right: weapon (v3.16 Phase 3a: name on top, AMMO label,
    // big ammo, slots, grenades — reference order).
    const br = el('div', 'br', this.root);
    this.weaponName = el('div', 'wname', br);
    this.ammoLabel = el('div', 'ammo-label', br);
    this.ammoLabel.textContent = 'AMMO';
    this.ammo = el('div', 'ammo', br);
    this.slots = el('div', 'slots', br);
    this._slotsSig = '';
    this.grenades = el('div', 'grenades', br);
    // --- Plant/defuse progress ---
    this.channel = el('div', 'channel', this.root);
    this.channelFill = el('div', 'channelfill', this.channel);
    this.channelLabel = el('div', 'channellabel', this.channel);
    // --- v3.13 (item 1): plant/defuse prompt — big, unmissable, centre.
    // The v3.12 channel bar only appeared AFTER progress started, so a
    // player who tapped E (or tried during freeze) saw nothing at all.
    this.plantPrompt = el('div', 'plantprompt hidden', this.root);
    // --- v3.13 (item 8): difficulty tag under the timer.
    this.diffTag = el('div', 'difftag', this.root);
    this._diffLabel = '';
    // --- Damage vignette ---
    this.damageFx = el('div', 'damagefx', this.root);
    // --- v3.14 (item 1): sniper scope overlay — dark ring + crosshair,
    // shown only while ADS-ing the Longbow-7. Inline styles on purpose
    // (same pattern as the death overlay): no index.html touch.
    this.scopeOverlay = el('div', 'scope-overlay hidden', this.root);
    Object.assign(this.scopeOverlay.style, {
      position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '40',
      background: 'radial-gradient(circle 31vmin at 50% 50%, transparent 0, transparent 30vmin, rgba(0,0,0,0.97) 31.5vmin, rgba(0,0,0,0.97) 100%)',
    });
    const scopeRing = el('div', '', this.scopeOverlay);
    Object.assign(scopeRing.style, {
      position: 'absolute', left: '50%', top: '50%', width: '62vmin', height: '62vmin',
      transform: 'translate(-50%,-50%)', borderRadius: '50%',
      border: '3px solid rgba(0,0,0,0.9)', boxShadow: 'inset 0 0 40px rgba(0,0,0,0.8)',
    });
    const scopeH = el('div', '', this.scopeOverlay);
    Object.assign(scopeH.style, { position: 'absolute', left: '50%', top: '50%', width: '62vmin', height: '2px', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)' });
    const scopeV = el('div', '', this.scopeOverlay);
    Object.assign(scopeV.style, { position: 'absolute', left: '50%', top: '50%', width: '2px', height: '62vmin', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)' });
    // v3.16 Phase 4b: real reticle (CODM f-01/f-07 pattern) — the old overlay
    // was a bare circle + plain cross. Red centre cross, horizontal mil-dots,
    // vertical stadia with numbered T-marks (3/4/5) below the centre.
    const crossH = el('div', '', this.scopeOverlay);
    Object.assign(crossH.style, { position: 'absolute', left: '50%', top: '50%', width: '18px', height: '2px', transform: 'translate(-50%,-50%)', background: '#ff2a2a' });
    const crossV = el('div', '', this.scopeOverlay);
    Object.assign(crossV.style, { position: 'absolute', left: '50%', top: '50%', width: '2px', height: '18px', transform: 'translate(-50%,-50%)', background: '#ff2a2a' });
    const mkDot = (dx, dy) => {
      const d = el('div', '', this.scopeOverlay);
      Object.assign(d.style, { position: 'absolute', left: `calc(50% + ${dx}vmin)`, top: `calc(50% + ${dy}vmin)`, width: '5px', height: '5px', borderRadius: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)' });
    };
    [-20, -10, 10, 20].forEach((dx) => mkDot(dx, 0));
    const mkT = (dy, w, label) => {
      const t = el('div', '', this.scopeOverlay);
      Object.assign(t.style, { position: 'absolute', left: '50%', top: `calc(50% + ${dy}vmin)`, width: `${w}px`, height: '2px', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)' });
      if (label) {
        const n = el('div', '', this.scopeOverlay);
        n.textContent = label;
        Object.assign(n.style, { position: 'absolute', left: `calc(50% + ${w / 2 + 6}px)`, top: `calc(50% + ${dy}vmin)`, transform: 'translateY(-50%)', font: '700 11px monospace', color: 'rgba(0,0,0,0.85)' });
      }
    };
    mkT(-10, 12);
    mkT(10, 12, '3');
    mkT(20, 16, '4');
    mkT(30, 20, '5');
    const scopeLabel = el('div', '', this.scopeOverlay);
    Object.assign(scopeLabel.style, { position: 'absolute', left: '50%', bottom: '12%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.75)', fontSize: '13px', fontWeight: '700', letterSpacing: '2px' });
    scopeLabel.textContent = 'LONGBOW-7 · 8×';
    // --- v3.14 (item 2): death flash — a red wash that floods in on the
    // killing blow and fades over ~1.5 s (the 'damage' flash is a 180 ms
    // flicker; this one lingers while the camera falls).
    this.deathFx = el('div', 'deathfx', this.root);
    Object.assign(this.deathFx.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '45',
      background: 'radial-gradient(circle at 50% 50%, rgba(224,30,20,0.25) 0%, rgba(160,10,5,0.75) 100%)',
      opacity: '0',
    });
    this._deathFxT = 0;
    this._killer = ''; // "Name — [Weapon]" from the playerDied event
    // --- Buy menu (backdrop dims the bright snow behind it) ---
    this.buyBackdrop = el('div', 'buy-backdrop hidden', this.root);
    this.buy = el('div', 'buy hidden', this.root);
    const buyHead = el('div', 'buy-head', this.buy);
    el('div', 'buy-title', buyHead).textContent = 'BUY — FREEZE TIME';
    this.buyMoney = el('div', 'buy-money', buyHead);
    this.buySquad = el('div', 'buy-squad', this.buy);
    this.buyItems = el('div', 'buy-grid', this.buy);
    this._buildBuy();
    const buyFoot = el('div', 'buy-foot', this.buy);
    el('div', 'buy-econ', buyFoot).textContent = 'Win +$3,250 · Loss +$1,900 (+$500/streak, max $2,900) · Kill +$300 · Plant +$300';
    el('div', 'buy-hint', buyFoot).textContent = 'Klik atau tekan [1–0] untuk beli · [B] / [Esc] tutup · beli hanya saat freeze';
    // --- v3.13 (item 5): help button + panel — every key and what it does.
    this.helpBtn = el('button', 'helpbtn', this.root);
    this.helpBtn.textContent = '? HELP';
    this.helpBtn.addEventListener('click', () => this.onOpenHelp && this.onOpenHelp());
    this.setHelpVisible = (v) => { this.helpBtn.style.display = v ? '' : 'none'; };
    this.helpOpen = false;
    this.helpPanel = el('div', 'help hidden', this.root);
    this._buildHelp();
    this.onOpenHelp = null; // wired by main.js (owns input lock)
    // --- v3.10 status line: explains WHY the gun is silent right now
    // (buy phase / dead / round over / reloading / no ammo). The v3.9
    // playtest report "kadang tidak bisa nembak" was partly this: the gun
    // was correctly blocked by the rules and the screen said nothing.
    this.statusMsg = el('div', 'statusmsg hidden', this.root);
    this._statusT = 0; // transient message timer (persistent state wins otherwise)
    this._statusText = '';
    // --- v3.10 gear button (top-right) + settings panel + pause overlay ---
    this.settingsBtn = el('button', 'gearbtn', this.root);
    this.settingsBtn.textContent = '⚙ SETTINGS';
    this.settingsBtn.addEventListener('click', () => this.onOpenSettings && this.onOpenSettings());
    // v3.10: the gear is only clickable while the pointer is free. While
    // locked, a click on it would go to the canvas (and fire the weapon),
    // so main.js hides it whenever the lock is held — Esc / pause is the
    // way to settings mid-game.
    this.setGearVisible = (v) => { this.settingsBtn.style.display = v ? '' : 'none'; };
    this.settingsOpen = false;
    this.settingsPanel = el('div', 'settings hidden', this.root);
    this._buildSettings();
    this.pauseOverlay = el('div', 'overlay hidden', this.root);
    this.pauseOverlay.innerHTML = `<h1>PAUSED</h1>
      <p class="sub">Pointer unlocked — click to resume, or open Settings below.</p>
      <p class="cta">CLICK TO RESUME</p>`;
    const pauseBtns = el('div', 'pause-btns', this.pauseOverlay);
    const setBtn = el('button', 'pause-btn', pauseBtns);
    setBtn.textContent = '⚙ SETTINGS';
    setBtn.addEventListener('click', (e) => { e.stopPropagation(); this.onOpenSettings && this.onOpenSettings(); });
    this.pauseOverlay.addEventListener('click', () => this.onResume && this.onResume());
    this.onOpenSettings = null; // wired by main.js (owns input lock)
    this.onSettingsChange = null; // wired by main.js (key) => live apply
    this.onResume = null; // wired by main.js
    // --- Start / end overlays ---
    // v3.13: attack/defence SWAPS every round (item 1 + item 7) — the old
    // cards ("SOLARA ATTACK / BASTION HOLD") were only true half the time.
    this.startOverlay = el('div', 'overlay', this.root);
    this.startOverlay.innerHTML = `
      <h1>FROSTLINE</h1>
      <p class="sub">Ironworks Ridge · 5v5 · Bomb mission — attack &amp; defence swap every round.</p>
      <div class="teams">
        <div class="team-card team-sol"><b>SOLARA</b><span>ATTACK / DEFEND</span></div>
        <div class="team-card team-bas"><b>BASTION</b><span>DEFEND / ATTACK</span></div>
      </div>
      <p class="controls">WASD move · Mouse aim · Click fire · R reload · Shift sprint · Space jump<br>
      Ctrl crouch · Right-click aim · B buy · F plant / defuse (hold) · G grenade · 4 cycle grenade · Q/E lean · wheel switch weapon · T inspect · H help · Esc settings</p>
      <p class="diff-line">Difficulty: <b class="start-diff">NORMAL</b> · change in Settings (Esc)</p>
      <p class="cta">CLICK TO PLAY</p>`;
    this.startDiff = this.startOverlay.querySelector('.start-diff');
    this.endOverlay = el('div', 'overlay hidden', this.root);
    this.endOpen = false; // v3.13: true while the scoreboard is up
    this.feedItems = [];
    this.buyOpen = false;
    this._lastBanner = '';
  }
  // v3.13 (item 6): four TEXT columns, no images — like the reference
  // requisition screen, but our own weapons, prices and gear. Number keys
  // 1–0 buy in reading order (shown on each row). Images are gone: the
  // old buy-img webp files are no longer referenced anywhere.
  _buildBuy() {
    const columns = [
      ['SIDEARMS', [['p9', 'P9 Pistol']]],
      ['PRIMARIES', [['ar77', 'AR-77 Rifle'], ['vex9', 'Vex-9 SMG'], ['longbow', 'Longbow-7 Sniper']]],
      ['GRENADES', [['he', 'HE Grenade'], ['smoke', 'Smoke Grenade'], ['flash', 'Flashbang']]],
      ['GEAR', [['vest', 'Light Vest'], ['armor', 'Kevlar Vest'], ['kit', 'Defuse Kit']]],
    ];
    this._buyItems = []; // item ids in number-key order (1..9, 0)
    for (const [title, items] of columns) {
      const col = el('div', 'buy-col', this.buyItems);
      el('div', 'buy-section', col).textContent = title;
      for (const [id, label] of items) {
        const row = el('button', 'buy-item', col);
        row.dataset.id = id;
        row.dataset.label = label;
        this._buyItems.push(id);
        row.dataset.key = this._buyItems.length === 10 ? '0' : String(this._buyItems.length);
        row.addEventListener('click', () => {
          if (this.player.buy(id)) {
            this.audio && this.audio.beep();
            this.refreshBuy();
          }
        });
      }
    }
    this.refreshBuy();
  }
  // Buy by number key while the shop is open (main.js routes Digit1..0).
  buyByKey(code) {
    const idx = code === 'Digit0' ? 9 : parseInt(code.slice(5), 10) - 1;
    const id = this._buyItems && this._buyItems[idx];
    if (!id) return false;
    if (this.player.buy(id)) {
      this.audio && this.audio.beep();
      this.refreshBuy();
      return true;
    }
    return false;
  }
  refreshBuy() {
    this.buyMoney.textContent = `Money: $${this.player.money}`;
    this._refreshSquad();
    for (const row of this.buyItems.querySelectorAll('.buy-item')) {
      const id = row.dataset.id;
      const def = WEAPONS[id];
      const p = this.player;
      let price, stats, owned = false;
      if (id === 'vest') { price = 400; stats = 'ARMOR 50 — blocks half of incoming damage'; owned = p.armor >= 50; }
      else if (id === 'armor') { price = 650; stats = 'ARMOR 100 — full vest + helmet'; owned = p.armor >= 100; }
      else if (id === 'kit') { price = 400; stats = p.hasKit ? 'OWNED — DEFUSE 2.5s' : 'DEFUSE 2.5s (was 5s)'; owned = p.hasKit; }
      else if (def.kind === 'grenade') {
        price = def.price;
        stats = id === 'he' ? `DMG 110 · BLAST 6m — owned ×${p.grenades[id]}` : id === 'smoke' ? `BLOCKS SIGHT 9s — owned ×${p.grenades[id]}` : `BLINDS 2.5s — owned ×${p.grenades[id]}`;
        owned = p.grenades[id] >= 2;
      } else {
        price = def.price;
        stats = `DMG ${def.damage} · RPM ${def.rpm} · MAG ${def.mag}${p.slots.some((w) => w.def.id === id) ? ' — OWNED' : ''}`;
        owned = p.slots.some((w) => w.def.id === id);
      }
      row.innerHTML = `<div class="buy-card-top"><span class="buy-name"></span><span class="buy-price"></span></div><span class="buy-stats"></span>`;
      row.querySelector('.buy-name').textContent = `[${row.dataset.key}] ${row.dataset.label}`;
      row.querySelector('.buy-stats').textContent = stats;
      row.querySelector('.buy-price').textContent = `$${price}`;
      row.classList.toggle('buy-owned', owned);
    }
  }
  // v3.10: settings panel — sliders + toggles bound to the shared settings
  // singleton. Every change saves to localStorage at once and calls
  // onSettingsChange(key) so main.js can apply it live (volume, quality).
  _buildSettings() {
    const p = this.settingsPanel;
    el('div', 'settings-title', p).textContent = 'SETTINGS';
    const row = (label) => {
      const r = el('div', 'settings-row', p);
      el('span', 'settings-label', r).textContent = label;
      return r;
    };
    const slider = (label, min, max, step, key, fmt) => {
      const r = row(label);
      const input = el('input', 'settings-slider', r);
      input.type = 'range'; input.min = min; input.max = max; input.step = step;
      const val = el('span', 'settings-value', r);
      const sync = () => {
        input.value = settings[key];
        val.textContent = fmt(settings[key]);
      };
      input.addEventListener('input', () => {
        settings[key] = +input.value;
        val.textContent = fmt(settings[key]);
        saveSettings();
        this.onSettingsChange && this.onSettingsChange(key);
      });
      (this._settingsSyncs = this._settingsSyncs || []).push(sync);
      return sync;
    };
    const toggle = (label, key) => {
      const r = row(label);
      const input = el('input', 'settings-check', r);
      input.type = 'checkbox';
      const sync = () => { input.checked = settings[key]; };
      input.addEventListener('change', () => {
        settings[key] = input.checked;
        saveSettings();
        this.onSettingsChange && this.onSettingsChange(key);
      });
      (this._settingsSyncs = this._settingsSyncs || []).push(sync);
      return sync;
    };
    this._syncSens = slider('Mouse sensitivity', 0.2, 3, 0.05, 'sensitivity', (v) => `${(+v).toFixed(2)}×`);
    this._syncVol = slider('Master volume', 0, 1, 0.05, 'volume', (v) => `${Math.round(v * 100)}%`);
    this._syncMute = toggle('Mute all sound', 'muted');
    this._syncFov = slider('Field of view', 60, 100, 1, 'fov', (v) => `${v}°`);
    this._syncInv = toggle('Invert Y (mouse up = look down)', 'invertY');
    // Quality: two buttons, Low = lighter (pixelRatio 1, no shadows, fewer
    // particles/snow) for weak machines; High = full look.
    const qr = row('Graphics quality');
    const qLow = el('button', 'settings-qbtn', qr); qLow.textContent = 'LOW';
    const qHigh = el('button', 'settings-qbtn', qr); qHigh.textContent = 'HIGH';
    const syncQ = () => {
      qLow.classList.toggle('q-active', settings.quality === 'low');
      qHigh.classList.toggle('q-active', settings.quality === 'high');
    };
    qLow.addEventListener('click', () => { settings.quality = 'low'; saveSettings(); syncQ(); this.onSettingsChange && this.onSettingsChange('quality'); });
    qHigh.addEventListener('click', () => { settings.quality = 'high'; saveSettings(); syncQ(); this.onSettingsChange && this.onSettingsChange('quality'); });
    (this._settingsSyncs = this._settingsSyncs || []).push(syncQ);
    // v3.13 (item 8): difficulty — bot skill. Applies from the next round
    // (bots read it at spawn). MUDAH: bots miss more, react slower, hit
    // softer, die faster. SULIT: sharper aim, faster reactions, harder
    // hits, tougher bodies. NORMAL is the v3.12 baseline.
    const dr = row('Difficulty (bot skill)');
    const dBtns = {};
    for (const id of DIFFICULTY_IDS) {
      const b = el('button', 'settings-qbtn', dr);
      b.textContent = DIFFICULTY[id].label;
      dBtns[id] = b;
      b.addEventListener('click', () => {
        settings.difficulty = id;
        saveSettings();
        syncD();
        this.onSettingsChange && this.onSettingsChange('difficulty');
      });
    }
    const syncD = () => {
      for (const id of DIFFICULTY_IDS) dBtns[id].classList.toggle('q-active', settings.difficulty === id);
    };
    (this._settingsSyncs = this._settingsSyncs || []).push(syncD);
    const foot = el('div', 'settings-foot', p);
    foot.textContent = 'Saved automatically · Esc closes · changes apply immediately';
    const close = el('button', 'settings-close', p);
    close.textContent = 'CLOSE';
    close.addEventListener('click', () => this.onCloseSettings && this.onCloseSettings());
    this.onCloseSettings = null; // wired by main.js
    this._refreshSettingsPanel();
  }
  // v3.13 (item 5): help panel — every key, verified against input.js
  // (not made up: WASD/mouse/LMB/RMB/R/E/B/G/4/Q/1-3/Shift/Ctrl/C/Space/
  // Esc/H/R are all real bindings; Tab scoreboard does NOT exist and is
  // not listed). Open with H or the ? button, close with H / Esc / CLOSE.
  _buildHelp() {
    const p = this.helpPanel;
    el('div', 'help-title', p).textContent = 'KONTROL — FROSTLINE';
    const rows = [
      ['W A S D', 'Bergerak (maju / kiri / mundur / kanan)'],
      ['Mouse', 'Aim (bidik)'],
      ['Klik kiri', 'Tembak'],
      ['Klik kanan', 'ADS — bidik besi (lebih akurat, lebih lambat) · Longbow-7: scope zoom 8×'],
      ['R', 'Reload senjata'],
      ['E (tahan)', 'Pasang bom — bawa bom ke SITE A / B, tahan 3 detik · Defuse bom — dekati bom terpasang, tahan sampai penuh (kit: 2,5 detik)'],
      ['B', 'Buka shop — hanya saat freeze (15 detik sebelum ronde)'],
      ['G', 'Lempar granat (yang sedang dipilih)'],
      ['4', 'Ganti jenis granat: HE / Smoke / Flash'],
      ['Q', 'Ganti senjata'],
      ['1 / 2 / 3', 'Pilih senjata slot 1–3'],
      ['1–0 (di shop)', 'Beli item di shop'],
      ['Shift', 'Sprint (lari cepat)'],
      ['Ctrl / C', 'Jongkok'],
      ['Space', 'Lompat'],
      ['Esc', 'Pause · tutup panel'],
      ['H', 'Buka / tutup bantuan ini'],
      ['R (layar akhir)', 'Main lagi'],
    ];
    const table = el('div', 'help-table', p);
    for (const [key, desc] of rows) {
      const r = el('div', 'help-row', table);
      const k = el('span', 'help-key', r); k.textContent = key;
      const d = el('span', 'help-desc', r); d.textContent = desc;
    }
    const foot = el('div', 'help-foot', p);
    foot.textContent = 'Ronde ganjil SOLARA menyerang (kamu bawa bom) · ronde genap BASTION menyerang (kamu defuse).';
    const close = el('button', 'help-close', p);
    close.textContent = 'CLOSE  [H]';
    close.addEventListener('click', () => this.onCloseHelp && this.onCloseHelp());
    this.onCloseHelp = null; // wired by main.js
  }
  setHelpOpen(open) {
    this.helpOpen = open;
    this.helpPanel.classList.toggle('hidden', !open);
  }
  _refreshSettingsPanel() {
    for (const sync of this._settingsSyncs || []) sync();
  }
  setSettingsOpen(open) {
    this.settingsOpen = open;
    this.settingsPanel.classList.toggle('hidden', !open);
    if (open) this._refreshSettingsPanel();
  }
  setPauseOpen(open) {
    this.pauseOverlay.classList.toggle('hidden', !open);
  }
  // Transient status line (e.g. MAG FULL on a failed R). Persistent state
  // (freeze/dead/round-over) is computed in update() and wins when no
  // transient is showing.
  showStatus(text, dur = 1.5) {
    this._statusText = text;
    this._statusT = dur;
    this.statusMsg.textContent = text;
    this.statusMsg.classList.remove('hidden');
  }
  setBuyOpen(open) {
    this.buyOpen = open;
    this.buy.classList.toggle('hidden', !open);
    this.buyBackdrop.classList.toggle('hidden', !open);
    if (open) this.refreshBuy();
  }
  // v3.9 (DeepSeek): the hitmarker element existed but nothing ever
  // showed it. Flash it on every hit the player lands, red on headshot,
  // and let update() hide it ~150 ms later.
  showHitmarker(headshot) {
    this.hitmarker.classList.toggle('hs', !!headshot);
    this.hitmarker.style.display = 'block';
    this._hitT = 0.15;
  }
  showKillBanner(kind) {
    if (kind === 'headshot') {
      this.killBanner.innerHTML = `☠ HEADSHOT! <b>+100</b>`;
      this.killBanner.classList.remove('hidden');
      this._killBannerT = 1.5;
    } else if (kind === 'double' || kind === 'triple') {
      this.multiBanner.innerHTML = `☠ ${kind === 'double' ? 'DOUBLE KILL' : 'TRIPLE KILL'}`;
      this.multiBanner.classList.remove('hidden');
      this._multiBannerT = 1.5;
    }
  }
  pushFeed(e) {
    const d = el('div', 'feed-item', this.feed);
    if (typeof e === 'string' || !e.weapon) {
      d.textContent = typeof e === 'string' ? e : `${e.killer} ▸ ${e.victim}`;
    } else {
      const k = el('span', 'feed-killer', d); k.textContent = e.killer;
      d.appendChild(document.createTextNode(' ▸ '));
      const w = el('span', 'feed-weapon', d); w.textContent = `[${e.weapon}] `;
      const v = el('span', 'feed-victim', d); v.textContent = e.victim;
      if (e.headshot) {
        d.classList.add('feed-hs');
        const h = el('span', 'feed-hs-tag', d); h.textContent = ' HEADSHOT';
      }
    }
    this.feedItems.push({ el: d, t: 6 });
    if (this.feedItems.length > 5) {
      const old = this.feedItems.shift();
      old.el.remove();
    }
  }
  pushChat(text, team) {
    const d = el('div', 'chat-item' + (team === 'bastion' ? ' chat-bas' : ''), this.chat);
    d.textContent = text;
    this.chatItems.push({ el: d, t: 9 });
    if (this.chatItems.length > 3) {
      const old = this.chatItems.shift();
      old.el.remove();
    }
  }
  // v3.16 Phase 4e: scoreboard columns PLANTS / DEFUSES (real tracked
  // stats — sim.js counts them at the plant/defuse call sites) beside
  // K/D/PTS/CASH/WEAPON, plus a team bar with round pips above each table
  // (CODM f-06 pattern: one pip per round, filled with the winner's
  // colour, empty for unplayed rounds). The reward row stays real.
  showEnd() {
    const s = this.sim;
    const winner = s.score.solara > s.score.bastion ? 'solara' : 'bastion';
    const youWin = winner === 'solara';
    const pts = (r) => r.kills * 2 + r.assists;
    const weaponOf = (name) => {
      if (name === 'You') return this.player.weapon.def.name;
      const b = this._bots && this._bots.find((x) => x.name === name);
      return b ? (WEAPONS[b.weapon] ? WEAPONS[b.weapon].name : b.weapon) : '—';
    };
    const rows = (team) => [...s.stats.values()]
      .filter((r) => r.team === team)
      .sort((a, b) => b.kills - a.kills || b.damage - a.damage)
      .map((r) => `<tr><td class="sb-name">${r.name}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.plants || 0}</td><td>${r.defuses || 0}</td><td>${pts(r)}</td><td>$${r.earned}</td><td>${weaponOf(r.name)}</td></tr>`).join('');
    const totals = (team) => {
      const rs = [...s.stats.values()].filter((r) => r.team === team);
      const sum = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
      return `<tr class="sb-total"><td class="sb-name">Team</td><td>${sum('kills')}</td><td>${sum('deaths')}</td><td>${sum('plants')}</td><td>${sum('defuses')}</td><td>${rs.reduce((a, r) => a + pts(r), 0)}</td><td>$${sum('earned')}</td><td></td></tr>`;
    };
    // Round pips: one pip per round of the 9-round match. Filled with the
    // winning team's colour, hollow for rounds the team lost, dim for
    // rounds never played (match ended early at 5 wins).
    const pips = (team) => {
      let out = '';
      for (let i = 0; i < MAX_ROUNDS; i++) {
        const w = s.roundResults[i];
        const cls = !w ? 'pip-todo' : w === team ? 'pip-win' : 'pip-loss';
        out += `<span class="sb-pip ${cls}"></span>`;
      }
      return out;
    };
    const teambar = (team, label, cls) => `<div class="sb-teambar ${cls}"><span class="sb-tb-name">${label}</span><span class="sb-tb-pips">${pips(team)}</span><span class="sb-tb-score">${s.score[team]}</span></div>`;
    const table = (team, label, cls) => `<div class="sb-team ${cls}"><h3>${label} <span class="sb-score">${s.score[team]}</span></h3><table class="sb-table"><tr><th>PLAYER</th><th>K</th><th>D</th><th>PLANTS</th><th>DEFUSES</th><th>PTS</th><th>CASH</th><th>WEAPON</th></tr>${rows(team) || '<tr><td colspan="8">No stats recorded</td></tr>'}${totals(team)}</table></div>`;
    const me = s.stats.get(this.player);
    const reward = me ? me.earned : 0;
    const reason = s.lastRoundReason ? `: ${s.lastRoundReason}` : '';
    this.endOverlay.classList.remove('hidden');
    // v3.16 Phase 3a: the match banner ("SOLARA TAKES THE MATCH", 8 s) would
    // show through the semi-transparent overlay and collide with the win
    // line — hide it; the scoreboard IS the match announcement now.
    this.sim.bannerT = 0;
    this.endOverlay.innerHTML = `<p class="sb-kicker">ROUND OVER · ROUND ${s.round} OF ${MAX_ROUNDS}</p>
      <div class="sb-hazard"><h1 class="${youWin ? 'sb-win' : 'sb-lose'}">${youWin ? '★ SOLARA WIN ★' : '★ BASTION WIN ★'}</h1></div>
      <p class="sub">${youWin ? 'Solara' : 'Bastion'} win${reason} · Final score — SOLARA ${s.score.solara} · ${s.score.bastion} BASTION</p>
      <div class="sb-teambars">${teambar('solara', 'SOLARA', 'sb-sol')}${teambar('bastion', 'BASTION', 'sb-bas')}</div>
      <p class="sb-reward">Your reward $${reward}</p>
      <div class="sb-tables">${table('solara', 'SOLARA', 'sb-sol')}${table('bastion', 'BASTION', 'sb-bas')}</div>
      <p class="roster">PTS = 2 per kill + 1 per assist · Cash = earned this match (kill $300 · plant $300 · round bonus) · Plants / Defuses = tracked this match</p>
      <button class="sb-again" id="sb-again">▶ MAIN LAGI</button>
      <p class="cta">Press R to play again</p>`;
    this.endOpen = true; // v3.13: keeps the pause overlay off the scoreboard
    const btn = this.endOverlay.querySelector('#sb-again');
    if (btn) btn.addEventListener('click', () => this.onPlayAgain && this.onPlayAgain());
  }
  hideEnd() { this.endOverlay.classList.add('hidden'); this.endOpen = false; }
  hideStart() { this.startOverlay.classList.add('hidden'); }

  drawMinimap(bots) {
    const g = this.mm, S = 168, C = S / 2;
    const b = this.map.bounds;
    const sx = (x) => C + ((x - (b.minX + b.maxX) / 2) / (b.maxX - b.minX)) * (S - 14);
    const sz = (z) => C + ((z - (b.minZ + b.maxZ) / 2) / (b.maxZ - b.minZ)) * (S - 14);
    g.clearRect(0, 0, S, S);
    g.save();
    // v3.16 Phase 3a: square dark minimap (reference-style), not a circle.
    g.beginPath(); g.roundRect(2, 2, S - 4, S - 4, 10); g.clip();
    g.fillStyle = '#23262b'; g.fillRect(0, 0, S, S);
    // Colliders = cover / walls.
    g.fillStyle = '#6b7684';
    for (const c of this.map.colliders) {
      g.fillRect(sx(c.minX), sz(c.minZ), sx(c.maxX) - sx(c.minX), sz(c.maxZ) - sz(c.minZ));
    }
    // Sites.
    for (const key of ['A', 'B']) {
      const c = this.map.sites[key].center;
      g.fillStyle = key === 'A' ? '#ff7a2f' : '#6fc3d8';
      g.fillRect(sx(c.x) - 9, sz(c.z) - 9, 18, 18);
      g.fillStyle = '#0d1117';
      g.font = 'bold 12px system-ui';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(key, sx(c.x), sz(c.z) + 0.5);
    }
    // Zone labels: spatial context on the minimap (Gemini v3.3 review).
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = 'bold 8px system-ui';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('FOUNDRY', sx(15), sz(-12) + 17);
    g.fillText('CRANE YARD', sx(15), sz(12) + 17);
    g.fillText('MID', sx(0), sz(0) - 11);
    // Planted bomb: pulsing ring (v3.9: sim time, not performance.now() —
    // the minimap must stay deterministic like the rest of the sim).
    if (this.sim.bombPlanted && this.sim.bombPos) {
      const pulse = 6 + Math.sin(this.sim.time * 5) * 3;
      g.strokeStyle = '#ff2f2f'; g.lineWidth = 2;
      g.beginPath(); g.arc(sx(this.sim.bombPos.x), sz(this.sim.bombPos.z), pulse + 6, 0, Math.PI * 2); g.stroke();
    }
    // v3.10: dropped bomb — yellow pulsing dot, so the recovery target is
    // visible on the map instead of vanishing silently.
    if (this.sim.bombDropped) {
      const pulse = 4 + Math.sin(this.sim.time * 5) * 2;
      g.fillStyle = '#ffd24a';
      g.beginPath(); g.arc(sx(this.sim.bombDropped.pos.x), sz(this.sim.bombDropped.pos.z), pulse + 3, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#0d1117'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(sx(this.sim.bombDropped.pos.x), sz(this.sim.bombDropped.pos.z), pulse + 3, 0, Math.PI * 2); g.stroke();
    }
    // Teammates (bots).
    for (const bot of bots) {
      if (!bot.alive || bot.team !== 'solara') continue;
      g.fillStyle = bot.isCarrier ? '#ffd24a' : '#6fc3d8';
      g.beginPath(); g.arc(sx(bot.pos.x), sz(bot.pos.z), bot.isCarrier ? 5 : 3.5, 0, Math.PI * 2); g.fill();
    }
    // Player arrow (rotated by yaw).
    const p = this.player;
    const px = sx(p.pos.x), pz = sz(p.pos.z);
    g.save();
    g.translate(px, pz);
    g.rotate(-p.yaw - Math.PI / 2);
    g.fillStyle = '#ff7a2f';
    g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(0, 2.5); g.lineTo(-5, 5); g.closePath(); g.fill();
    g.restore();
    g.restore();
    // Square rim.
    g.strokeStyle = '#4a5568'; g.lineWidth = 3;
    g.beginPath(); g.roundRect(2, 2, S - 4, S - 4, 10); g.stroke();
  }

  // Squad row: You + the four Solara bots (real names, roles, weapons).
  // Called on open and every frame while the menu is open, because bots are
  // only cached once the game loop has run at least one update.
  _refreshSquad() {
    if (!this._bots) return;
    const mates = [{ name: 'YOU', role: this.player.hasBomb ? 'Carrier' : (this.sim.attackTeam === 'solara' ? 'Entry' : 'Defender'), weapon: this.player.weapon.def.name, money: this.player.money }];
    for (const b of this._bots) {
      if (b.team !== 'solara') continue;
      mates.push({ name: b.name, role: b.role, weapon: WEAPONS[b.weapon] ? WEAPONS[b.weapon].name : b.weapon });
    }
    this.buySquad.innerHTML = mates.map((m) => `<div class="buy-mate"><b>${m.name}</b><span>${m.role} · ${m.weapon}${m.money !== undefined ? ` · $${m.money}` : ''}</span></div>`).join('');
  }

  update(dt, bots, events) {
    this._bots = bots; // cached so the buy menu can render the squad row.
    if (this.buyOpen) this._refreshSquad();
    const p = this.player, s = this.sim;
    // Drain sim events.
    for (const e of events) {
      if (e.type === 'killfeed') this.pushFeed(e);
      if (e.type === 'killbanner') this.showKillBanner(e.kind);
      if (e.type === 'hitmarker') this.showHitmarker(e.headshot);
      if (e.type === 'radio') this.pushChat(e.text, e.team);
      if (e.type === 'status') this.showStatus(e.text, e.dur || 1.5); // v3.10
      if (e.type === 'matchEnd') this.showEnd(); // v3.13 (item 4): the end overlay never showed in real play
      if (e.type === 'flash' && e.strength > 0) {
        this.flashFx.style.opacity = String(Math.min(1, e.strength));
        setTimeout(() => { this.flashFx.style.opacity = '0'; }, 100);
      }
      if (e.type === 'damage') {
        this.damageFx.style.opacity = '0.55';
        setTimeout(() => { this.damageFx.style.opacity = '0'; }, 180);
        // v3.15: light the arc that points at the shooter.
        if (e.from) this.showDamageDir(e.from.x, e.from.z);
      }
      if (e.type === 'playerDied') {
        // v3.14 (item 2): the killing blow — red wash + killer line.
        this._killer = `${e.killer} — [${e.weapon}]`;
        this.deathFx.style.opacity = '0.9';
        this._deathFxT = 1.6;
      }
      if (e.type === 'banner') { /* banner text handled below */ }
    }
    events.length = 0;
    // Feed timers.
    for (let i = this.feedItems.length - 1; i >= 0; i--) {
      const f = this.feedItems[i];
      f.t -= dt;
      if (f.t <= 0) { f.el.remove(); this.feedItems.splice(i, 1); }
    }
    // Hitmarker: shown on a hit, hidden ~150 ms later.
    if (this._hitT > 0) {
      this._hitT -= dt;
      if (this._hitT <= 0) this.hitmarker.style.display = 'none';
    }
    // Chat timers.
    for (let i = this.chatItems.length - 1; i >= 0; i--) {
      const c = this.chatItems[i];
      c.t -= dt;
      if (c.t <= 0) { c.el.remove(); this.chatItems.splice(i, 1); }
    }
    // v3.16 Phase 3a: map location label (real player position → zone).
    const zx = p.pos.x, zz = p.pos.z;
    const zone = Math.hypot(zx - 15, zz + 12) < 8 ? 'FOUNDRY'
      : Math.hypot(zx - 15, zz - 12) < 8 ? 'CRANE YARD'
      : zx < -10 ? 'WEST YARD' : zx > 10 ? 'EAST YARD' : 'MID';
    const ml = `IRONWORKS RIDGE · ${zone}`;
    if (this._mapLabel !== ml) { this._mapLabel = ml; this.mapLabel.textContent = ml; }
    // Score / timer / round pips.
    this.scoreSol.textContent = `SOLARA ${s.score.solara}`;
    this.scoreBas.textContent = `${s.score.bastion} BASTION`;
    this.scoreMid.textContent = `ROUND ${s.round}/${MAX_ROUNDS}`;
    // v3.16 Phase 3a: status in the top bar (LIVE / PLANTED / FREEZE / ...).
    const st = s.phase === 'freeze' ? 'FREEZE'
      : s.phase === 'end' ? 'ROUND OVER' : s.phase === 'matchEnd' ? 'MATCH OVER'
      : s.bombPlanted ? `PLANTED — SITE ${s.bombSite}` : 'LIVE';
    if (this._scoreStatus !== st) { this._scoreStatus = st; this.scoreStatus.textContent = st; }
    const aliveSol = (p.alive ? 1 : 0) + bots.filter((b) => b.alive && b.team === 'solara').length;
    const aliveBas = bots.filter((b) => b.alive && b.team === 'bastion').length;
    [...this.pipsSol.children].forEach((dot, i) => dot.classList.toggle('dead', i >= aliveSol));
    [...this.pipsBas.children].forEach((dot, i) => dot.classList.toggle('dead', i >= aliveBas));
    const t = Math.max(0, Math.ceil(s.timer));
    this.timer.textContent = s.bombPlanted
      ? `BOMB ${Math.max(0, Math.ceil(s.fuse))}`
      : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.timer.classList.toggle('urgent', (s.bombPlanted && s.fuse < 10) || (!s.bombPlanted && s.timer < 10 && s.phase === 'round'));
    this.bombStatus.textContent = s.bombPlanted
      ? `💣 BOMB PLANTED — SITE ${s.bombSite}`
      : s.bombDropped
        ? '💣 BOMB DROPPED — RECOVER IT'
        : p.hasBomb ? '💣 YOU CARRY THE BOMB — PLANT AT A / B'
        : (() => { const c = bots.find((b) => b.alive && b.isCarrier); return c ? `💣 ${c.name.toUpperCase()} CARRIES THE BOMB` : (s.attackTeam === 'bastion' ? '💣 BASTION ATTACKS — DEFEND THE SITES' : ''); })();
    // v3.13 (item 8): difficulty tag (cached write) + start-screen line.
    const dLabel = `KESULITAN: ${(DIFFICULTY[settings.difficulty] || DIFFICULTY.normal).label}`;
    if (this._diffLabel !== dLabel) {
      this._diffLabel = dLabel;
      this.diffTag.textContent = dLabel;
      if (this.startDiff) this.startDiff.textContent = (DIFFICULTY[settings.difficulty] || DIFFICULTY.normal).label;
    }
    // v3.13 (item 1): unmissable plant/defuse prompt. The channel bar
    // only appears once progress starts; this tells the player WHAT to do
    // and WHERE, before they ever press F.
    const inSite = (() => {
      for (const key of ['A', 'B']) {
        const c = s.map.sites[key].center;
        if (Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < s.map.sites[key].r) return key;
      }
      return null;
    })();
    let prompt = '';
    if (s.phase === 'round' && p.alive) {
      if (!s.bombPlanted && p.hasBomb) {
        prompt = inSite ? `TAHAN [F] UNTUK PASANG BOM — SITE ${inSite}` : 'Bawa bom ke SITE A / B — tahan [F] untuk pasang';
      } else if (s.bombPlanted && s.attackTeam === 'bastion' && s.bombPos
        && Math.hypot(p.pos.x - s.bombPos.x, p.pos.z - s.bombPos.z) < 2.5) {
        prompt = p.hasKit ? 'TAHAN [F] UNTUK DEFUSE BOM (KIT — 2,5 dtk)' : 'TAHAN [F] UNTUK DEFUSE BOM';
      } else if (s.bombPlanted && s.attackTeam === 'bastion') {
        prompt = `BOM TERPASANG DI SITE ${s.bombSite} — dekati dan tahan [F] untuk defuse`;
      }
    } else if (s.phase === 'freeze' && p.hasBomb) {
      prompt = 'Ronde mulai — bawa bom ke SITE A / B, tahan [F] untuk pasang';
    }
    if (prompt) {
      this.plantPrompt.textContent = prompt;
      this.plantPrompt.classList.remove('hidden');
      this.plantPrompt.classList.toggle('plantprompt-big', prompt.startsWith('TAHAN'));
    } else this.plantPrompt.classList.add('hidden');
    // Banner (hidden while the buy menu is open).
    if (s.bannerT > 0 && s.banner !== this._lastBanner) {
      this.banner.textContent = s.banner;
      this.banner.classList.remove('hidden');
      this._lastBanner = s.banner;
    }
    if (s.bannerT <= 0 || this.buyOpen) this.banner.classList.add('hidden');
    // v3.8 kill banners: auto-hide ~1.5 s after they appear.
    if (this._killBannerT > 0) {
      this._killBannerT -= dt;
      if (this._killBannerT <= 0) this.killBanner.classList.add('hidden');
    }
    if (this._multiBannerT > 0) {
      this._multiBannerT -= dt;
      if (this._multiBannerT <= 0) this.multiBanner.classList.add('hidden');
    }
    // v3.10 status line: a transient message (MAG FULL, BOMB DROPPED…)
    // wins while its timer runs; otherwise the persistent state explains
    // why the gun is silent — freeze, dead, or round over. Before v3.10
    // all of these showed nothing at all.
    if (this._statusT > 0) {
      this._statusT -= dt;
      if (this._statusT <= 0) this.statusMsg.classList.add('hidden');
    } else {
      const w = p.weapon;
      let msg = '';
      if (s.phase === 'freeze') msg = `BUY PHASE — firing starts in ${Math.max(0, Math.ceil(s.timer))}s · press B to buy`;
      else if (s.phase === 'end') msg = 'ROUND OVER';
      else if (s.phase === 'matchEnd') msg = '';
      else if (!p.alive) msg = '☠ YOU ARE DEAD — wait for the next round';
      else if (w.reloading > 0) msg = 'RELOADING…';
      else if (w.ammo === 0 && w.reserve === 0) msg = 'NO AMMO — buy more next round (B)';
      if (msg && !this.buyOpen) {
        this.statusMsg.textContent = msg;
        this.statusMsg.classList.remove('hidden');
      } else this.statusMsg.classList.add('hidden');
    }
    // v3.11 death overlay: show while dead, hide on respawn (round start).
    if (!p.alive && s.phase !== 'matchEnd') {
      this.deathOverlay.classList.remove('hidden');
      const rt = Math.max(0, Math.ceil(s.timer));
      const respawn = s.phase === 'round'
        ? `Round ends in ${Math.floor(rt / 60)}:${String(rt % 60).padStart(2, '0')} — you respawn next round`
        : 'Next round starting…';
      // v3.14 (item 2): say WHO killed you — the old sub only gave the
      // respawn timer, so deaths felt random and unanswerable.
      this.deathSub.textContent = this._killer ? `Dibunuh oleh ${this._killer} · ${respawn}` : respawn;
    } else { this.deathOverlay.classList.add('hidden'); this._killer = ''; }
    // v3.14 (item 2): the death flash fades over ~1.5 s (dt-driven, so it
    // tracks the sim clock like everything else).
    if (this._deathFxT > 0) {
      this._deathFxT -= dt;
      this.deathFx.style.opacity = String(Math.max(0, (this._deathFxT / 1.6) * 0.9));
    }
    // Health / money / ammo / weapon slots / utility.
    // v3.15: HP bar is white when healthy, orange when hurt, red when
    // critical (was teal); low-HP pulses the whole panel (see .lowhp).
    this.hpFill.style.width = `${p.hp}%`;
    this.hpFill.style.background = p.hp > 50 ? '#f4f6f8' : p.hp > 25 ? '#ff7a2f' : '#e0352b';
    this.hpPanel.classList.toggle('lowhp', p.alive && p.hp <= 25);
    this.hpText.textContent = `${Math.ceil(p.hp)}`;
    this.armorText.textContent = `${Math.ceil(p.armor)}${p.hasKit ? ' · KIT' : ''}`;
    this.money.textContent = `$${p.money}`;
    const w = p.weapon;
    this.ammo.innerHTML = `${w.ammo} <span>| ${w.reserve}</span>`;
    // v3.15: ammo count pops (scale) when it changes — a small, real
    // animation tied to gameplay, not decoration.
    if (this._lastAmmo !== w.ammo) {
      this._lastAmmo = w.ammo;
      this.ammo.classList.remove('bump');
      void this.ammo.offsetWidth;
      this.ammo.classList.add('bump');
    }
    this.weaponName.textContent = w.reloading > 0 ? `RELOADING…` : w.def.name;
    const g = p.grenades;
    const sel = p.grenadeType;
    const gTxt = (id, label) => `${sel === id ? '[' : ''}${label} ×${g[id]}${sel === id ? ']' : ''}`;
    this.grenades.textContent = `${gTxt('he', 'HE')} · ${gTxt('smoke', 'SMK')} · ${gTxt('flash', 'FLS')}  [4]`;
    // Weapon slots strip: [1 P9] [2 AR-77] [3 —] + bomb cell.
    const sig = `${p.slots.map((s2) => s2.def.id).join(',')}|${p.slot}|${p.hasBomb}`;
    if (sig !== this._slotsSig) {
      this._slotsSig = sig;
      this.slots.innerHTML = '';
      p.slots.forEach((s2, i) => {
        const c = el('span', 'slot' + (i === p.slot ? ' slot-active' : ''), this.slots);
        c.textContent = `${i + 1} ${s2.def.name}`;
      });
      for (let i = p.slots.length; i < 3; i++) {
        const c = el('span', 'slot slot-empty', this.slots);
        c.textContent = `${i + 1} —`;
      }
      if (p.hasBomb) {
        const c = el('span', 'slot slot-bomb', this.slots);
        c.textContent = '💣 BOMB';
      }
    }
    // Plant/defuse channel (v3.16 Phase 3a: label carries the real
    // remaining seconds, reference-style "DEFUSING WITH KIT 2.7s").
    const prog = s.plantProgress > 0
      ? { v: s.plantProgress / 3, label: `PLANTING… ${Math.max(0, 3 - s.plantProgress).toFixed(1)}s` }
      : s.defuseProgress > 0
        ? { v: s.defuseProgress / s.defuseTime, label: `${p.hasKit ? 'DEFUSING WITH KIT' : 'DEFUSING…'} ${Math.max(0, s.defuseTime - s.defuseProgress).toFixed(1)}s` }
        : null;
    if (prog) {
      this.channel.classList.remove('hidden');
      this.channelFill.style.width = `${Math.min(100, prog.v * 100)}%`;
      this.channelLabel.textContent = prog.label;
    } else this.channel.classList.add('hidden');
    // Crosshair spread follows movement + ADS.
    const spread = 6 + Math.hypot(p.vel.x, p.vel.z) * 1.2 + p.recoil * 120;
    this.cross.style.setProperty('--sp', `${Math.min(26, spread)}px`);
    this.cross.classList.toggle('ads', !!p.adsHeld);
    // v3.14 (item 1): the scope overlay shows only while ADS-ing the
    // Longbow-7 alive; the plain crosshair hides inside the scope (the
    // overlay carries its own crosshair).
    const scoped = p.alive && p.adsHeld && p.weapon.def.zoom;
    this.scopeOverlay.classList.toggle('hidden', !scoped);
    this.cross.style.display = scoped ? 'none' : '';
    // v3.15: damage-direction arcs fade out ~0.9 s after the hit.
    if (this._dmgDirT > 0) {
      this._dmgDirT -= dt;
      if (this._dmgDirT <= 0) for (const a of Object.values(this._dmgArcs)) a.style.opacity = '0';
    }
    this.drawMinimap(bots);
    this.drawCompass(bots);
  }

  // v3.15: COMPASS — heading strip driven by the player's yaw (0 = north
  // -Z, 90 = east +X). Ticks every 15°, cardinals labelled; markers for
  // sites A/B (always), the planted bomb (pulsing), the bomb carrier, and
  // enemies the player can actually SEE (real LOS + <40 m) — never
  // invented positions. Bearing math: yawToFace(target) =
  // atan2(-(tx-px), -(tz-pz)); heading = -yaw in degrees.
  drawCompass(bots) {
    const g = this.cx, W = 280, H = 34, cx = W / 2;
    if (!g) return;
    const p = this.player;
    const wrap180 = (a) => { while (a > 180) a -= 360; while (a < -180) a += 360; return a; };
    const heading = (((-p.yaw) * 180 / Math.PI) % 360 + 360) % 360;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(20,24,28,0.78)';
    g.beginPath(); g.roundRect(0, 0, W, H, 8); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 1;
    g.beginPath(); g.roundRect(0.5, 0.5, W - 1, H - 1, 8); g.stroke();
    const pxPerDeg = W / 124; // show ±62°
    // Ticks + cardinal labels.
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let h = 0; h < 360; h += 15) {
      const rel = wrap180(h - heading);
      if (Math.abs(rel) > 62) continue;
      const x = cx + rel * pxPerDeg;
      const card = h % 90 === 0 ? ['N', 'E', 'S', 'W'][h / 90] : h % 45 === 0 ? ['NE', 'SE', 'SW', 'NW'][Math.floor(h / 45) % 4] : null;
      g.strokeStyle = card ? 'rgba(244,246,248,0.9)' : 'rgba(244,246,248,0.35)';
      g.lineWidth = card ? 2 : 1;
      g.beginPath(); g.moveTo(x, 6); g.lineTo(x, card ? 16 : 12); g.stroke();
      if (card) {
        g.fillStyle = card.length === 1 ? '#ff7a2f' : 'rgba(244,246,248,0.85)';
        g.font = 'bold 10px system-ui';
        g.fillText(card, x, 25);
      }
    }
    // Marker helper: bearing from the player to a world point.
    const marker = (tx, tz, color, label, pulse) => {
      const yawTo = Math.atan2(-(tx - p.pos.x), -(tz - p.pos.z));
      const bearing = (((-yawTo) * 180 / Math.PI) % 360 + 360) % 360;
      const rel = wrap180(bearing - heading);
      if (Math.abs(rel) > 60) return;
      const x = cx + rel * pxPerDeg;
      const r = pulse ? 4 + Math.sin(this.sim.time * 5) * 1.5 : 4;
      g.fillStyle = color;
      g.beginPath(); g.arc(x, 10, r, 0, Math.PI * 2); g.fill();
      if (label) {
        g.fillStyle = '#fff';
        g.font = 'bold 8px system-ui';
        g.fillText(label, x, 10);
      }
    };
    for (const key of ['A', 'B']) {
      const c = this.map.sites[key].center;
      marker(c.x, c.z, key === 'A' ? '#ff7a2f' : '#4da3ff', key, false);
    }
    if (this.sim.bombPlanted && this.sim.bombPos) marker(this.sim.bombPos.x, this.sim.bombPos.z, '#ff2f2f', '', true);
    else {
      const carrier = bots.find((b) => b.alive && b.isCarrier);
      if (carrier) marker(carrier.pos.x, carrier.pos.z, '#ffd24a', '', false);
    }
    // Visible enemies only (real LOS, <40 m) — the compass never reveals
    // a hidden enemy.
    const eye = { x: p.pos.x, y: p.eyeY, z: p.pos.z };
    for (const b of bots) {
      if (!b.alive || b.team !== 'bastion') continue;
      const d = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
      if (d > 40) continue;
      if (!hasLOS(eye, b.eye, this.map.colliders, this.sim.smokes || [])) continue;
      marker(b.pos.x, b.pos.z, '#ff4d42', '', false);
    }
    // Centre caret (current heading) + degree readout.
    g.fillStyle = '#ff7a2f';
    g.beginPath(); g.moveTo(cx - 5, 2); g.lineTo(cx + 5, 2); g.lineTo(cx, 8); g.closePath(); g.fill();
    g.fillStyle = 'rgba(244,246,248,0.9)';
    g.font = 'bold 9px system-ui';
    g.fillText(`${Math.round(heading)}°`, cx, 28);
  }

  // v3.15: light the arc pointing at the shooter. rel is the bearing of
  // the attacker relative to where the player faces: 0 = straight ahead.
  showDamageDir(fromX, fromZ) {
    const p = this.player;
    const yawTo = Math.atan2(-(fromX - p.pos.x), -(fromZ - p.pos.z));
    let rel = yawTo - p.yaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    // Bearing convention: yaw grows counter-clockwise (forward =
    // (-sin yaw, -cos yaw)), so a target with yawTo > yaw sits to the
    // player's LEFT — rel > 0 lights the left ('w') arc, rel < 0 the
    // right ('e') arc. (The first version had e/w swapped.)
    const dir = Math.abs(rel) <= Math.PI / 4 ? 'n'
      : rel > Math.PI / 4 && rel <= (3 * Math.PI) / 4 ? 'w'
      : rel < -Math.PI / 4 && rel >= (-3 * Math.PI) / 4 ? 'e' : 's';
    for (const [k, a] of Object.entries(this._dmgArcs)) a.style.opacity = k === dir ? '1' : '0';
    this._dmgDirT = 0.9;
  }
}
