// player.js — the local player: movement, shooting, viewmodel, grenades.
// Movement has acceleration, crouch and sprint (sprint hurts accuracy);
// shooting is a ray from the camera with spread + recoil, tested against
// bot hitboxes (head x4 / torso x1 / legs x0.75) and map AABBs. All collision
// is axis-separated AABB resolution against the map's collider list.
import * as THREE from 'three';
import { Weapon, WEAPONS, buildViewmodel } from './weapons.js';

export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.15;
const RADIUS = 0.38;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 7.0;
const CROUCH_SPEED = 2.6;
const ACCEL = 42;

// Ray vs sphere: returns t or Infinity.
export function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}
// Ray vs AABB (y from 0..h): returns t or Infinity.
export function rayAABB(o, d, c) {
  let tmin = 0, tmax = Infinity;
  const axes = [
    [o.x, d.x, c.minX, c.maxX], [o.y, d.y, 0, c.h], [o.z, d.z, c.minZ, c.maxZ],
  ];
  for (const [oo, dd, mn, mx] of axes) {
    if (Math.abs(dd) < 1e-9) { if (oo < mn || oo > mx) return Infinity; }
    else {
      let t1 = (mn - oo) / dd, t2 = (mx - oo) / dd;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}
// Point vs AABB test (XZ + height).
export function pointInCollider(x, z, y, c) {
  return x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && y < c.h;
}

export class Player {
  constructor(scene, camera, map, audio, fx) {
    this.scene = scene; this.camera = camera; this.map = map;
    this.audio = audio; this.fx = fx;
    this.pos = new THREE.Vector3(-20, 0, 0);
    this.vel = new THREE.Vector3();
    this.yaw = -Math.PI / 2; // facing +X (east, toward the sites)
    this.pitch = 0;
    this.hp = 100; this.armor = 0; this.alive = true;
    this.money = 800;
    this.slots = [new Weapon(WEAPONS.p9)];
    this.slot = 0;
    this.grenades = { he: 0, smoke: 0, flash: 0 };
    this.grenadeType = 'he'; // cycled with key 4; G throws the selected type
    this.hasKit = false; // defuse kit: defuse 2.5 s instead of 5 s
    this.hasBomb = false;
    this.recoil = 0; this.recoilPitch = 0;
    this.bobPhase = 0; this.stepTimer = 0;
    this.flashT = 0; this.smokeT = 0;
    this.grenade = null; // active thrown grenade {pos, vel, fuse}
    this.cameraShake = 0;
    this.viewmodel = null; this.muzzle = null;
    this.equip(0);
  }
  get weapon() { return this.slots[this.slot]; }
  get eyeY() { return this.pos.y + (this.crouching ? EYE_CROUCH : EYE_STAND); }

  equip(index) {
    if (index < 0 || index >= this.slots.length) return;
    this.slot = index;
    if (this.viewmodel) this.camera.remove(this.viewmodel);
    const { group, muzzle } = buildViewmodel(this.slots[index].def.id);
    this.viewmodel = group;
    this.muzzle = muzzle;
    // CoD-style viewmodel pose: bigger, closer, barrel angled toward the
    // frame centre. Scale/pose per weapon kind; stock rear must stay in
    // front of the camera near plane (z < -0.1) or it clips.
    const pose = {
      p9: { s: 1.3, x: 0.27, y: -0.25, z: -0.50, ry: 0.06 },
      vex9: { s: 1.4, x: 0.29, y: -0.26, z: -0.55, ry: 0.10 },
      ar77: { s: 1.4, x: 0.30, y: -0.27, z: -0.55, ry: 0.12 },
      longbow: { s: 1.4, x: 0.30, y: -0.27, z: -0.55, ry: 0.10 },
      he: { s: 1.3, x: 0.26, y: -0.25, z: -0.48, ry: 0.05 },
    }[this.slots[index].def.id] || { s: 1.3, x: 0.26, y: -0.24, z: -0.45, ry: 0 };
    this.vmBase = pose;
    group.scale.setScalar(pose.s);
    group.rotation.y = pose.ry;
    group.position.set(pose.x, pose.y, pose.z);
    this.camera.add(group);
  }
  buy(id) {
    const def = WEAPONS[id];
    if (!def) {
      // Non-weapon gear (not in the WEAPONS table).
      if (id === 'vest') {
        if (this.money < 400 || this.armor >= 50) return false;
        this.money -= 400; this.armor = 50;
        return true;
      }
      if (id === 'armor') {
        if (this.money < 650 || this.armor >= 100) return false;
        this.money -= 650; this.armor = 100;
        return true;
      }
      if (id === 'kit') {
        if (this.money < 400 || this.hasKit) return false;
        this.money -= 400; this.hasKit = true;
        return true;
      }
      return false;
    }
    if (def.kind === 'grenade') {
      if (this.money < def.price || this.grenades[id] >= 2) return false;
      this.money -= def.price; this.grenades[id]++;
      return true;
    }
    if (this.money < def.price) return false;
    const existing = this.slots.findIndex((w) => w.def.id === id);
    if (existing >= 0) {
      const w = this.slots[existing];
      w.reserve = Math.min(w.reserve + w.def.reserve, w.def.reserve * 2);
    } else {
      if (this.slots.length >= 3) this.slots.splice(1, 1); // keep pistol + 2
      this.slots.push(new Weapon(def));
    }
    this.money -= def.price;
    return true;
  }

  // One fixed step of movement + look. `input` is the Input object.
  update(dt, input, t) {
    if (!this.alive) return;
    this.crouching = input.crouch;
    const { dx, dy } = input.takeMouse();
    this.yaw -= dx * 0.0021;
    this.pitch -= dy * 0.0021;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    const ads = input.ads && this.weapon.def.kind !== 'grenade';
    const speed = this.crouching ? CROUCH_SPEED : (input.sprint && !ads ? SPRINT_SPEED : WALK_SPEED) * (ads ? 0.65 : 1);
    const mv = input.move;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Forward is (-sin, 0, -cos) for yaw around Y.
    const fx = -sin, fz = -cos, rx = -fz, rz = fx;
    let tx = fx * mv.f + rx * mv.s, tz = fz * mv.f + rz * mv.s;
    const len = Math.hypot(tx, tz);
    if (len > 0) { tx /= len; tz /= len; }
    this.vel.x += (tx * speed - this.vel.x) * Math.min(1, ACCEL * dt / speed * 6);
    this.vel.z += (tz * speed - this.vel.z) * Math.min(1, ACCEL * dt / speed * 6);
    this._moveAxis(dt, 'x');
    this._moveAxis(dt, 'z');
    // Clamp to map bounds.
    this.pos.x = Math.max(this.map.bounds.minX + 0.5, Math.min(this.map.bounds.maxX - 0.5, this.pos.x));
    this.pos.z = Math.max(this.map.bounds.minZ + 0.5, Math.min(this.map.bounds.maxZ - 0.5, this.pos.z));
    // Recoil recovery + view bob + footsteps.
    this.recoilPitch = Math.max(0, this.recoilPitch - dt * 0.06);
    const moving = Math.hypot(this.vel.x, this.vel.z);
    if (moving > 0.5) {
      this.bobPhase += dt * moving * 1.6;
      this.stepTimer -= dt * moving;
      if (this.stepTimer <= 0) { this.stepTimer = 2.1; this.audio.step(); }
    }
    this.weapon.update(dt);
    // Grenade physics. Flash pops mid-air on fuse; HE/smoke detonate on
    // ground contact or when the fuse runs out.
    if (this.grenade) {
      const g = this.grenade;
      g.fuse -= dt;
      g.vel.y -= 9.8 * dt;
      g.pos.addScaledVector(g.vel, dt);
      if (g.type === 'flash' ? g.fuse <= 0 : (g.pos.y <= 0.05 || g.fuse <= 0)) this._detonateGrenade(g);
    }
  }
  _moveAxis(dt, axis) {
    const d = axis === 'x' ? this.vel.x * dt : this.vel.z * dt;
    if (d === 0) return;
    const next = this.pos[axis] + d;
    const y = this.pos.y;
    for (const c of this.map.colliders) {
      if (y >= c.h) continue;
      const ox = axis === 'x' ? next : this.pos.x;
      const oz = axis === 'z' ? next : this.pos.z;
      if (ox + RADIUS > c.minX && ox - RADIUS < c.maxX && oz + RADIUS > c.minZ && oz - RADIUS < c.maxZ) {
        if (axis === 'x') this.vel.x = 0; else this.vel.z = 0;
        return;
      }
    }
    this.pos[axis] = next;
  }

  // Camera transform after the sim step (render-time, includes bob/shake/ADS).
  applyCamera(t) {
    const moving = Math.hypot(this.vel.x, this.vel.z);
    const bob = Math.min(1, moving / WALK_SPEED) * 0.028;
    const bobY = Math.sin(this.bobPhase * 2) * bob;
    const bobX = Math.cos(this.bobPhase) * bob * 0.6;
    const shake = this.cameraShake > 0 ? this.cameraShake : 0;
    this.cameraShake = Math.max(0, this.cameraShake - 0.03);
    this.camera.position.set(
      this.pos.x + bobX * Math.cos(this.yaw),
      this.eyeY + bobY,
      this.pos.z - bobX * Math.sin(this.yaw),
    );
    const ads = this.adsHeld ? 1 : 0;
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(
      this.pitch + this.recoilPitch + (shake > 0 ? (Math.sin(t * 71) * 0.012 * shake) : 0),
      this.yaw + (shake > 0 ? (Math.cos(t * 63) * 0.012 * shake) : 0),
      0,
    );
    const targetFov = this.adsHeld ? 58 : 74;
    if (Math.abs(this.camera.fov - targetFov) > 0.2) {
      this.camera.fov += (targetFov - this.camera.fov) * 0.25;
      this.camera.updateProjectionMatrix();
    }
    // Viewmodel: ADS pulls it to centre, firing kicks it back, bob sways it.
    if (this.viewmodel) {
      const kick = this.flashT > 0 ? 0.06 : 0;
      const vm = this.vmBase || { x: 0.26, y: -0.24, z: -0.45 };
      this.viewmodel.position.set(
        vm.x * (1 - ads) + bobX * 0.4,
        vm.y + bobY * 0.5 + (ads ? 0.055 : 0),
        vm.z + kick,
      );
      this.viewmodel.rotation.x = this.recoilPitch * 1.4 + Math.sin(this.bobPhase) * 0.008;
      // ADS straightens the rifle so the sight sits dead centre.
      this.viewmodel.rotation.y = (this.vmBase ? this.vmBase.ry : 0) * (1 - ads);
    }
    this.flashT = Math.max(0, this.flashT - 0.05);
  }

  // Fire the current weapon. Returns a shot event for sim.js to resolve.
  tryFire(t, rng) {
    const w = this.weapon;
    if (!w.fire(t)) { if (w.ammo === 0 && w.reloading <= 0) this.audio.dryFire(); return null; }
    const spreadBase = w.def.spread + (this.crouching ? -0.002 : 0)
      + Math.hypot(this.vel.x, this.vel.z) * 0.0012
      + (this.adsHeld ? w.def.spread * (w.def.adsSpreadMult - 1) : 0);
    const spread = Math.max(0.001, spreadBase + this.recoil * 0.004);
    this.recoil = Math.min(0.05, this.recoil + w.def.recoil * 0.5);
    this.recoilPitch += w.def.recoil * 0.55;
    this.flashT = 0.05;
    this.audio.shot(w.def.kind);
    // Muzzle world position for the flash + smoke.
    const mw = new THREE.Vector3();
    this.muzzle.getWorldPosition(mw);
    this.fx.flash.fire(mw);
    this.fx.particles.smoke(mw, 1, 0.15, 0.4, 1.2);
    return { origin: this.camera.position.clone(), dir: this._aimDir(spread, rng), weapon: w, muzzlePos: mw };
  }
  _aimDir(spread, rng) {
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    dir.x += (rng() - 0.5) * spread * 2;
    dir.y += (rng() - 0.5) * spread * 2;
    dir.z += (rng() - 0.5) * spread * 2;
    return dir.normalize();
  }
  cycleGrenade() {
    const order = ['he', 'smoke', 'flash'];
    const i = order.indexOf(this.grenadeType);
    this.grenadeType = order[(i + 1) % order.length];
  }
  throwGrenade(t) {
    const type = this.grenadeType;
    if (this.grenades[type] <= 0 || this.grenade) return false;
    this.grenades[type]--;
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    this.grenade = {
      type,
      pos: this.camera.position.clone().addScaledVector(dir, 0.6),
      vel: dir.multiplyScalar(13).add(new THREE.Vector3(0, 4.5, 0)),
      fuse: WEAPONS[type].fuse,
    };
    return true;
  }
  _detonateGrenade(g) {
    const p = g.pos.clone();
    this.grenade = null;
    if (g.type === 'smoke') {
      // Smoke cloud: sim.js picks up lastSmoke and blocks bot LOS for 9 s.
      p.y = Math.max(0.4, p.y);
      this.lastSmoke = { pos: p, radius: WEAPONS.smoke.radius, duration: WEAPONS.smoke.duration };
      this.fx.particles.smoke(p, 24, 2.5, 1.2, 3);
      this.audio.beep();
    } else if (g.type === 'flash') {
      // Flashbang: sim.js picks up lastFlash; blinds bots + flashes the player.
      this.lastFlash = { pos: p, radius: WEAPONS.flash.radius, blindTime: WEAPONS.flash.blindTime };
      this.fx.flash.fire(p);
      this.audio.beep(true);
    } else {
      this.fx.explosion.trigger(p);
      this.audio.explosion();
      this.cameraShake = 1;
      this.lastGrenadeBlast = { pos: p, radius: WEAPONS.he.radius, damage: WEAPONS.he.damage };
    }
  }
  damage(amount, hitPart) {
    if (!this.alive) return false;
    let rest = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, rest * 0.5);
      this.armor -= absorbed;
      rest -= absorbed;
    }
    this.hp -= rest;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
    return !this.alive;
  }
}
