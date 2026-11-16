// player.js — the local player: movement, shooting, viewmodel, grenades.
// Movement has acceleration, crouch and sprint (sprint hurts accuracy);
// shooting is a ray from the camera with spread + recoil, tested against
// bot hitboxes (head x4 / torso x1 / legs x0.75) and map AABBs. All collision
// is axis-separated AABB resolution against the map's collider list.
import * as THREE from 'three';
import { Weapon, WEAPONS, buildViewmodel } from './weapons.js';
import { settings } from './settings.js';

export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.15;
const RADIUS = 0.38;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 7.0;
const CROUCH_SPEED = 2.6;
const ACCEL = 42;
// v3.10: jump — Space gives an upward impulse; gravity pulls back to y=0.
// Apex ~1.1 m, airtime ~0.85 s: enough to hop low cover, not to fly.
const JUMP_SPEED = 5.2;
const GRAVITY = 12;

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
    // v3.16 Phase 1: lean (-1 left .. +1 right, smoothed), weapon sway
    // from mouse movement, sprint pose blend, landing dip, smoothed eye Y.
    this.lean = 0; this.swayX = 0; this.swayY = 0;
    this._sprintPose = 0; this._landDip = 0; this._smoothEyeY = null;
    this.flashT = 0; this.smokeT = 0;
    this.grenade = null; // active thrown grenade {pos, vel, fuse}
    this.cameraShake = 0;
    this.diedAt = null; // v3.14 (item 2): sim time of the killing blow (death cam)
    this.vy = 0; // v3.10: vertical velocity (jump); pos.y is the feet
    this.grounded = true;
    this.viewmodel = null; this.muzzle = null;
    this._glbRifle = null; // v3.7: CC0 SCAR-L viewmodel, set async once loaded
    // v3.13: grenade throw animation — {t, dur, type, spawned} while a
    // throw is in flight; _savedVm holds the weapon viewmodel underneath.
    this.throwAnim = null;
    this._savedVm = null; // {group, muzzle, vmBase, reloadMag}
    this._grenadeGroup = null;
    this.equip(0);
  }
  // v3.7: swap the AR-77 viewmodel to the CC0 GLB rifle once it loads.
  // If the player is holding the AR-77, re-equip so the swap shows at once;
  // other weapons keep their primitive viewmodels.
  setGlbRifle(normalized) {
    this._glbRifle = normalized;
    if (this.slots[this.slot].def.id === 'ar77') this.equip(this.slot);
  }
  get weapon() { return this.slots[this.slot]; }
  get eyeY() { return this.pos.y + (this.crouching ? EYE_CROUCH : EYE_STAND); }

  equip(index) {
    if (index < 0 || index >= this.slots.length) return;
    this.slot = index;
    if (this.viewmodel) this.camera.remove(this.viewmodel);
    // v3.7: the AR-77 uses the CC0 SCAR-L GLB once loaded (cloned per
    // equip; geometries/materials are shared). Other weapons and the
    // pre-load AR-77 keep the primitive viewmodel.
    let group, muzzle;
    if (this.slots[index].def.id === 'ar77' && this._glbRifle) {
      group = this._glbRifle.group.clone();
      muzzle = group.getObjectByName('muzzle');
      // v3.11: the player's own rifle is Solara red — a red band on the
      // viewmodel so "my weapon" is unmistakable vs the enemy's blue.
      // (Bots carry the same band in their team colour; the old viewmodel
      // had no team colour at all, so all rifles looked identical.)
      // v3.11: same team markers as the bot rifles (see bots.js) — a top
      // band is swallowed by the GLB handguard, so the red reads via the
      // receiver side plates + the mag sleeve instead.
      const teamMat = new THREE.MeshStandardMaterial({ color: 0xe0352b, roughness: 0.5, metalness: 0.3 });
      for (const sx of [-1, 1]) {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.30), teamMat);
        plate.position.set(sx * 0.045, 0.02, -0.10); // v3.11: GLB is only +/-0.028 wide — plates hug the receiver
        group.add(plate);
      }
      const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.18, 0.18), teamMat);
      sleeve.position.set(0, -0.13, 0.06);
      group.add(sleeve);
    } else {
      ({ group, muzzle } = buildViewmodel(this.slots[index].def.id));
    }
    this.viewmodel = group;
    this.muzzle = muzzle;
    // v3.12: reload-mag prop — a spare magazine that drops out mid-reload
    // and rises back in as the fresh mag. Driven in applyCamera(); hidden
    // outside a reload. Sits in the mag well (local y -0.13, z 0.06).
    // v3.13: bigger + team-red so the mag swap actually reads against the
    // gunmetal (the old dark 0.07 mag vanished inside the GLB rifle).
    const rmag = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.20, 0.12),
      new THREE.MeshStandardMaterial({ color: 0xc22e24, roughness: 0.5, metalness: 0.4 }),
    );
    rmag.name = 'reload-mag';
    rmag.visible = false;
    group.add(rmag);
    this._reloadMag = rmag;
    // CoD-style viewmodel pose: bigger, closer, barrel angled toward the
    // frame centre. Scale/pose per weapon kind; stock rear must stay in
    // front of the camera near plane (z < -0.1) or it clips.
    // v3.13 (item 2): per-weapon RELOAD profile — dip (m), tilt (rad) and
    // the mag-well position the spare-mag prop travels to/from. The v3.12
    // animation existed for every weapon in code, but the mag prop sat
    // INSIDE the AR-77 GLB's own magazine (and off the well on Vex-9 /
    // Longbow), so the only visible part — the mag swap — vanished and
    // players read it as "no reload animation except the pistol". Each
    // weapon now has its own well position, a bigger dip/tilt, and the mag
    // drops OUT to the side (silhouetted, not buried in the receiver).
    const pose = {
      p9: { s: 1.3, x: 0.27, y: -0.25, z: -0.50, ry: 0.06, dip: 0.12, tilt: 0.55, mag: { x: 0, y: -0.10, z: 0.05 } },
      vex9: { s: 1.4, x: 0.29, y: -0.26, z: -0.55, ry: 0.10, dip: 0.14, tilt: 0.60, mag: { x: 0, y: -0.12, z: -0.10 } },
      ar77: { s: 1.4, x: 0.30, y: -0.27, z: -0.55, ry: 0.12, dip: 0.16, tilt: 0.65, mag: { x: 0, y: -0.13, z: 0.06 } },
      longbow: { s: 1.2, x: 0.30, y: -0.27, z: -0.62, ry: 0.10, adsLift: 0.15, dip: 0.18, tilt: 0.70, mag: { x: 0, y: -0.11, z: -0.04 } }, // v3.7 fix: stock rear was at z=-0.02 (inside the 0.1 near plane) so the stock clipped into a giant slab; s 1.2 / z -0.62 puts the rear at -0.164. adsLift aligns the scope (local y 0.055 x 1.2 = 0.066) with the crosshair in ADS — without it the scope sat ~0.15 below the sight line and the stock bulk filled the lower screen.
      he: { s: 1.3, x: 0.26, y: -0.25, z: -0.48, ry: 0.05, dip: 0, tilt: 0, mag: { x: 0, y: 0, z: 0 } },
    }[this.slots[index].def.id] || { s: 1.3, x: 0.26, y: -0.24, z: -0.45, ry: 0, dip: 0.12, tilt: 0.55, mag: { x: 0, y: -0.13, z: 0.06 } };
    this.vmBase = pose;
    this._reloadDip = pose.dip;
    this._reloadTilt = pose.tilt;
    this._magBase = pose.mag;
    group.scale.setScalar(pose.s);
    group.rotation.y = pose.ry;
    group.position.set(pose.x, pose.y, pose.z);
    this.camera.add(group);
  }
  buy(id) {
    // NOTE (v3.10): no phase check here on purpose. Buying is gated at the
    // UI level — the menu only opens during freeze (main.js) and auto-closes
    // when the round starts. A guard inside buy() broke the project's own
    // verify, which buys smoke/kit directly mid-round as a test shortcut.
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
    if (!this.alive) {
      // v3.13: dying mid-throw must not leave the grenade viewmodel stuck.
      if (this.throwAnim) { this._restoreWeaponVm(); this.throwAnim = null; }
      return;
    }
    // v3.13: grenade throw animation — the grenade leaves the hand at
    // t = 0.15 s (the release point of the swing); the weapon viewmodel
    // comes back when the 0.45 s animation ends.
    if (this.throwAnim) {
      const ta = this.throwAnim;
      ta.t += dt;
      if (!ta.spawned && ta.t >= 0.15) { ta.spawned = true; this._spawnGrenade(ta.type); }
      if (ta.t >= ta.dur) { this._restoreWeaponVm(); this.throwAnim = null; }
    }
    this.crouching = input.crouch;
    const { dx, dy } = input.takeMouse();
    // v3.16 Phase 1: weapon sway — the viewmodel lags the mouse a touch
    // (accumulates here, decays at the end of update()).
    this.swayX = Math.max(-0.035, Math.min(0.035, this.swayX - dx * 0.00012));
    this.swayY = Math.max(-0.035, Math.min(0.035, this.swayY + dy * 0.00012));
    // v3.10: mouse look honours the settings panel (sensitivity + invert-Y).
    const sens = settings.sensitivity * 0.0021;
    this.yaw -= dx * sens;
    this.pitch += (settings.invertY ? 1 : -1) * dy * sens;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    // v3.10: jump (Space) — only from the ground; gravity + landing.
    if (input.jump && this.grounded) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
    }
    if (!this.grounded) {
      this.vy -= GRAVITY * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= 0) {
        // v3.16 Phase 1: landing dip — the camera drops briefly on a hard
        // landing (vy is still the impact speed here, before it is zeroed).
        if (this.vy < -3) this._landDip = Math.min(0.12, -this.vy * 0.012);
        this.pos.y = 0; this.vy = 0; this.grounded = true;
      }
    }
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
    // v3.16 Phase 1: lean (smoothed toward the Q/E input), sprint-pose
    // blend (only while actually moving fast), weapon-sway decay.
    const leanTarget = this.alive ? input.lean : 0;
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * 10);
    const sprinting = this.alive && input.sprint && !ads && Math.hypot(this.vel.x, this.vel.z) > 1;
    this._sprintPose += ((sprinting ? 1 : 0) - this._sprintPose) * Math.min(1, dt * 8);
    this.swayX *= Math.max(0, 1 - dt * 5);
    this.swayY *= Math.max(0, 1 - dt * 5);
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
  applyCamera(t, dt = 1 / 60) {
    const moving = Math.hypot(this.vel.x, this.vel.z);
    const bob = Math.min(1, moving / WALK_SPEED) * 0.028;
    const bobY = Math.sin(this.bobPhase * 2) * bob;
    const bobX = Math.cos(this.bobPhase) * bob * 0.6;
    const shake = this.cameraShake > 0 ? this.cameraShake : 0;
    this.cameraShake = Math.max(0, this.cameraShake - 0.03);
    // v3.14 (item 2): DEATH CAM — when killed, the camera drops to the
    // ground and rolls sideways over ~0.9 s instead of freezing at eye
    // height behind the "YOU ARE DEAD" box. diedAt is set by sim.js at
    // the killing blow; without it the drop is instant (old saves/probes).
    let deathEase = 0;
    if (!this.alive) {
      const since = this.diedAt != null ? t - this.diedAt : 99;
      deathEase = Math.min(1, Math.max(0, since / 0.9));
      deathEase = deathEase * deathEase * (3 - 2 * deathEase); // smoothstep
    }
    // v3.16 Phase 1: smooth eye height (softens crouch/landing steps),
    // landing dip, lean roll + lateral peek offset (right vector is
    // (cos yaw, 0, -sin yaw) — the same pattern the bob already uses).
    // Render dt is capped at 1/30 for the smoothing factors: the raw frame
    // dt reaches 0.25 under SwiftShader, which would make (1 - dt*6)
    // negative and zero the landing dip in a single frame.
    const rdt = Math.min(dt, 1 / 30);
    const eyeTarget = (this.eyeY + bobY) * (1 - deathEase) + 0.45 * deathEase;
    if (this._smoothEyeY == null) this._smoothEyeY = eyeTarget;
    this._smoothEyeY += (eyeTarget - this._smoothEyeY) * Math.min(1, rdt * 14);
    this._landDip *= Math.max(0, 1 - rdt * 6);
    const leanRoll = this.lean * (this.adsHeld ? 0.12 : 0.22);
    const leanSide = this.lean * 0.35 * (1 - deathEase);
    this.camera.position.set(
      this.pos.x + bobX * Math.cos(this.yaw) * (1 - deathEase) + Math.cos(this.yaw) * leanSide,
      this._smoothEyeY - this._landDip,
      this.pos.z - bobX * Math.sin(this.yaw) * (1 - deathEase) - Math.sin(this.yaw) * leanSide,
    );
    const ads = this.adsHeld ? 1 : 0;
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(
      this.pitch - 0.25 * deathEase + this.recoilPitch + (shake > 0 ? (Math.sin(t * 71) * 0.012 * shake) : 0),
      this.yaw + (shake > 0 ? (Math.cos(t * 63) * 0.012 * shake) : 0),
      0.5 * deathEase + leanRoll,
    );
    // v3.14 (item 1): Longbow-7 ADS is a real SCOPE — FOV 22 (~3.4x zoom),
    // not the 74->58 nudge every weapon got. That nudge was the whole
    // reason "scope tidak berfungsi": the zoom was barely visible and
    // there was no scope overlay at all. Other weapons keep ADS 58.
    // Dead players never stay scoped (the zoom releases on death).
    const isScoped = this.alive && this.adsHeld && this.weapon && this.weapon.def.zoom;
    const targetFov = isScoped ? 22 : this.adsHeld ? 58 : settings.fov;
    if (Math.abs(this.camera.fov - targetFov) > 0.2) {
      this.camera.fov += (targetFov - this.camera.fov) * 0.25;
      this.camera.updateProjectionMatrix();
    }
    // Viewmodel: ADS pulls it to centre, firing kicks it back, bob sways it.
    // adsLift (per-weapon, default 0) raises the sight onto the crosshair in
    // ADS — the uniform +0.055 rise leaves the Longbow scope ~0.15 low.
    // ADS also pushes the gun 0.30 forward: without it the stock rear sits
    // 0.10–0.16 m from the eye and fills the lower screen as a giant black
    // slab (worst on the long-stocked Longbow, but the same on every weapon).
    if (this.viewmodel) {
      const kick = this.flashT > 0 ? 0.06 : 0;
      const vm = this.vmBase || { x: 0.26, y: -0.24, z: -0.45 };
      const lift = (this.vmBase && this.vmBase.adsLift) || 0;
      // v3.12: RELOAD ANIMATION — while the current weapon reloads, the
      // rifle dips down, tilts muzzle-down and rolls toward the player,
      // then comes back up. Progress p runs 0 -> 1 over the weapon's
      // reloadTime (reloading counts down in update()). The dip eases in
      // over the first 30%, holds, and returns over the last 30%.
      // v3.13: dip/tilt come from the weapon's own profile (item 2) and
      // the rifle also CANTS toward the camera mid-reload, so the mag
      // well faces the player while the mag swaps. Timing/ammo untouched.
      let reloadP = 0, dip = 0;
      const w = this.weapon;
      if (w && w.reloading > 0) {
        reloadP = Math.min(1, Math.max(0, 1 - w.reloading / w.def.reloadTime));
        dip = reloadP < 0.3 ? reloadP / 0.3 : reloadP > 0.7 ? (1 - reloadP) / 0.3 : 1;
      }
      const rd = this._reloadDip ?? 0.12;
      const rt = this._reloadTilt ?? 0.55;
      // v3.13: THROW SWING — during a grenade throw the hand winds up
      // (back + down) and then swings forward + up to release. swing runs
      // -1 (wind-up) -> +1 (release) -> 0 (settle). Only while the
      // grenade viewmodel is actually showing.
      let swing = 0;
      const throwing = this.throwAnim && this.viewmodel === this._grenadeGroup;
      if (throwing) {
        const tp = this.throwAnim.t / this.throwAnim.dur;
        if (tp < 0.35) swing = -Math.sin((tp / 0.35) * Math.PI / 2);
        else if (tp < 0.7) swing = Math.sin(((tp - 0.35) / 0.35) * Math.PI / 2);
        else swing = 1 - (tp - 0.7) / 0.3;
        // The hand is empty after the release point (t = 0.15 s).
        this.viewmodel.visible = tp < 0.33;
      } else if (this.alive && this.viewmodel.visible === false && !this.throwAnim) {
        this.viewmodel.visible = true;
      }
      // v3.14: scoped — hide the viewmodel entirely (at FOV 22 the rifle
      // would fill the frame as a giant slab; the scope overlay is the
      // whole sight picture). Dead — the gun is dropped on death.
      if ((isScoped || !this.alive) && this.viewmodel) this.viewmodel.visible = false;
      this.viewmodel.position.set(
        vm.x * (1 - ads) + bobX * 0.4 * (1 - dip * 0.7) + this.lean * 0.04 + this.swayX,
        vm.y + bobY * 0.5 * (1 - dip * 0.7) + (ads ? 0.055 + lift : 0) - dip * rd + swing * 0.10 + this.swayY - this._sprintPose * 0.05,
        vm.z + kick + (ads ? -0.30 : 0) + dip * 0.05 - swing * 0.18,
      );
      this.viewmodel.rotation.x = this.recoilPitch * 1.4 + Math.sin(this.bobPhase) * 0.008 + dip * rt + swing * 0.6 + this.swayY * 2 + this._sprintPose * 0.45;
      this.viewmodel.rotation.z = dip * 0.35 + this.lean * 0.18 + this._sprintPose * 0.25;
      // v3.12: spare-mag prop — old mag drops out, fresh mag rises back
      // into the well. v3.13: the path starts at THIS weapon's mag well
      // (item 2) and drops OUT to the shooter's left, silhouetted against
      // open air instead of buried inside the receiver.
      if (this._reloadMag) {
        const rm = this._reloadMag;
        const mb = this._magBase || { x: 0, y: -0.13, z: 0.06 };
        if (reloadP >= 0.2 && reloadP < 0.55) {
          const q = (reloadP - 0.2) / 0.30;
          rm.visible = true;
          rm.position.set(mb.x - 0.12 * q, mb.y - q * 0.38, mb.z + q * 0.06);
          rm.rotation.x = q * 0.6;
          rm.rotation.z = q * 0.3;
        } else if (reloadP >= 0.5 && reloadP < 0.9) {
          const q = (reloadP - 0.55) / 0.35;
          rm.visible = true;
          rm.position.set(mb.x - 0.12 * (1 - q), mb.y - 0.38 + q * 0.38, mb.z + 0.06 * (1 - q));
          rm.rotation.x = (1 - q) * 0.6;
          rm.rotation.z = (1 - q) * 0.3;
        } else {
          rm.visible = false;
          rm.rotation.set(0, 0, 0);
        }
      }
      // ADS straightens the rifle so the sight sits dead centre. Mid-reload
      // the rifle cants toward the camera (v3.13) so the mag swap reads.
      this.viewmodel.rotation.y = (this.vmBase ? this.vmBase.ry : 0) * (1 - ads) + dip * 0.30 * (1 - ads);
    }
    this.flashT = Math.max(0, this.flashT - 0.05);
  }

  // Fire the current weapon. Returns a shot event for sim.js to resolve.
  tryFire(t, rng) {
    // v3.13: no shooting mid-throw — the hands are busy with the grenade.
    if (this.throwAnim) return null;
    const w = this.weapon;
    if (!w.fire(t)) {
      // v3.9: auto-reload on empty. Without it the gun goes dead after the
      // 25-round mag and every click is just a dry click until the player
      // remembers R — the reported "kadang peluru tidak keluar". Trying to
      // fire on an empty mag with reserve left starts the reload (with the
      // reload sound); the dry click only plays when nothing is left to load.
      if (w.ammo === 0 && w.reloading <= 0) {
        if (w.reserve > 0 && w.startReload()) this.audio.reload();
        else this.audio.dryFire();
      }
      return null;
    }
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
    // v3.8: the flash blooms 0.2 m past the muzzle along the aim, so the
    // starburst sits in open air instead of inside the barrel tip (where
    // the front sight + bright snow wash it out).
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    this.fx.flash.fire(mw.clone().addScaledVector(fwd, 0.2));
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
    if (this.grenades[type] <= 0 || this.grenade || this.throwAnim) return false;
    this.grenades[type]--;
    // v3.13: the throw is an ANIMATION, not an instant spawn. The grenade
    // viewmodel swaps in, winds up, and releases at t = 0.15 s (see
    // update()); the weapon comes back at 0.45 s. Pattern studied from
    // weichu2002/ThreeJS_FPS_2.0 (throwBall) + Gabry9110/CS-Clone-Fable5
    // (grenade ballistics) — implemented from scratch here.
    this.throwAnim = { t: 0, dur: 0.45, type, spawned: false };
    this._swapToGrenadeVm();
    return true;
  }
  _spawnGrenade(type) {
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    this.grenade = {
      type,
      pos: this.camera.position.clone().addScaledVector(dir, 0.6),
      vel: dir.multiplyScalar(13).add(new THREE.Vector3(0, 4.5, 0)),
      fuse: WEAPONS[type].fuse,
    };
  }
  // Swap the weapon viewmodel for the grenade in-hand during a throw.
  // The weapon group is saved (not destroyed) and restored when the throw
  // ends — or left alone if the player switched weapons mid-throw (then
  // the new weapon is already showing and the restore is a no-op).
  _swapToGrenadeVm() {
    if (this._savedVm) return;
    this._savedVm = { group: this.viewmodel, muzzle: this.muzzle, vmBase: this.vmBase, reloadMag: this._reloadMag };
    const { group, muzzle } = buildViewmodel('he');
    this._grenadeGroup = group;
    if (this.viewmodel) this.camera.remove(this.viewmodel);
    group.scale.setScalar(1.3);
    group.rotation.y = 0.05;
    group.position.set(0.26, -0.25, -0.48);
    this.viewmodel = group;
    this.muzzle = muzzle;
    this.vmBase = { x: 0.26, y: -0.25, z: -0.48, ry: 0.05 };
    this._reloadMag = null;
    this.camera.add(group);
  }
  _restoreWeaponVm() {
    const s = this._savedVm;
    const g = this._grenadeGroup;
    this._savedVm = null;
    this._grenadeGroup = null;
    if (!s || !g) return;
    // Only swap back if the grenade is still the visible viewmodel. If
    // the player equipped another weapon mid-throw, that weapon is already
    // showing and must not be replaced by the stale saved group.
    if (this.viewmodel !== g) return;
    this.camera.remove(this.viewmodel);
    this.viewmodel = s.group;
    this.muzzle = s.muzzle;
    this.vmBase = s.vmBase;
    this._reloadMag = s.reloadMag;
    this.viewmodel.visible = true;
    this.camera.add(this.viewmodel);
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
