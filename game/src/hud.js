// hud.js — the FROSTLINE HUD: DOM + one 2D canvas minimap.
// The minimap is drawn from the REAL map data (bounds, colliders, sites,
// spawns) every frame — never a static picture — so it always agrees with
// the level: round outline, player arrow, teammates, A/B markers, bomb
// carrier and planted-bomb pulse. Everything else (health, big ammo, timer,
// money, score, kill feed, buy menu, banners) is plain DOM.
import { WEAPONS } from './weapons.js';
import { MAX_ROUNDS } from './sim.js';

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
    el('div', 'buy-title', this.buy).textContent = 'BUY — FREEZE TIME';
    this.buyItems = el('div', 'buy-items', this.buy);
    this.buyMoney = el('div', 'buy-money', this.buy);
    this._buildBuy();
    el('div', 'buy-hint', this.buy).textContent = 'Press B to close · Click an item to buy';
    // --- Start / end overlays ---
    this.startOverlay = el('div', 'overlay', this.root);
    this.startOverlay.innerHTML = `<h1>FROSTLINE</h1>
      <p class="sub">Ironworks Ridge · 5v5 · Plant the bomb. Hold the snow.</p>
      <p class="controls">WASD move · Mouse aim · Click fire · R reload · Shift sprint<br>
      Ctrl crouch · Right-click aim · B buy · E plant / defuse · G grenade · 4 cycle grenade · Q switch</p>
      <p class="cta">CLICK TO PLAY</p>`;
    this.endOverlay = el('div', 'overlay hidden', this.root);
    this.feedItems = [];
    this.buyOpen = false;
    this._lastBanner = '';
  }
  _buildBuy() {
    const sections = [
      ['RIFLES', [['ar77', 'AR-77 Rifle'], ['vex9', 'Vex-9 SMG'], ['longbow', 'Longbow-7 Sniper']]],
      ['PISTOLS', [['p9', 'P9 Pistol']]],
      ['UTILITY', [['he', 'HE Grenade'], ['smoke', 'Smoke Grenade'], ['flash', 'Flashbang']]],
      ['GEAR', [['vest', 'Light Vest'], ['armor', 'Kevlar Vest'], ['kit', 'Defuse Kit']]],
    ];
    for (const [title, items] of sections) {
      el('div', 'buy-section', this.buyItems).textContent = title;
      for (const [id, label] of items) {
        const row = el('button', 'buy-item', this.buyItems);
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
      row.innerHTML = `${icon}<span class="buy-name"></span><span class="buy-stats"></span><span class="buy-price"></span>`;
      row.querySelector('.buy-name').textContent = row.dataset.label;
      row.querySelector('.buy-stats').textContent = stats;
      row.querySelector('.buy-price').textContent = `$${price}`;
      row.classList.toggle('buy-owned', owned);
    }
  }
  setBuyOpen(open) {
    this.buyOpen = open;
    this.buy.classList.toggle('hidden', !open);
    this.buyBackdrop.classList.toggle('hidden', !open);
    if (open) this.refreshBuy();
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
    // Planted bomb: pulsing ring.
    if (this.sim.bombPlanted && this.sim.bombPos) {
      const pulse = 6 + Math.sin(performance.now() / 200) * 3;
      g.strokeStyle = '#ff2f2f'; g.lineWidth = 2;
      g.beginPath(); g.arc(sx(this.sim.bombPos.x), sz(this.sim.bombPos.z), pulse + 6, 0, Math.PI * 2); g.stroke();
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

  update(dt, bots, events) {
    const p = this.player, s = this.sim;
    // Drain sim events.
    for (const e of events) {
      if (e.type === 'killfeed') this.pushFeed(e);
      if (e.type === 'radio') this.pushChat(e.text, e.team);
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
      : p.hasBomb ? '💣 YOU CARRY THE BOMB' : (this.botsCarrier(bots) ? '💣 ALLY CARRIES THE BOMB' : '');
    // Banner (hidden while the buy menu is open).
    if (s.bannerT > 0 && s.banner !== this._lastBanner) {
      this.banner.textContent = s.banner;
      this.banner.classList.remove('hidden');
      this._lastBanner = s.banner;
    }
    if (s.bannerT <= 0 || this.buyOpen) this.banner.classList.add('hidden');
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
