// hud.js — the FROSTLINE HUD: DOM + one 2D canvas minimap.
// The minimap is drawn from the REAL map data (bounds, colliders, sites,
// spawns) every frame — never a static picture — so it always agrees with
// the level: round outline, player arrow, teammates, A/B markers, bomb
// carrier and planted-bomb pulse. Everything else (health, big ammo, timer,
// money, score, kill feed, buy menu, banners) is plain DOM.
import { WEAPONS } from './weapons.js';
import { MAX_ROUNDS } from './sim.js';
import { settings, saveSettings } from './settings.js';

// Buy-menu weapon images (generated icons in game/assets/buy-icons/).
// Only the four weapons have images; utility/gear rows stay text-only.
const BUY_ICONS = { ar77: 'ar77', vex9: 'vex9', longbow: 'longbow', p9: 'p9' };

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
    // --- Minimap (top-left, round) ---
    const mmWrap = el('div', 'minimap-wrap', this.root);
    this.minimap = el('canvas', 'minimap', mmWrap);
    this.minimap.width = 168; this.minimap.height = 168;
    this.mm = this.minimap.getContext('2d');
    // --- Score + round (top-centre) ---
    const score = el('div', 'score', this.root);
    this.scoreSol = el('span', 'score-sol', score);
    this.scoreMid = el('span', 'score-mid', score);
    this.scoreBas = el('span', 'score-bas', score);
    this.timer = el('div', 'timer', this.root);
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
    // --- Bottom-left: health + money ---
    const bl = el('div', 'bl', this.root);
    this.hpBar = el('div', 'hpbar', bl);
    this.hpFill = el('div', 'hpfill', this.hpBar);
    this.hpText = el('div', 'hptext', bl);
    this.money = el('div', 'money', bl);
    // --- Bottom-right: weapon slots + big ammo ---
    const br = el('div', 'br', this.root);
    this.slots = el('div', 'slots', br);
    this._slotsSig = '';
    this.ammo = el('div', 'ammo', br);
    this.weaponName = el('div', 'wname', br);
    this.grenades = el('div', 'grenades', br);
    // --- Plant/defuse progress ---
    this.channel = el('div', 'channel', this.root);
    this.channelFill = el('div', 'channelfill', this.channel);
    this.channelLabel = el('div', 'channellabel', this.channel);
    // --- Damage vignette ---
    this.damageFx = el('div', 'damagefx', this.root);
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
    el('div', 'buy-hint', buyFoot).textContent = 'Hotkeys: [1–0] Buy · [B] Close';
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
    this.startOverlay = el('div', 'overlay', this.root);
    this.startOverlay.innerHTML = `<h1>FROSTLINE</h1>
      <p class="sub">Ironworks Ridge · 5v5 · Plant the bomb. Hold the snow.</p>
      <p class="controls">WASD move · Mouse aim · Click fire · R reload · Shift sprint · Space jump<br>
      Ctrl crouch · Right-click aim · B buy · E plant / defuse · G grenade · 4 cycle grenade · Q switch · Esc settings</p>
      <p class="cta">CLICK TO PLAY</p>`;
    this.endOverlay = el('div', 'overlay hidden', this.root);
    this.feedItems = [];
    this.buyOpen = false;
    this._lastBanner = '';
  }
  _buildBuy() {
    // Three-column grid like the reference armory: rifles | sidearms & utility | gear.
    const columns = [
      ['RIFLES', [['ar77', 'AR-77 Rifle'], ['vex9', 'Vex-9 SMG'], ['longbow', 'Longbow-7 Sniper']]],
      ['SIDEARMS & UTILITY', [['p9', 'P9 Pistol'], ['he', 'HE Grenade'], ['smoke', 'Smoke Grenade'], ['flash', 'Flashbang']]],
      ['GEAR', [['vest', 'Light Vest'], ['armor', 'Kevlar Vest'], ['kit', 'Defuse Kit']]],
    ];
    for (const [title, items] of columns) {
      const col = el('div', 'buy-col', this.buyItems);
      el('div', 'buy-section', col).textContent = title;
      for (const [id, label] of items) {
        const row = el('button', 'buy-item', col);
        row.dataset.id = id;
        row.dataset.label = label;
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
  refreshBuy() {
    this.buyMoney.textContent = `Money: $${this.player.money}`;
    this._refreshSquad();
    for (const row of this.buyItems.querySelectorAll('.buy-item')) {
      const id = row.dataset.id;
      const def = WEAPONS[id];
      const p = this.player;
      let price, stats, owned = false;
      if (id === 'vest') { price = 400; stats = 'ARMOR 50'; owned = p.armor >= 50; }
      else if (id === 'armor') { price = 650; stats = 'ARMOR 100'; owned = p.armor >= 100; }
      else if (id === 'kit') { price = 400; stats = p.hasKit ? 'OWNED — DEFUSE 2.5s' : 'DEFUSE 2.5s (was 5s)'; owned = p.hasKit; }
      else if (def.kind === 'grenade') {
        price = def.price;
        stats = id === 'he' ? 'DMG 110 · BLAST 6m' : id === 'smoke' ? 'BLOCKS SIGHT 9s' : 'BLINDS 2.5s';
        owned = p.grenades[id] >= 2;
      } else {
        price = def.price;
        stats = `DMG ${def.damage} · RPM ${def.rpm} · MAG ${def.mag}`;
      }
      const icon = BUY_ICONS[id] ? `<img class="buy-img" src="assets/buy-icons/${BUY_ICONS[id]}.webp" alt="">` : '';
      row.innerHTML = `${icon}<div class="buy-card-top"><span class="buy-name"></span><span class="buy-price"></span></div><span class="buy-stats"></span>`;
      row.querySelector('.buy-name').textContent = row.dataset.label;
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
    const foot = el('div', 'settings-foot', p);
    foot.textContent = 'Saved automatically · Esc closes · changes apply immediately';
    const close = el('button', 'settings-close', p);
    close.textContent = 'CLOSE';
    close.addEventListener('click', () => this.onCloseSettings && this.onCloseSettings());
    this.onCloseSettings = null; // wired by main.js
    this._refreshSettingsPanel();
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
  showEnd(winner, score, bots) {
    this.endOverlay.classList.remove('hidden');
    let roster = '';
    if (bots) {
      const team = bots.filter((b) => b.team === winner);
      roster = team.map((b) => `${b.name} (${b.role})`).join(' · ');
      if (winner === 'solara') roster = `You · ${roster}`;
    }
    this.endOverlay.innerHTML = `<h1>${winner === 'solara' ? 'SOLARA WINS' : 'BASTION WINS'}</h1>
      <p class="sub">Final score ${score.solara} — ${score.bastion}</p>
      ${roster ? `<p class="roster">${roster}</p>` : ''}
      <p class="cta">Press R to play again</p>`;
  }
  hideStart() { this.startOverlay.classList.add('hidden'); }

  drawMinimap(bots) {
    const g = this.mm, S = 168, C = S / 2;
    const b = this.map.bounds;
    const sx = (x) => C + ((x - (b.minX + b.maxX) / 2) / (b.maxX - b.minX)) * (S - 14);
    const sz = (z) => C + ((z - (b.minZ + b.maxZ) / 2) / (b.maxZ - b.minZ)) * (S - 14);
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath(); g.arc(C, C, C - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#dfe6ec'; g.fillRect(0, 0, S, S);
    // Colliders = cover / walls.
    g.fillStyle = '#5a6673';
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
    g.fillStyle = 'rgba(13,17,23,0.8)';
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
    // Round rim.
    g.strokeStyle = '#4a5568'; g.lineWidth = 3;
    g.beginPath(); g.arc(C, C, C - 2, 0, Math.PI * 2); g.stroke();
  }

  // Squad row: You + the four Solara bots (real names, roles, weapons).
  // Called on open and every frame while the menu is open, because bots are
  // only cached once the game loop has run at least one update.
  _refreshSquad() {
    if (!this._bots) return;
    const mates = [{ name: 'YOU', role: this.player.hasBomb ? 'Carrier' : 'Entry', weapon: this.player.weapon.def.name, money: this.player.money }];
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
      if (e.type === 'flash' && e.strength > 0) {
        this.flashFx.style.opacity = String(Math.min(1, e.strength));
        setTimeout(() => { this.flashFx.style.opacity = '0'; }, 100);
      }
      if (e.type === 'damage') {
        this.damageFx.style.opacity = '0.55';
        setTimeout(() => { this.damageFx.style.opacity = '0'; }, 180);
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
    // Score / timer / round pips.
    this.scoreSol.textContent = `SOLARA ${s.score.solara}`;
    this.scoreBas.textContent = `${s.score.bastion} BASTION`;
    this.scoreMid.textContent = `ROUND ${s.round}/${MAX_ROUNDS}`;
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
        : p.hasBomb ? '💣 YOU CARRY THE BOMB' : (this.botsCarrier(bots) ? '💣 ALLY CARRIES THE BOMB' : '');
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
      if (msg) {
        this.statusMsg.textContent = msg;
        this.statusMsg.classList.remove('hidden');
      } else this.statusMsg.classList.add('hidden');
    }
    // Health / money / ammo / weapon slots / utility.
    this.hpFill.style.width = `${p.hp}%`;
    this.hpFill.style.background = p.hp > 50 ? '#6fc3d8' : p.hp > 25 ? '#ffb347' : '#e05a4e';
    this.hpText.textContent = `HP ${Math.ceil(p.hp)}${p.armor > 0 ? `  ·  ARMOR ${Math.ceil(p.armor)}` : ''}${p.hasKit ? '  ·  KIT' : ''}`;
    this.money.textContent = `$${p.money}`;
    const w = p.weapon;
    this.ammo.innerHTML = `${w.ammo} <span>| ${w.reserve}</span>`;
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
    // Plant/defuse channel.
    const prog = s.plantProgress > 0 ? { v: s.plantProgress / 3, label: 'PLANTING…' }
      : s.defuseProgress > 0 ? { v: s.defuseProgress / s.defuseTime, label: p.hasKit ? 'DEFUSING… (KIT)' : 'DEFUSING…' } : null;
    if (prog) {
      this.channel.classList.remove('hidden');
      this.channelFill.style.width = `${Math.min(100, prog.v * 100)}%`;
      this.channelLabel.textContent = prog.label;
    } else this.channel.classList.add('hidden');
    // Crosshair spread follows movement + ADS.
    const spread = 6 + Math.hypot(p.vel.x, p.vel.z) * 1.2 + p.recoil * 120;
    this.cross.style.setProperty('--sp', `${Math.min(26, spread)}px`);
    this.cross.classList.toggle('ads', !!p.adsHeld);
    this.drawMinimap(bots);
  }
  botsCarrier(bots) {
    return bots.some((b) => b.alive && b.team === 'solara' && b.isCarrier);
  }
}
