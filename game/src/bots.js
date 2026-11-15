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

// v3.12 MUSCULAR ROBLOX SOLDIERS, target image (image-40.png) —
// crisp, detailed: red BERET + yellow badge, black BALACLAVA, white
// eyes with pupils, red tac-vest with BROWN chest pouches, belt with
// brown pouches, green cargo pants with BLACK knee pads + straps, black
// boots, bare tan muscular arms, olive shoulder pads. Bastion POLISI:
// same detail in blue — black helmet + blue visor, dark vest + POLICE
// badge, blue pants, blue-black rifle. Rifle red-black (Solara) /
// blue-black (Bastion), held diagonally forward, no clipping.
// Hitbox anchors UNCHANGED: head 0.30 box at y 1.66 (sim.js headshot
// sphere y+1.66 r 0.22), total height ~1.85, so collision/AI untouched.
// Facing: local -Z is front (eyes, pouches, buckle, muzzle all -Z).
// v3.11 BUGFIX (facing): bots faced EXACTLY backwards (facing-check
// 16 Nov: cosAngle -1.0 vs the engaged enemy) because the yaw formula
// added a spurious +Math.PI. Removed from all three assignments —
// that backwards rifle is what the user saw as "senjata tertukar".

// Shared materials, one set per team — 9 bots share them instead of
// allocating ~6 materials per bot.
const _teamMats = {};
function teamMats(team) {
  if (_teamMats[team]) return _teamMats[team];
  const std = (color, roughness = 0.85, metalness = 0.05) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const gun = std(0x3a4048, 0.45, 0.8);
  const gunLight = std(0x8d99a6, 0.35, 0.8);
  const skin = std(0xd9a77c, 0.8, 0); // v3.12: lighter tan skin (target image — bare muscular arms)
  const black = std(0x1c1e22, 0.9, 0);
  const pale = std(0xd8d2c4, 0.8, 0);
  const gold = std(0xd8a93c, 0.4, 0.7);
  const m = team === 'solara' ? {
    skin, black, pale, gun, gunLight, gold,
    pouch: std(0x6b4a2a, 0.9, 0), // v3.12: brown chest + belt pouches (target)
    suit: std(0x556b2f),          // green cargo pants
    suitDark: std(0x3d4d20),      // knee straps / cargo pockets
    vest: std(0xcf3a26, 0.75, 0.1),  // red tac vest
    vestDark: std(0x8f2a1c, 0.7, 0.15),
    team: std(TEAM_COLORS.solara, 0.6, 0.2), // vivid red accents
    mask: std(0xb02718, 0.85, 0),   // red face mask (reference Teroris)
    tan: std(0xc9b48a, 0.9, 0),   // keffiyeh wrap
    tanDark: std(0xa8905e, 0.9, 0),
    beret: std(0xc22e24, 0.85, 0),
  } : {
    skin, black, pale, gun, gunLight, gold,
    pouch: std(0x1d2f4d, 0.9, 0), // v3.12: dark-blue pouches (target, blue palette)
    suit: std(0x2f5fb8),          // police blue uniform
    suitDark: std(0x24457e),      // darker blue panels
    vest: std(0x232a33, 0.7, 0.2),// dark tac vest
    vestDark: std(0x161c22, 0.7, 0.2),
    team: std(TEAM_COLORS.bastion, 0.6, 0.2), // royal blue accents
    visor: std(0x7ec8f0, 0.25, 0.4), // light-blue visor
  };
  _teamMats[team] = m;
  return m;
}

function _box(w, h, d, mat, x, y, z, rx = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  if (rx) m.rotation.x = rx;
  if (rz) m.rotation.z = rz;
  m.castShadow = true;
  return m;
}

// v3.12 HEADGEAR — ONE canonical look per team, matching the user's
// target image (image-40.png: crisp, detailed soldier).
// Solara (ALL bots): red beret, tilted, with a yellow square badge;
// black balaclava head; white eye band with black pupils.
// Bastion (ALL bots): black helmet + light-blue visor, white slit eyes.
// The v3.11 per-name variety (keffiyeh, police caps, sunglasses) is gone —
// the user asked for THIS look on every bot. Head mesh stays the 0.30
// skin box at y 1.66; balaclava variants swap its material to black.
function _headgear(g, team, name, M) {
  const head = g.userData.head;
  const whiteEyes = () => {
    g.add(_box(0.26, 0.08, 0.02, M.pale, 0, 1.70, -0.16)); // white eye band
    g.add(_box(0.035, 0.05, 0.02, M.black, -0.065, 1.70, -0.17)); // pupils
    g.add(_box(0.035, 0.05, 0.02, M.black, 0.065, 1.70, -0.17));
  };
  const slit = () => g.add(_box(0.24, 0.045, 0.02, M.pale, 0, 1.69, -0.16));
  const beret = () => {
    g.add(_box(0.34, 0.07, 0.34, M.beret, 0, 1.82, 0, 0, 0.10)); // tilted beret
    g.add(_box(0.07, 0.07, 0.02, M.gold, -0.06, 1.83, -0.18)); // yellow badge
  };
  const helmet = () => {
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.black);
    h.position.y = 1.72;
    h.castShadow = true;
    g.add(h);
    g.add(_box(0.26, 0.08, 0.04, M.visor, 0, 1.70, -0.16)); // blue visor
  };
  if (team === 'solara') {
    head.material = M.black; // balaclava
    beret();
    whiteEyes();
  } else {
    head.material = M.black; // balaclava under the helmet
    helmet();
    slit();
  }
}

export function buildBotMesh(team, name) {
  const M = teamMats(team);
  const g = new THREE.Group();
  // --- Sturdy legs + big black boots ---
  g.add(_box(0.26, 0.14, 0.38, M.black, -0.16, 0.07, -0.03));
  g.add(_box(0.26, 0.14, 0.38, M.black, 0.16, 0.07, -0.03));
  g.add(_box(0.26, 0.78, 0.28, M.suit, -0.16, 0.53, 0));
  g.add(_box(0.26, 0.78, 0.28, M.suit, 0.16, 0.53, 0));
  // v3.12: BLACK knee pads + straps (target image).
  g.add(_box(0.28, 0.22, 0.06, M.black, -0.16, 0.55, -0.16)); // knee pads
  g.add(_box(0.28, 0.22, 0.06, M.black, 0.16, 0.55, -0.16));
  g.add(_box(0.28, 0.04, 0.30, M.black, -0.16, 0.68, 0)); // straps above pads
  g.add(_box(0.28, 0.04, 0.30, M.black, 0.16, 0.68, 0));
  if (team === 'solara') { // cargo side pockets
    g.add(_box(0.04, 0.16, 0.14, M.suitDark, -0.30, 0.45, -0.02));
    g.add(_box(0.04, 0.16, 0.14, M.suitDark, 0.30, 0.45, -0.02));
  }
  // --- Belt + team-colour buckle + belt pouches (target image) ---
  g.add(_box(0.74, 0.10, 0.40, M.black, 0, 0.97, 0));
  g.add(_box(0.12, 0.08, 0.03, M.team, 0, 0.97, -0.21));
  g.add(_box(0.12, 0.12, 0.06, M.pouch, -0.22, 0.90, -0.21)); // belt pouches
  g.add(_box(0.12, 0.12, 0.06, M.pouch, 0, 0.90, -0.21));
  g.add(_box(0.12, 0.12, 0.06, M.pouch, 0.22, 0.90, -0.21));
  // --- Broad chest: Solara red tac-vest; Bastion blue shirt + dark vest ---
  g.add(_box(0.74, 0.56, 0.38, team === 'solara' ? M.vest : M.suit, 0, 1.28, 0));
  if (team === 'solara') {
    g.add(_box(0.09, 0.44, 0.04, M.vestDark, -0.18, 1.30, -0.20)); // straps
    g.add(_box(0.09, 0.44, 0.04, M.vestDark, 0.18, 1.30, -0.20));
    // v3.12: BROWN chest pouches (target image), not dark-red.
    g.add(_box(0.14, 0.16, 0.08, M.pouch, -0.20, 1.14, -0.21)); // pouches
    g.add(_box(0.14, 0.16, 0.08, M.pouch, 0, 1.14, -0.21));
    g.add(_box(0.14, 0.16, 0.08, M.pouch, 0.20, 1.14, -0.21));
  } else {
    g.add(_box(0.76, 0.48, 0.06, M.vest, 0, 1.30, -0.20)); // vest plate
    g.add(_box(0.13, 0.15, 0.02, M.gold, -0.22, 1.42, -0.26)); // POLICE badge
    g.add(_box(0.14, 0.16, 0.04, M.team, 0.20, 1.38, -0.24)); // blue pouch
    g.add(_box(0.14, 0.16, 0.04, M.team, 0.20, 1.16, -0.24));
  }
  // --- Neck + VERY wide shoulders (v3.12: shoulder pads in suit colour,
  // olive green for Solara / police blue for Bastion, like the target) ---
  g.add(_box(0.18, 0.10, 0.18, M.skin, 0, 1.56, 0));
  g.add(_box(0.22, 0.10, 0.42, M.suit, -0.44, 1.56, 0)); // shoulder pads
  g.add(_box(0.22, 0.10, 0.42, M.suit, 0.44, 1.56, 0));
  // --- HUGE muscular arms, reaching forward to the rifle ---
  // Solara: bare skin arms (reference); Bastion: blue sleeves.
  const armMat = team === 'solara' ? M.skin : M.suit;
  // Upper arms: angled out-down from the wide shoulders.
  g.add(_box(0.26, 0.38, 0.26, armMat, -0.42, 1.38, -0.05, 0.25, 0.12));
  g.add(_box(0.26, 0.38, 0.26, armMat, 0.42, 1.38, -0.05, 0.25, -0.12));
  // Bicep bulges — the "berotot" read.
  g.add(_box(0.30, 0.22, 0.30, armMat, -0.45, 1.40, -0.06));
  g.add(_box(0.30, 0.22, 0.30, armMat, 0.45, 1.40, -0.06));
  // Forearms: long, reaching forward-in to the rifle grips.
  g.add(_box(0.24, 0.52, 0.24, armMat, -0.26, 1.24, -0.40, 0.95, 0.45));
  g.add(_box(0.24, 0.48, 0.24, armMat, 0.34, 1.24, -0.26, 0.95, -0.35));
  // Black gloves ON the rifle grips (front grip left, rear grip right).
  g.add(_box(0.17, 0.15, 0.17, M.black, -0.02, 1.32, -0.60));
  g.add(_box(0.17, 0.15, 0.17, M.black, 0.18, 1.32, -0.48));
  // Head (hitbox anchor — keep 0.30 at y 1.66) + per-name headgear.
  const head = _box(0.30, 0.30, 0.30, M.skin, 0, 1.66, 0);
  g.add(head);
  g.userData.head = head;
  _headgear(g, team, name, M);
  // --- Rifle (fallback proc): held DIAGONALLY across the chest, stock at
  // the right shoulder, muzzle forward-left. Group origin is the receiver
  // centre; at (0.12, 1.35, -0.52) + yaw 0.55 the stock rear clears the
  // chest front (x 0.39 > torso half-width 0.37) and the muzzle lands at
  // ~(-0.11, 1.37, -0.97) — nothing passes through the torso. The old
  // centred pose (z -0.15, yaw 0) ran the receiver straight THROUGH the
  // chest and the stock out the back — that was the clipping the user saw.
  // Team read: BIG band + team-coloured magazine.
  // v3.12: team-coloured rifle (target image) — red receiver + red mag
  // for Solara, blue receiver + blue mag for Bastion, black barrel.
  const rifle = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.55), M.team);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.5), M.gunLight);
  barrel.position.set(0, 0.02, -0.5);
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.1), M.gunLight);
  muzzle.position.set(0, 0.02, -0.78);
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.12, 0.32), M.gun);
  handguard.position.set(0, 0, -0.3);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.24, 0.13), M.team);
  mag.position.set(0, -0.17, 0.05);
  mag.rotation.x = 0.25;
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.28), M.gun);
  stock.position.set(0, 0, 0.38);
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.26), M.team);
  band.position.set(0, 0.10, -0.18); // v3.11: collar proud of the rail on all sides
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.12), M.gunLight);
  sight.position.set(0, 0.19, -0.05);
  for (const m of [receiver, barrel, muzzle, handguard, mag, stock, band, sight]) {
    m.castShadow = true;
    rifle.add(m);
  }
  rifle.name = 'proc-rifle'; // v3.10: swapped for the real SCAR-L GLB when it loads
  rifle.position.set(0.12, 1.38, -0.58);
  rifle.rotation.y = 0.50;
  rifle.rotation.x = -0.08;
  g.add(rifle);
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
    this.mesh = buildBotMesh(team, name); // v3.11: per-name voxel headgear
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
    // v3.11: team markers that sit OUTSIDE the GLB body. A top band does
    // NOT work here — the SCAR-L handguard box swallows it whole (proven
    // by the viewmodel close-up: the band existed in the scene graph but
    // rendered invisible). Side plates on the receiver + a mag sleeve
    // around the magazine are proud of the GLB on every side.
    const teamMat = new THREE.MeshStandardMaterial({ color: TEAM_COLORS[this.team], roughness: 0.5, metalness: 0.3 });
    for (const sx of [-1, 1]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.30), teamMat);
      plate.position.set(sx * 0.045, 0.02, -0.10); // v3.11: GLB is only +/-0.028 wide — plates hug the receiver
      plate.name = 'team-plate';
      rifle.add(plate);
    }
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.18, 0.18), teamMat);
    sleeve.position.set(0, -0.13, 0.06);
    sleeve.name = 'team-sleeve';
    rifle.add(sleeve);
    rifle.position.set(0.12, 1.38, -0.58); // v3.11: diagonal-forward, matches proc-rifle
    rifle.rotation.y = 0.50;
    rifle.rotation.x = -0.08;
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
      this.yaw = Math.atan2(-dx, -dz); // v3.11: no +PI — that faced bots exactly backwards (facing-check cos -1.0)
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
      this.yaw = Math.atan2(-(enemy.pos.x - this.pos.x), -(enemy.pos.z - this.pos.z)); // v3.11: no +PI
    }
    // --- Combat (blinded bots cannot shoot) --------------------------------------
    // v3.8: bots only shoot during the round — during freeze/buy (and the
    // end-of-round pause) they stay silent by design. Without this gate the
    // stationary player is killed at spawn before the round even starts
    // (diagnosed 15 Nov: dead at simTime ~1.4 s, still in freeze).
    if (enemy && this.blindT <= 0 && ctx.phase === 'round') {
      this.state = 'engage';
      const to = enemy.pos;
      this.yaw = Math.atan2(-(to.x - this.pos.x), -(to.z - this.pos.z)); // v3.11: no +PI
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
    // v3.12: RELOAD POSE — while the bot reloads (2.2 s) the rifle dips
    // down and comes back up. Smoothed so it never snaps; restores the
    // exact base pose (rotation.x -0.08, y 1.38) when done.
    this._reloadPose = this._reloadPose || 0;
    const rpTarget = this.reloading > 0 ? 1 : 0;
    this._reloadPose += (rpTarget - this._reloadPose) * Math.min(1, dt * 6);
    if (this._reloadPose > 0.01) {
      if (!this._rifleMesh || !this._rifleMesh.parent) {
        this._rifleMesh = this.mesh.getObjectByName('real-rifle') || this.mesh.getObjectByName('proc-rifle');
      }
      if (this._rifleMesh) {
        this._rifleMesh.rotation.x = -0.08 - this._reloadPose * 0.5;
        this._rifleMesh.position.y = 1.38 - this._reloadPose * 0.10;
      }
    } else if (this._rifleMesh) {
      this._rifleMesh.rotation.x = -0.08;
      this._rifleMesh.position.y = 1.38;
    }
  }
}
