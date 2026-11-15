// bots.js — bot AI for FROSTLINE: one Bot class, one state machine.
// States: patrol -> push/hold -> engage -> plant/defuse -> retreat.
// Bots walk a waypoint graph (map.js), see with a raycast line-of-sight test
// against map colliders, hear gunshots (alert radius 25 m), react in
// 250-600 ms, and shoot back in bursts with distance-based accuracy.
// Defenders hold sites (2 A, 2 B, 1 mid/roam); attackers push as a group
// (A 40% / mid 25% / B 35%) and plant when their site is clear.
import * as THREE from 'three';
import { rayAABB, raySphere } from './player.js';
import { TEAM_COLORS } from './palette.js';
import { WEAPONS } from './weapons.js';

const BOT_SPEED = 3.9;
const BOT_HP = 100;

function hasLOS(from, to, colliders, smokes = []) {
  const d = new THREE.Vector3().subVectors(to, from);
  const dist = d.length();
  if (dist < 0.01) return true;
  d.normalize();
  for (const c of colliders) {
    const t = rayAABB(from, d, c);
    if (t < dist) return false;
  }
  // Smoke clouds block sight: segment vs sphere.
  for (const s of smokes) {
    const px = s.pos.x - from.x, py = s.pos.y - from.y, pz = s.pos.z - from.z;
    const along = Math.max(0, Math.min(dist, px * d.x + py * d.y + pz * d.z));
    const cx = from.x + d.x * along, cy = from.y + d.y * along, cz = from.z + d.z * along;
    if (Math.hypot(s.pos.x - cx, s.pos.y - cy, s.pos.z - cz) < s.radius) return false;
  }
  return true;
}

// Squad roles (shown in radio callouts): Entry leads the push, Sapper plants,
// Anchor holds a site, Roamer rotates to sound.
const ROLES = {
  Ash: 'Entry', Birch: 'Entry', Cinder: 'Sapper', Ember: 'Anchor',
  Frost: 'Anchor', Glacier: 'Anchor', Hail: 'Roamer', Sleet: 'Roamer', Storm: 'Anchor',
};

function siteNameFor(pos, map) {
  for (const key of ['A', 'B']) {
    const c = map.sites[key].center;
    if (Math.hypot(pos.x - c.x, pos.z - c.z) < 8) return key;
  }
  return 'mid';
}

export function buildBotMesh(team) {
  const color = TEAM_COLORS[team];
  const g = new THREE.Group();
  // v3.10 TERANG SEIMBANG (user pick, middle panel): Solara wears warm
  // olive-camo, Bastion a vivid police-blue uniform — both readable
  // against bright snow instead of dark silhouettes. Was 0x6b5a44 /
  // 0x4a5568. Vests take the vivid TEAM_COLORS (red / royal blue).
  const suit = new THREE.MeshStandardMaterial({ color: team === 'solara' ? 0x7a7448 : 0x2f5fb8, roughness: 0.9, metalness: 0.05 });
  const vest = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.2 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x9c7d5f, roughness: 0.8, metalness: 0 }); // v3.10: was 0x8a6f52 — warmer/lighter skin
  const gun = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.45, metalness: 0.8 }); // v3.10: was 0x23262b — the rifle read as a black slab
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.62, 0.3), suit);
  torso.position.y = 1.15;
  const vestM = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.4, 0.34), vest);
  vestM.position.y = 1.18;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), skin);
  head.position.y = 1.66;
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), vest);
  helmet.position.y = 1.72;
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.85, 0.22), suit);
  legL.position.set(-0.14, 0.43, 0);
  const legR = legL.clone();
  legR.position.x = 0.14;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.16), suit);
  armL.position.set(-0.33, 1.22, 0.16);
  armL.rotation.x = -1.15; // v3.9: left hand reaches forward to the handguard
  const armR = armL.clone();
  armR.position.x = 0.33;
  armR.position.z = 0.14;
  armR.rotation.x = -1.0; // v3.9: right hand at the grip
  // v3.9: a full rifle, held forward at chest height — the old 0.85 m dark
  // slab was unreadable at range, so bots looked unarmed. Receiver +
  // barrel + handguard + magazine + stock + team-colour accent band;
  // ~1.35 m long, muzzle ~0.85 m in front of the chest. The barrel steel
  // is deliberately light so the rifle reads against dark containers too.
  const gunLight = new THREE.MeshStandardMaterial({ color: 0x8d99a6, roughness: 0.35, metalness: 0.8 }); // v3.10: was 0x707b88 — lighter barrel steel reads against dark containers
  const accent = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 });
  const rifle = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.55), gun);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.5), gunLight);
  barrel.position.set(0, 0.02, -0.5);
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.1), gunLight);
  muzzle.position.set(0, 0.02, -0.78);
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.12, 0.32), gun);
  handguard.position.set(0, 0, -0.3);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.24, 0.13), gunLight);
  mag.position.set(0, -0.17, 0.05);
  mag.rotation.x = 0.25;
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.28), gun);
  stock.position.set(0, 0, 0.38);
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.05, 0.12), accent);
  band.position.set(0, 0.09, -0.05);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.12), gunLight);
  sight.position.set(0, 0.11, -0.05);
  for (const m of [receiver, barrel, muzzle, handguard, mag, stock, band, sight]) {
    m.castShadow = true;
    rifle.add(m);
  }
  rifle.name = 'proc-rifle'; // v3.10: swapped for the real SCAR-L GLB when it loads
  rifle.position.set(0.08, 1.3, -0.15);
  for (const m of [torso, vestM, head, helmet, legL, legR, armL, armR]) {
    m.castShadow = true;
    g.add(m);
  }
  g.add(rifle);
  g.userData.head = head;
  return g;
}

export class Bot {
  constructor(scene, map, team, name, rng, isCarrier = false) {
    this.scene = scene; this.map = map; this.team = team;
    this.name = name; this.role = ROLES[name] || 'Rifler'; this.rng = rng;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.hp = BOT_HP; this.alive = true;
    this.state = 'patrol';
    this.wp = 0; // current waypoint index
    this.goal = null; // {x, z} destination
    this.site = null; // 'A' | 'B' | 'mid'
    this.reaction = 0; // seconds until allowed to shoot after spotting
    this.fireTimer = 0; this.burstLeft = 0;
    this.alert = 0; // hearing alert timer
    this.alertPos = null;
    this.blindT = 0; // flashbang blindness: cannot shoot while > 0
    this._heardShot = false; // fresh gunshot heard -> one radio rotate call
    this._heardSite = 'mid';
    this._smokes = []; // active smoke clouds (set from ctx each update)
    this.channel = 0; // plant/defuse progress seconds
    this.isCarrier = isCarrier;
    this.stuckTimer = 0; this.lastPos = new THREE.Vector3();
    this.retargetTimer = 0;
    this.quietTimer = 0; // v3.10: seconds since last enemy contact (hunt trigger)
    this.mesh = buildBotMesh(team);
    scene.add(this.mesh);
    this.weapon = team === 'bastion' ? 'ar77' : (rng() < 0.5 ? 'ar77' : 'vex9');
    this.damage = this.weapon === 'ar77' ? 13 : 10; // per-hit vs player
    this.accuracy = 0.55;
    // v3.10: bot ammo — bots never reloaded (they shot empty forever once
    // the mag ran out in a long fight). Mag + reserve from the weapon table;
    // reserve is infinite (bots don't buy ammo), the reload TIME is the cost.
    this.ammo = WEAPONS[this.weapon].mag;
    this.reloading = 0;
    // v3.10: hunt memory — last seen enemy position + time, and the current
    // hunt target. Without this a bot that loses sight just stands at its
    // site goal forever (the "tidak mau mengejar" report).
    this.lastSeen = null; // {x, z, t}
    this.huntTarget = null; // {x, z, kind} — 'lastseen' | 'spawn' | 'sweep'
    this.huntTimer = 0;
    this.idleTimer = 0; // seconds standing at a reached goal with no enemy
    this.path = []; // v3.10: BFS path (waypoint indices) toward this.goal
    this._pathGoal = null;
  }
  // v3.10: swap the boxy procedural rifle for the real SCAR-L GLB (loaded
  // once in main.js, cloned per bot — geometries/materials shared, so 9
  // clones cost almost nothing). The viewmodel hands are stripped (the bot
  // mesh has its own arms); a team-colour band keeps the team readable.
  equipRealRifle(group) {
    const old = this.mesh.getObjectByName('proc-rifle');
    if (old) this.mesh.remove(old);
    if (this.mesh.getObjectByName('real-rifle')) return; // already equipped
    const rifle = group.clone();
    rifle.name = 'real-rifle';
    // Remove the viewmodel's floating hands outright (the bot mesh has its
    // own arms reaching forward); the muzzle Object3D stays, harmless.
    for (const h of [...rifle.children]) if (h.name === 'vm-hand') rifle.remove(h);
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.05, 0.14),
      new THREE.MeshStandardMaterial({ color: TEAM_COLORS[this.team], roughness: 0.5, metalness: 0.3 }),
    );
    band.position.set(0, 0.09, -0.05);
    rifle.add(band);
    rifle.position.set(0.08, 1.28, -0.12);
    this.mesh.add(rifle);
  }
  get eye() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.55, this.pos.z); }
  spawnAt(x, z) {
    this.pos.set(x, 0, z);
    this.lastPos.copy(this.pos);
    this.mesh.position.copy(this.pos);
    this.ammo = WEAPONS[this.weapon].mag; // v3.10: fresh mag each round
    this.reloading = 0;
    this.lastSeen = null; this.huntTarget = null; this.idleTimer = 0;
    this.path = []; this._pathGoal = null; // v3.10: BFS path resets on spawn
  }
  assignSite(site) { this.site = site; }
  nearestWaypoint() {
    let best = 0, bd = Infinity;
    this.map.waypoints.forEach((w, i) => {
      const d = (w.x - this.pos.x) ** 2 + (w.z - this.pos.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  // Next waypoint toward the goal.
  // v3.10: BFS pathfinding over the waypoint graph. The old greedy step
  // ("neighbour closest to the goal") stalls at local minima — a bot whose
  // current waypoint has no improving neighbour stands still forever even
  // with a goal 2 m away. Reproduced 16 Nov: 9/9 bots moved 0 m in the last
  // 10 s of a round, goals set, enemies 22–35 m away. BFS on 35 nodes is
  // trivial and always finds a route when one exists. The final leg (last
  // waypoint -> goal) steers straight at the goal.
  _computePath() {
    const wps = this.map.waypoints;
    const goal = this.goal;
    if (!goal) { this.path = []; return; }
    let dest = 0, bd = Infinity;
    wps.forEach((w, i) => {
      const d = (w.x - goal.x) ** 2 + (w.z - goal.z) ** 2;
      if (d < bd) { bd = d; dest = i; }
    });
    let start = 0; bd = Infinity;
    wps.forEach((w, i) => {
      const d = (w.x - this.pos.x) ** 2 + (w.z - this.pos.z) ** 2;
      if (d < bd) { bd = d; start = i; }
    });
    this.wp = start;
    if (start === dest) { this.path = [dest]; return; }
    const prev = new Array(wps.length).fill(-1);
    const queue = [start];
    prev[start] = start;
    while (queue.length) {
      const cur = queue.shift();
      if (cur === dest) break;
      for (const n of wps[cur].links) {
        if (prev[n] === -1) { prev[n] = cur; queue.push(n); }
      }
    }
    if (prev[dest] === -1) { this.path = [dest]; return; } // unreachable: head for the nearest node
    const path = [];
    let cur = dest;
    while (cur !== start) { path.unshift(cur); cur = prev[cur]; }
    this.path = path;
  }
  stepTowardGoal(dt) {
    const wps = this.map.waypoints;
    const goal = this.goal;
    if (!goal) return;
    if (!this.path || this.path.length === 0 || this._pathGoal !== goal) {
      this._pathGoal = goal;
      this._computePath();
    }
    // Final leg: no more waypoints — steer straight at the goal.
    const target = this.path.length > 0 ? wps[this.path[0]] : goal;
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.4) {
      const sp = BOT_SPEED * (this.state === 'retreat' ? 1.15 : 1);
      this.pos.x += (dx / dist) * sp * dt;
      this.pos.z += (dz / dist) * sp * dt;
      this.yaw = Math.atan2(-dx, -dz) + Math.PI;
      // Simple collision: stop at colliders.
      for (const c of this.map.colliders) {
        if (this.pos.x > c.minX - 0.35 && this.pos.x < c.maxX + 0.35
          && this.pos.z > c.minZ - 0.35 && this.pos.z < c.maxZ + 0.35
          && this.pos.y < c.h) {
          this.pos.x -= (dx / dist) * sp * dt;
          this.pos.z -= (dz / dist) * sp * dt;
          break;
        }
      }
    } else if (this.path.length > 0) {
      this.path.shift();
    } else if (Math.hypot(goal.x - this.pos.x, goal.z - this.pos.z) < 1.2) {
      this.goal = null;
    }
    // Stuck detection: no progress in 2 s -> re-anchor to the nearest
    // waypoint and recompute the path. (The old random-neighbour jump was
    // immediately undone by the greedy re-pick, so it never helped.)
    this.stuckTimer += dt;
    if (this.stuckTimer > 2) {
      this.stuckTimer = 0;
      if (this.lastPos.distanceTo(this.pos) < 0.4) {
        this.path = [];
        this._pathGoal = null;
      }
      this.lastPos.copy(this.pos);
    }
  }
  canSee(targetPos, maxDist = 30) {
    const from = this.eye;
    const to = new THREE.Vector3(targetPos.x, targetPos.y + 1.2, targetPos.z);
    if (from.distanceTo(to) > maxDist) return false;
    return hasLOS(from, to, this.map.colliders, this._smokes);
  }
  blind(seconds) {
    this.blindT = seconds;
    this.reaction = 0; this.burstLeft = 0;
  }
  hearShot(pos) {
    if (this.pos.distanceTo(pos) < 25) {
      if (this.alert <= 0) { this._heardShot = true; this._heardSite = siteNameFor(pos, this.map); }
      this.alert = 4;
      this.alertPos = { x: pos.x, z: pos.z };
    }
  }
  // v3.8 fix: was `damage(amount)` — but the constructor sets the own
  // property `this.damage = 13|10` (per-hit damage vs the player), which
  // shadowed the prototype method, so every `bot.damage(x)` call threw
  // "damage is not a function" and no bot could ever be killed by a shot
  // or grenade (killfeed / _onPlayerKill / kill banners unreachable).
  // Renamed to takeDamage; the numeric `this.damage` property is untouched.
  takeDamage(amount) {
    if (!this.alive) return false;
    // v3.10 (Grok, confirmed): getting shot wiped the whole plant/defuse
    // channel to 0, so a bot could almost never finish under fire. A hit
    // now costs HALF the progress instead — the channel still punishes
    // interruption, but a 2.8/3.0 plant survives one bullet.
    this.channel = Math.max(0, this.channel * 0.5);
    this.hp -= amount;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; this.mesh.visible = false; }
    return !this.alive;
  }
  // One fixed step. ctx: {player, bots, bombPlanted, bombSite, time, dt,
  // damagePlayer, onBotShot, plantSiteClear, defuseSite}.
  update(dt, ctx) {
    if (!this.alive) return;
    const player = ctx.player;
    this._smokes = ctx.smokes || [];
    this.blindT = Math.max(0, this.blindT - dt);
    this.retargetTimer -= dt;
    this.alert = Math.max(0, this.alert - dt);
    // Fresh gunshot heard: one radio rotate call (throttled in sim).
    if (this._heardShot && this.alert > 0) {
      this._heardShot = false;
      ctx.onRadio(this, `Heard shots ${this._heardSite} — rotating.`);
    }
    // --- Perception ----------------------------------------------------------
    let enemy = null; // {pos, isPlayer, bot}
    // v3.8 fix: only BASTION bots treat the player as an enemy. The old
    // code had no team check, so the player's own SOLARA teammates opened
    // fire on them at round start (diagnosed 15 Nov: 100 -> 21 HP in the
    // first 0.5 s of the round, dead ~1 s in — all from point-blank
    // teammates at spawn). Solara bots skip the player and hunt Bastion.
    if (this.team === 'bastion' && player.alive && player.pos.distanceTo(this.pos) < 32 && this.canSee(player.pos)) {
      enemy = { pos: player.pos, isPlayer: true };
    } else {
      for (const b of ctx.bots) {
        if (b === this || !b.alive || b.team === this.team) continue;
        if (b.pos.distanceTo(this.pos) < 30 && this.canSee(b.pos)) { enemy = { pos: b.pos, bot: b }; break; }
      }
    }
    // v3.8 fix: the reaction timer was re-armed EVERY frame it expired
    // while the enemy stayed visible (this block runs before the combat
    // block in the same update), so a bot could never reach the fire
    // branch — bots aimed but never shot. Only (re-)arm + call out when
    // the enemy is NEWLY spotted; a continuously visible enemy lets the
    // timer run down and the bot fire its bursts.
    if (enemy && !this._hadEnemy) {
      this.reaction = 0.25 + this.rng() * 0.35;
      ctx.onRadio(this, `Contact ${siteNameFor(enemy.pos, this.map)} — ${enemy.isPlayer ? 'one hostile!' : 'enemy spotted!'}`);
    }
    this._hadEnemy = !!enemy;
    if (!enemy) this.reaction = Math.max(0, this.reaction - dt);
    // v3.10: remember where the enemy was last seen (hunt target) and how
    // long it has been quiet — the hunt trigger below keys off this.
    if (enemy) {
      this.lastSeen = { x: enemy.pos.x, z: enemy.pos.z, t: ctx.time };
      this.quietTimer = 0;
    } else {
      this.quietTimer += dt;
    }
    // v3.10: reload timer ticks whenever the bot is alive. Out of combat a
    // half-empty mag is topped up between fights; in combat the mag check
    // lives in the fire branch below.
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { this.reloading = 0; this.ammo = WEAPONS[this.weapon].mag; }
    } else if (!enemy && this.ammo < WEAPONS[this.weapon].mag * 0.5) {
      this.reloading = WEAPONS[this.weapon].reloadTime;
    }
    // --- Objective state ------------------------------------------------------
    const sitePos = this.site && ctx.map.sites[this.site] ? ctx.map.sites[this.site].center : null;
    if (ctx.bombPlanted) {
      const bs = ctx.map.sites[ctx.bombSite].center;
      if (this.team === 'bastion') {
        this.state = 'defuse';
        this.goal = { x: bs.x, z: bs.z };
      } else {
        this.state = 'hold';
        this.goal = { x: bs.x + (this.rng() - 0.5) * 4, z: bs.z + (this.rng() - 0.5) * 4 };
      }
    } else if (ctx.bombDropped) {
      // v3.10: a dropped bomb must be recovered (Solara) or guarded
      // (Bastion) — never ignored while the round is live.
      this.state = this.team === 'solara' ? 'recover' : 'guard';
      this.goal = { x: ctx.bombDropped.pos.x, z: ctx.bombDropped.pos.z };
    } else if (this.team === 'bastion') {
      this.state = sitePos ? 'hold' : 'patrol';
      // v3.10 HUNT: 10 s without contact — stop camping the site and sweep
      // the lanes / last-seen spot instead of standing still all round.
      if (this.quietTimer > 10 && (!this.goal || this.retargetTimer <= 0)) {
        this.goal = this._pickHuntGoal(ctx);
        this.state = 'hunt';
        this.retargetTimer = 12;
        this.quietTimer = 0;
      } else if (sitePos && (!this.goal || this.retargetTimer <= 0)) {
        this.goal = { x: sitePos.x + (this.rng() - 0.5) * 5, z: sitePos.z + (this.rng() - 0.5) * 5 };
        this.retargetTimer = 6;
      }
    } else {
      // Attackers push their site; carrier plants when the site is clear.
      if (this.isCarrier && sitePos && ctx.siteClear(this.site)) {
        this.state = 'plant';
        this.goal = { x: sitePos.x, z: sitePos.z };
      } else if (this.quietTimer > 10 && (!this.goal || this.retargetTimer <= 0)) {
        // v3.10 HUNT: 10 s without contact — push the enemy spawn / the
        // other site instead of shuffling around the same site goal.
        this.goal = this._pickHuntGoal(ctx);
        this.state = 'hunt';
        this.retargetTimer = 12;
        this.quietTimer = 0;
      } else if (sitePos && (!this.goal || this.retargetTimer <= 0)) {
        this.goal = { x: sitePos.x + (this.rng() - 0.5) * 4, z: sitePos.z + (this.rng() - 0.5) * 4 };
        this.retargetTimer = 8;
      } else {
        this.state = 'push';
      }
      if (this.alert > 0 && this.alertPos && !enemy) {
        this.goal = { x: this.alertPos.x, z: this.alertPos.z };
      }
    }
    if (this.hp < 25 && enemy) this.state = 'retreat';
    // --- Channel: plant / defuse ----------------------------------------------
    // v3.10 (Grok, confirmed): a bot that stops channelling used to lose
    // ALL progress instantly. Now the channel DECAYS at 1.0/s while
    // interrupted — a bot that ducks out for a second keeps most of it.
    if (this.state !== 'plant' && this.state !== 'defuse') {
      this.channel = Math.max(0, this.channel - dt * 1.0);
    }
    if (this.state === 'plant' && this.goal) {
      const d = Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z);
      if (d < 1.5 && !enemy) {
        if (this.channel === 0) ctx.onRadio(this, `Planting ${this.site}!`);
        this.channel += dt;
        if (this.channel >= 3) { this.channel = 0; ctx.onPlant(this); }
        // Stand still while planting.
        this._syncMesh(dt);
        return;
      }
      this.channel = Math.max(0, this.channel - dt * 1.0);
    }
    if (this.state === 'defuse' && ctx.bombPlanted) {
      const bs = ctx.map.sites[ctx.bombSite].center;
      const d = Math.hypot(bs.x - this.pos.x, bs.z - this.pos.z);
      if (d < 2.5 && !enemy) {
        if (this.channel === 0) ctx.onRadio(this, 'Defusing the bomb!');
        this.channel += dt;
        if (this.channel >= 5) { this.channel = 0; ctx.onDefuse(this); }
        this._syncMesh(dt);
        return;
      }
      this.channel = Math.max(0, this.channel - dt * 1.0);
    }
    // --- Movement ----------------------------------------------------------------
    if (this.state === 'retreat') {
      const spawn = this.team === 'solara' ? ctx.map.spawns.solara[0] : ctx.map.spawns.bastion[0];
      this.goal = { x: spawn.x, z: spawn.z };
    }
    if (this.goal && !enemy) this.stepTowardGoal(dt);
    else if (this.goal && enemy && this.state !== 'engage') {
      // Strafe slightly while engaging instead of walking into the open.
      this.yaw = Math.atan2(-(enemy.pos.x - this.pos.x), -(enemy.pos.z - this.pos.z)) + Math.PI;
    }
    // --- Combat (blinded bots cannot shoot) --------------------------------------
    // v3.8: bots only shoot during the round — during freeze/buy (and the
    // end-of-round pause) they stay silent by design. Without this gate the
    // stationary player is killed at spawn before the round even starts
    // (diagnosed 15 Nov: dead at simTime ~1.4 s, still in freeze).
    if (enemy && this.blindT <= 0 && ctx.phase === 'round') {
      this.state = 'engage';
      const to = enemy.pos;
      this.yaw = Math.atan2(-(to.x - this.pos.x), -(to.z - this.pos.z)) + Math.PI;
      // v3.10: empty mag -> reload (no fire while reloading). The reload
      // timer ticks at the top of update(); this branch just starts it.
      if (this.reloading > 0) {
        // reloading — hold fire
      } else if (this.ammo <= 0) {
        this.reloading = WEAPONS[this.weapon].reloadTime;
        ctx.onRadio(this, 'Reloading!');
      } else if (this.reaction > 0) { this.reaction -= dt; }
      else {
        this.fireTimer -= dt;
        if (this.fireTimer <= 0) {
          this.burstLeft = 3 + Math.floor(this.rng() * 3);
          this.fireTimer = 0.55 + this.rng() * 0.5;
        }
        if (this.burstLeft > 0 && this.ammo > 0) {
          this.burstLeft -= 1;
          this.ammo -= 1;
          this.fireTimer = Math.max(this.fireTimer, 0.11);
          const dist = this.pos.distanceTo(to);
          const hitP = Math.max(0.12, this.accuracy - dist * 0.012);
          const hit = this.rng() < hitP;
          ctx.onBotShot(this, enemy, hit, dist);
        }
      }
    }
    this._syncMesh(dt);
  }
  // v3.10 HUNT target picker. Priority: the last place an enemy was seen
  // (fresh, < 15 s) -> the heard gunshot -> attackers push the enemy spawn,
  // defenders sweep a lane waypoint near their position.
  _pickHuntGoal(ctx) {
    if (this.lastSeen && ctx.time - this.lastSeen.t < 15) {
      return { x: this.lastSeen.x, z: this.lastSeen.z };
    }
    if (this.alert > 0 && this.alertPos) return { x: this.alertPos.x, z: this.alertPos.z };
    if (this.team === 'solara') {
      const sp = ctx.map.spawns.bastion;
      const s = sp[Math.floor(this.rng() * sp.length)];
      return { x: s.x + (this.rng() - 0.5) * 4, z: s.z + (this.rng() - 0.5) * 4 };
    }
    const wps = ctx.map.waypoints;
    const near = wps.filter((w) => Math.hypot(w.x - this.pos.x, w.z - this.pos.z) < 14);
    const w = near.length ? near[Math.floor(this.rng() * near.length)] : wps[0];
    return { x: w.x, z: w.z };
  }
  _syncMesh(dt) {
    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.mesh.rotation.y = this.yaw;
    // Walk bob from a deterministic step counter (never performance.now()).
    this.bobPhase = (this.bobPhase || 0) + (this.goal !== null ? dt * 9 : 0);
    this.mesh.position.y = this.goal !== null ? Math.abs(Math.sin(this.bobPhase)) * 0.03 : 0;
  }
}
