// sim.js — the fixed-step game simulation for FROSTLINE.
// One place owns the state: phase (freeze/round/end/matchEnd), round timer,
// scores, economy, bomb plant/defuse, and every hit. Rendering never writes
// here; main.js steps sim at a fixed 60 Hz and reads the results. Bots and
// the player only ever touch the world through this module's callbacks.
import * as THREE from 'three';
import { WEAPONS } from './weapons.js';
import { rayAABB, raySphere } from './player.js';

export const FREEZE_TIME = 15;
export const ROUND_TIME = 100;
export const BOMB_FUSE = 40;
export const WIN_ROUNDS = 5;
export const MAX_ROUNDS = 9;

export class Sim {
  constructor(map, player, bots, fx, audio, rng) {
    this.map = map; this.player = player; this.bots = bots;
    this.fx = fx; this.audio = audio; this.rng = rng;
    this.events = []; // drained by hud.js each frame: {type, ...}
    this.phase = 'freeze';
    this.round = 1;
    this.timer = FREEZE_TIME;
    this.score = { solara: 0, bastion: 0 };
    this.lossStreak = 0;
    this.bombPlanted = false;
    this.bombSite = null;
    this.bombPos = null;
    this.fuse = 0;
    this.plantProgress = 0;
    this.defuseProgress = 0;
    this.bombCarrier = null; // bot carrying the bomb when the player is dead
    this.time = 0;
    this.banner = '';
    this.bannerT = 0;
    this.killStreak = 0; // v3.8: consecutive player kills inside the multi-kill window
    this.lastKillT = -99;
    this.smokes = []; // active smoke clouds {pos, radius, until} — block bot LOS
    this.radioT = -99; // last radio line (global throttle)
    this.radioPerBot = new Map(); // bot name -> last line time
    this.defuseTime = 5; // 2.5 s with a defuse kit
    this.debugPlantHold = false; // shot mode: pretend E is held for the plant shot
  }
  get aliveBots() { return this.bots.filter((b) => b.alive); }
  teamAlive(team) {
    if (team === 'solara') return (this.player.alive ? 1 : 0) + this.bots.filter((b) => b.alive && b.team === 'solara').length;
    return this.bots.filter((b) => b.alive && b.team === 'bastion').length;
  }
  siteClear(site) {
    if (!this.map.sites[site]) return false;
    const c = this.map.sites[site].center;
    for (const b of this.bots) {
      if (!b.alive || b.team !== 'bastion') continue;
      if (Math.hypot(b.pos.x - c.x, b.pos.z - c.z) < 7) return false;
    }
    if (this.player.alive && this.player.pos.distanceTo(new THREE.Vector3(c.x, 0, c.z)) > 9) {
      // The player is far from the site; defenders near it still block the plant.
    }
    return this.bots.filter((b) => b.alive && b.team === 'bastion'
      && Math.hypot(b.pos.x - c.x, b.pos.z - c.z) < 7).length === 0;
  }

  // --- Round lifecycle ---------------------------------------------------------
  startRound() {
    this.phase = 'freeze';
    this.timer = FREEZE_TIME;
    this.bombPlanted = false;
    this.bombSite = null;
    this.bombPos = null;
    this.plantProgress = 0;
    this.defuseProgress = 0;
    // Respawn everyone.
    const p = this.player;
    p.pos.set(this.map.spawns.solara[0].x, 0, this.map.spawns.solara[0].z);
    p.yaw = -Math.PI / 2; p.pitch = 0;
    p.hp = 100; p.alive = true; p.armor = p.armor; // armor carries over
    for (const w of p.slots) { w.ammo = w.def.mag; w.reserve = w.def.reserve; w.reloading = 0; }
    p.hasBomb = true;
    // Utility counts + armor + defuse kit carry across rounds.
    this.bombCarrier = null;
    // Bots: 4 Solara friends + 5 Bastion. Sites: A 40% / mid 25% / B 35%.
    const solaraBots = this.bots.filter((b) => b.team === 'solara');
    const bastionBots = this.bots.filter((b) => b.team === 'bastion');
    solaraBots.forEach((b, i) => {
      const s = this.map.spawns.solara[(i + 1) % this.map.spawns.solara.length];
      b.spawnAt(s.x, s.z);
      b.hp = 100; b.alive = true; b.mesh.visible = true;
      b.isCarrier = false; b.channel = 0; b.goal = null;
      const r = this.rng();
      b.assignSite(r < 0.4 ? 'A' : r < 0.65 ? 'mid' : 'B');
      if (b.site === 'mid') b.assignSite(this.rng() < 0.5 ? 'A' : 'B');
      b.wp = b.nearestWaypoint();
    });
    const defSites = ['A', 'A', 'B', 'B', 'mid'];
    bastionBots.forEach((b, i) => {
      const s = this.map.spawns.bastion[i % this.map.spawns.bastion.length];
      b.spawnAt(s.x, s.z);
      b.hp = 100; b.alive = true; b.mesh.visible = true;
      b.isCarrier = false; b.channel = 0; b.goal = null;
      b.assignSite(defSites[i % defSites.length]);
      b.wp = b.nearestWaypoint();
    });
    this.setBanner(`ROUND ${this.round} — ${this.round === 1 ? 'FROSTLINE' : 'BUY PHASE'}`, 3);
    // Round-start plan callout from a Solara bot (throttle reset each round).
    this.radioT = -99; this.radioPerBot.clear();
    const caller = this.bots.find((b) => b.team === 'solara' && b.alive);
    if (caller) {
      const site = caller.site || 'A';
      this.radio(caller, this.rng() < 0.5
        ? `Pushing ${site} — follow me, watch the lanes.`
        : `Rush ${site} together. ${site === 'A' ? 'Foundry' : 'Crane Yard'} — go go go.`, true);
    }
  }
  // Radio callout: throttled (4 s global, 12 s per bot) unless forced.
  radio(bot, line, force = false) {
    if (!force) {
      if (this.time - this.radioT < 4) return;
      if (this.time - (this.radioPerBot.get(bot.name) ?? -99) < 12) return;
    }
    this.radioT = this.time;
    this.radioPerBot.set(bot.name, this.time);
    this.events.push({ type: 'radio', text: `${bot.name} [${bot.role}]: ${line}`, team: bot.team });
  }
  setBanner(text, dur = 3) {
    this.banner = text; this.bannerT = dur;
    this.events.push({ type: 'banner', text });
  }
  endRound(winner, reason) {
    if (this.phase === 'end' || this.phase === 'matchEnd') return;
    this.phase = 'end';
    this.timer = 4;
    this.score[winner]++;
    const p = this.player;
    if (winner === 'solara') {
      p.money += 3250;
      this.lossStreak = 0;
      this.setBanner(`SOLARA WINS THE ROUND — ${reason}`, 4);
    } else {
      const lossBonus = Math.min(2900, 1900 + this.lossStreak * 500);
      p.money += lossBonus;
      this.lossStreak++;
      this.setBanner(`BASTION WINS THE ROUND — ${reason}`, 4);
    }
    this.audio.roundWin();
    this.events.push({ type: 'roundEnd', winner, reason });
  }
  endMatch() {
    this.phase = 'matchEnd';
    const winner = this.score.solara > this.score.bastion ? 'solara' : 'bastion';
    this.setBanner(winner === 'solara' ? 'SOLARA TAKES THE MATCH' : 'BASTION TAKES THE MATCH', 8);
    this.events.push({ type: 'matchEnd', winner, score: { ...this.score } });
  }

  // --- Bomb ----------------------------------------------------------------------
  tryPlantOrDefuse(dt, input) {
    const p = this.player;
    this.defuseTime = p.hasKit ? 2.5 : 5;
    const held = input.plantHeld || this.debugPlantHold;
    if (this.phase !== 'round' || !p.alive) { this.plantProgress = 0; this.defuseProgress = 0; return; }
    if (!this.bombPlanted && p.hasBomb) {
      const site = this._playerSite();
      if (site && held) {
        this.plantProgress += dt;
        if (Math.floor(this.plantProgress * 4) !== Math.floor((this.plantProgress - dt) * 4)) this.audio.beep();
        if (this.plantProgress >= 3) this._plant(site);
      } else this.plantProgress = 0;
    } else if (this.bombPlanted && this.bombPos) {
      const d = Math.hypot(p.pos.x - this.bombPos.x, p.pos.z - this.bombPos.z);
      if (d < 2.5 && held) {
        this.defuseProgress += dt;
        if (Math.floor(this.defuseProgress * 4) !== Math.floor((this.defuseProgress - dt) * 4)) this.audio.beep();
        if (this.defuseProgress >= this.defuseTime) this._defuse();
      } else this.defuseProgress = 0;
    }
  }
  _playerSite() {
    for (const key of ['A', 'B']) {
      const c = this.map.sites[key].center;
      if (Math.hypot(this.player.pos.x - c.x, this.player.pos.z - c.z) < this.map.sites[key].r) return key;
    }
    return null;
  }
  _plant(site) {
    const c = this.map.sites[site].center;
    this.bombPlanted = true;
    this.bombSite = site;
    this.bombPos = new THREE.Vector3(c.x, 0.3, c.z);
    this.fuse = BOMB_FUSE;
    this.player.hasBomb = false;
    this.player.money += 300;
    this.audio.beep(true);
    this.events.push({ type: 'plant', site });
    this.setBanner('BOMB PLANTED — DEFEND THE SITE', 3);
  }
  _defuse() {
    this.bombPlanted = false;
    this.audio.beep(true);
    this.events.push({ type: 'defuse' });
    this.endRound('bastion', 'BOMB DEFUSED');
  }
  _detonate() {
    this.bombPlanted = false;
    this.fx.explosion.trigger(this.bombPos);
    this.audio.explosion();
    this.player.cameraShake = 1;
    this.events.push({ type: 'detonate' });
    this.endRound('solara', 'BOMB DETONATED');
  }
  onBotPlant(bot) {
    if (this.bombPlanted || this.phase !== 'round' || !this.map.sites[bot.site]) return;
    this._plant(bot.site);
    this.radio(bot, `Bomb planted ${bot.site} — hold the site!`, true);
  }
  onBotDefuse(bot) {
    if (!this.bombPlanted) return;
    this.bombPlanted = false;
    this.radio(bot, `Bomb defused — site ${this.bombSite} clear.`, true);
    this.endRound('bastion', 'BOMB DEFUSED');
  }

  // --- Kill banners (v3.8 action pass) ------------------------------------------
  // Headshot and multi-kill banners are HUD events; the streak window is 4 s.
  _onPlayerKill(headshot) {
    if (this.time - this.lastKillT < 4) this.killStreak += 1;
    else this.killStreak = 1;
    this.lastKillT = this.time;
    if (headshot) this.events.push({ type: 'killbanner', kind: 'headshot' });
    if (this.killStreak === 2) this.events.push({ type: 'killbanner', kind: 'double' });
    if (this.killStreak === 3) this.events.push({ type: 'killbanner', kind: 'triple' });
  }

  // --- Shooting --------------------------------------------------------------------
  resolveShot(shot) {
    const { origin, dir, weapon } = shot;
    let bestT = Infinity;
    let best = null; // {kind:'bot'|'wall', bot, part, point}
    // Bots: head sphere, torso + legs as spheres (cheap, stable).
    for (const b of this.bots) {
      if (!b.alive) continue;
      const headC = new THREE.Vector3(b.pos.x, b.pos.y + 1.66, b.pos.z);
      const torsoC = new THREE.Vector3(b.pos.x, b.pos.y + 1.15, b.pos.z);
      const legsC = new THREE.Vector3(b.pos.x, b.pos.y + 0.45, b.pos.z);
      const th = raySphere(origin, dir, headC, 0.22);
      if (th < bestT) { bestT = th; best = { kind: 'bot', bot: b, part: 'head' }; }
      const tt = raySphere(origin, dir, torsoC, 0.42);
      if (tt < bestT) { bestT = tt; best = { kind: 'bot', bot: b, part: 'torso' }; }
      const tl = raySphere(origin, dir, legsC, 0.4);
      if (tl < bestT) { bestT = tl; best = { kind: 'bot', bot: b, part: 'legs' }; }
    }
    // Walls: nearest AABB.
    for (const c of this.map.colliders) {
      const t = rayAABB(origin, dir, c);
      if (t < bestT) { bestT = t; best = { kind: 'wall', collider: c }; }
    }
    // Ground plane.
    if (dir.y < -0.001) {
      const t = -origin.y / dir.y;
      if (t > 0 && t < bestT) { bestT = t; best = { kind: 'ground' }; }
    }
    if (!best || bestT === Infinity || bestT > weapon.def.range) {
      // Tracer into the sky: nothing hit (still draw the streak to max range).
      if (shot.muzzlePos) this.fx.tracers.spawn(shot.muzzlePos, origin.clone().addScaledVector(dir, weapon.def.range));
      return;
    }
    const point = origin.clone().addScaledVector(dir, bestT);
    if (shot.muzzlePos) this.fx.tracers.spawn(shot.muzzlePos, point); // Gemini realism pass
    if (best.kind === 'bot') {
      const mult = best.part === 'head' ? weapon.def.headMult : best.part === 'legs' ? 0.75 : 1;
      const dmg = Math.round(weapon.def.damage * mult);
      const killed = best.bot.takeDamage(dmg);
      this.audio.hit();
      this.fx.particles.burst(point, 6, 2.5, 0.5, [0.75, 0.15, 0.12], 0.8, -3);
      if (killed) {
        this.audio.kill();
        this.player.money += 300;
        this.events.push({
          type: 'killfeed', killer: 'You', victim: best.bot.name,
          weapon: weapon.def.name, headshot: best.part === 'head',
        });
        this._onPlayerKill(best.part === 'head');
        if (best.bot.isCarrier) {
          // Bomb drops to the nearest alive Solara bot.
          const next = this.bots.find((b) => b.alive && b.team === 'solara');
          if (next) next.isCarrier = true;
          else this.player.hasBomb = true;
          best.bot.isCarrier = false;
        }
        if (this.teamAlive('bastion') === 0 && !this.bombPlanted) {
          this.endRound('solara', 'TEAM ELIMINATED');
        }
      }
    } else {
      // Impact: snow puff + decal, plus a spark burst on hard walls only
      // (Gemini realism pass — sparks on snow would read wrong).
      const normal = best.kind === 'ground'
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(-dir.x, 0, -dir.z).normalize();
      this.fx.particles.burst(point, 8, 2, 0.7, [0.92, 0.94, 0.96], 0.6, -5);
      if (best.kind === 'wall') this.fx.particles.burst(point, 12, 6, 0.2, [1, 0.9, 0.5], 1.2, -8);
      this.fx.decals.add(point, normal);
    }
  }
  onBotShot(bot, enemy, hit, dist) {
    // Muzzle flash at the bot + sound cue for the player.
    const mp = bot.eye.clone();
    this.fx.flash.fire(mp);
    this.fx.particles.smoke(mp, 1, 0.1, 0.3, 0.8);
    if (!hit) {
      const near = enemy.pos.clone();
      near.x += (this.rng() - 0.5) * 1.5;
      near.y += 1 + this.rng();
      near.z += (this.rng() - 0.5) * 1.5;
      this.fx.particles.burst(near, 4, 1.5, 0.5, [0.92, 0.94, 0.96], 0.4, -4);
      return;
    }
    if (enemy.isPlayer) {
      const died = this.player.damage(bot.damage, 'torso');
      this.events.push({ type: 'damage', amount: bot.damage });
      if (died) {
        this.events.push({
          type: 'killfeed', killer: bot.name, victim: 'You',
          weapon: WEAPONS[bot.weapon].name, headshot: false,
        });
        // Bomb drops to a Solara bot.
        if (this.player.hasBomb) {
          this.player.hasBomb = false;
          const next = this.bots.find((b) => b.alive && b.team === 'solara');
          if (next) next.isCarrier = true;
        }
        if (this.teamAlive('solara') === 0 && !this.bombPlanted) {
          this.endRound('bastion', 'TEAM ELIMINATED');
        }
      }
    } else if (enemy.bot) {
      const died = enemy.bot.takeDamage(bot.damage);
      if (died) {
        this.events.push({
          type: 'killfeed', killer: bot.name, victim: enemy.bot.name,
          weapon: WEAPONS[bot.weapon].name, headshot: false,
        });
        if (enemy.bot.team === 'solara' && this.teamAlive('solara') === 0 && !this.bombPlanted) {
          this.endRound('bastion', 'TEAM ELIMINATED');
        }
        if (enemy.bot.team === 'bastion' && this.teamAlive('bastion') === 0 && !this.bombPlanted) {
          this.endRound('solara', 'TEAM ELIMINATED');
        }
      }
    }
  }

  // --- Main fixed step ---------------------------------------------------------------
  update(dt, input) {
    this.time += dt;
    this.bannerT = Math.max(0, this.bannerT - dt);
    // v3.8: the multi-kill streak expires 4 s after the last player kill.
    if (this.killStreak > 0 && this.time - this.lastKillT > 4) this.killStreak = 0;
    // Smoke clouds from the player's smoke grenades (block bot LOS).
    if (this.player.lastSmoke) {
      const s = this.player.lastSmoke;
      this.player.lastSmoke = null;
      this.smokes.push({ pos: s.pos, radius: s.radius, until: this.time + s.duration });
    }
    this.smokes = this.smokes.filter((s) => s.until > this.time);
    // Flashbang pop: blind bots with line of sight, flash the player if
    // they are looking toward it.
    if (this.player.lastFlash) {
      const f = this.player.lastFlash;
      this.player.lastFlash = null;
      for (const b of this.bots) {
        if (!b.alive) continue;
        if (b.pos.distanceTo(f.pos) < f.radius && b.canSee(f.pos)) b.blind(f.blindTime);
      }
      const p = this.player;
      const eye = new THREE.Vector3(p.pos.x, p.eyeY, p.pos.z);
      const toFlash = f.pos.clone().sub(eye);
      const dist = toFlash.length();
      const dir = new THREE.Vector3(0, 0, -1)
        .applyEuler(new THREE.Euler(p.pitch, p.yaw, 0, 'YXZ'));
      const facing = dist > 0.01 ? toFlash.normalize().dot(dir) : 0;
      const strength = dist < f.radius && facing > 0.2
        ? Math.min(1, 0.4 + facing * 0.6 * (1 - dist / (f.radius * 1.5))) : 0;
      this.events.push({ type: 'flash', strength });
    }
    // Grenade blast damage (set by player._explodeGrenade).
    if (this.player.lastGrenadeBlast) {
      const blast = this.player.lastGrenadeBlast;
      this.player.lastGrenadeBlast = null;
      for (const b of this.bots) {
        if (!b.alive) continue;
        const d = b.pos.distanceTo(blast.pos);
        if (d < blast.radius) {
          const died = b.takeDamage(Math.round(blast.damage * (1 - d / blast.radius)));
          if (died) {
            this.player.money += 300;
            this.events.push({
              type: 'killfeed', killer: 'You', victim: b.name,
              weapon: 'HE', headshot: false,
            });
            this._onPlayerKill(false);
          }
        }
      }
      const pd = this.player.pos.distanceTo(blast.pos);
      if (pd < blast.radius && this.player.alive) this.player.damage(Math.round(blast.damage * (1 - pd / blast.radius) * 0.5), 'torso');
      if (this.teamAlive('bastion') === 0 && !this.bombPlanted && this.phase === 'round') {
        this.endRound('solara', 'TEAM ELIMINATED');
      }
    }
    // Phase timers.
    if (this.phase === 'freeze') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.phase = 'round';
        this.timer = ROUND_TIME;
        this.setBanner('GO — PLANT THE BOMB', 2);
      }
    } else if (this.phase === 'round') {
      if (this.bombPlanted) {
        this.fuse -= dt;
        if (this.fuse <= 0) this._detonate();
      } else {
        this.timer -= dt;
        if (this.timer <= 0) this.endRound('bastion', 'TIME EXPIRED');
      }
    } else if (this.phase === 'end') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.score.solara >= WIN_ROUNDS || this.score.bastion >= WIN_ROUNDS || this.round >= MAX_ROUNDS) {
          this.endMatch();
        } else {
          this.round++;
          this.startRound();
        }
      }
    }
    // Player plant/defuse channel.
    this.tryPlantOrDefuse(dt, input);
    // Player actions.
    const p = this.player;
    if (this.phase === 'round' && p.alive) {
      if (input.mouseDown) {
        const shot = p.tryFire(this.time, this.rng);
        if (shot) {
          this.resolveShot(shot);
          for (const b of this.bots) if (b.alive) b.hearShot(p.pos);
        }
      }
      if (input.consume('KeyR')) { if (p.weapon.startReload()) this.audio.reload(); }
      if (input.consume('KeyG')) p.throwGrenade(this.time);
      if (input.consume('Digit4')) p.cycleGrenade();
      if (input.consume('KeyQ')) p.equip((p.slot + 1) % p.slots.length);
      if (input.consume('Digit1')) p.equip(0);
      if (input.consume('Digit2') && p.slots.length > 1) p.equip(1);
      if (input.consume('Digit3') && p.slots.length > 2) p.equip(2);
    }
    // Recoil decay.
    p.recoil = Math.max(0, p.recoil - dt * 0.05);
    p.adsHeld = input.ads;
    p.update(dt, input, this.time);
    // Bots.
    const ctx = {
      player: p, bots: this.bots, map: this.map,
      bombPlanted: this.bombPlanted, bombSite: this.bombSite,
      time: this.time, phase: this.phase, // v3.8: bots only shoot in 'round'
      smokes: this.smokes,
      siteClear: (site) => this.siteClear(site),
      onPlant: (bot) => this.onBotPlant(bot),
      onDefuse: (bot) => this.onBotDefuse(bot),
      onRadio: (bot, line, force) => this.radio(bot, line, force),
      onBotShot: (bot, enemy, hit, dist) => this.onBotShot(bot, enemy, hit, dist),
    };
    for (const b of this.bots) b.update(dt, ctx);
    // Hear the player's shots (already done above for bots).
  }
}
