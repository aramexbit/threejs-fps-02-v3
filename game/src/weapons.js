// weapons.js — weapon data + detailed viewmodels for FROSTLINE.
// Data-driven: one WEAPONS table, one Weapon class. Every gun has its own
// viewmodel built from primitives — barrel, magazine, aperture sight, stock —
// plus a simple gloved hand gripping it, so the first-person view reads as a
// held weapon, not a floating box. Muzzle flash anchors at the barrel tip.
import * as THREE from 'three';

export const WEAPONS = {
  p9: {
    id: 'p9', name: 'P9', kind: 'pistol', price: 0,
    damage: 34, headMult: 4, rpm: 380, mag: 12, reserve: 36,
    reloadTime: 1.4, spread: 0.011, moveSpread: 0.02, recoil: 0.011,
    auto: false, adsSpreadMult: 0.6, range: 40,
  },
  vex9: {
    id: 'vex9', name: 'Vex-9', kind: 'smg', price: 1500,
    damage: 26, headMult: 4, rpm: 750, mag: 30, reserve: 90,
    reloadTime: 1.9, spread: 0.016, moveSpread: 0.026, recoil: 0.009,
    auto: true, adsSpreadMult: 0.6, range: 45,
  },
  ar77: {
    id: 'ar77', name: 'AR-77', kind: 'rifle', price: 2700,
    damage: 33, headMult: 4, rpm: 600, mag: 25, reserve: 75,
    reloadTime: 2.2, spread: 0.008, moveSpread: 0.02, recoil: 0.014,
    auto: true, adsSpreadMult: 0.6, range: 60,
  },
  longbow: {
    id: 'longbow', name: 'Longbow-7', kind: 'sniper', price: 4750,
    damage: 95, headMult: 4, rpm: 55, mag: 5, reserve: 15,
    reloadTime: 3.1, spread: 0.002, moveSpread: 0.05, recoil: 0.05,
    auto: false, adsSpreadMult: 0.5, range: 90, zoom: true,
  },
  he: {
    id: 'he', name: 'HE Grenade', kind: 'grenade', price: 300,
    damage: 110, radius: 6, fuse: 1.6,
  },
};

export class Weapon {
  constructor(def) {
    this.def = def;
    this.ammo = def.mag;
    this.reserve = def.reserve;
    this.reloading = 0; // seconds left, 0 = ready
    this.lastShot = -10;
  }
  get rpmInterval() { return 60 / this.def.rpm; }
  canFire(t) {
    return this.reloading <= 0 && this.ammo > 0 && t - this.lastShot >= this.rpmInterval;
  }
  fire(t) {
    if (!this.canFire(t)) return false;
    this.ammo--;
    this.lastShot = t;
    return true;
  }
  startReload() {
    if (this.reloading > 0 || this.ammo >= this.def.mag || this.reserve <= 0) return false;
    this.reloading = this.def.reloadTime;
    return true;
  }
  update(dt) {
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.reloading = 0;
        const need = this.def.mag - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
      }
    }
  }
}

// --- Viewmodel materials (shared, built once) --------------------------------
let _mats = null;
function mats() {
  if (_mats) return _mats;
  _mats = {
    gunmetal: new THREE.MeshStandardMaterial({ color: 0x424a55, roughness: 0.42, metalness: 0.85 }),
    gunmetalLight: new THREE.MeshStandardMaterial({ color: 0x6a727e, roughness: 0.38, metalness: 0.9 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x1e2124, roughness: 0.85, metalness: 0.1 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.8, metalness: 0.0 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x54483a, roughness: 0.95, metalness: 0.0 }),
    gloveCuff: new THREE.MeshStandardMaterial({ color: 0x6a5f4c, roughness: 0.95, metalness: 0.0 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9fc4d8, roughness: 0.1, metalness: 0.4, emissive: 0x1a2c38 }),
  };
  return _mats;
}

function box(w, h, d, mat, x, y, z, rx = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx; m.rotation.z = rz;
  return m;
}
function cyl(rt, rb, h, mat, x, y, z, rx = Math.PI / 2, seg = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  return m;
}

// A simple gloved hand: palm + curled fingers + cuff, gripping at (x,y,z)
// with the fingers wrapped around a grip. `tilt` rotates the grip angle.
function glovedHand(x, y, z, tilt = 0.25) {
  const M = mats();
  const hand = new THREE.Group();
  hand.position.set(x, y, z);
  hand.rotation.x = tilt;
  hand.add(box(0.075, 0.05, 0.11, M.glove, 0, 0, 0)); // palm
  hand.add(box(0.07, 0.045, 0.05, M.glove, 0, -0.008, -0.07)); // fingers curled
  hand.add(box(0.02, 0.04, 0.05, M.glove, 0.045, 0.005, -0.03)); // thumb
  hand.add(box(0.085, 0.06, 0.05, M.gloveCuff, 0, 0.005, 0.075)); // cuff
  return hand;
}

// Aperture (ring) sight: a torus standing on a short post.
function apertureSight(x, y, z, r = 0.021) {
  const M = mats();
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.005, 8, 20), M.gunmetalLight);
  g.add(ring);
  const post = box(0.008, 0.02, 0.008, M.gunmetal, 0, -r - 0.008, 0);
  g.add(post);
  return g;
}

// Build a first-person viewmodel for a weapon id. Returns {group, muzzle}
// where muzzle is an Object3D at the barrel tip (flash + smoke anchor).
// The group is posed for the camera in player.js (position/rotation set there).
export function buildViewmodel(id) {
  const M = mats();
  const group = new THREE.Group();
  const muzzle = new THREE.Object3D();
  // Forward is -Z (three.js camera convention).
  if (id === 'p9') {
    group.add(box(0.055, 0.05, 0.24, M.gunmetal, 0, 0, -0.08)); // slide
    group.add(box(0.05, 0.03, 0.2, M.gunmetalLight, 0, 0.028, -0.08)); // slide top
    group.add(box(0.05, 0.11, 0.07, M.polymer, 0, -0.07, 0.045, 0.18)); // grip
    group.add(box(0.012, 0.018, 0.012, M.gunmetalLight, 0, 0.032, -0.19)); // front sight
    group.add(box(0.03, 0.012, 0.02, M.gunmetalLight, 0, 0.03, 0.02)); // rear sight
    group.add(cyl(0.012, 0.012, 0.03, M.gunmetal, 0, 0.005, -0.21)); // muzzle
    group.add(glovedHand(0, -0.075, 0.05, 0.18));
    muzzle.position.set(0, 0.005, -0.23);
  } else if (id === 'vex9') {
    group.add(box(0.06, 0.07, 0.34, M.gunmetal, 0, 0, -0.05)); // receiver
    group.add(cyl(0.026, 0.026, 0.16, M.gunmetalLight, 0, 0.005, -0.29)); // shroud
    group.add(box(0.045, 0.14, 0.06, M.polymer, 0, -0.095, -0.10, 0.12)); // long mag
    group.add(box(0.05, 0.09, 0.07, M.polymer, 0, -0.065, 0.10, 0.2)); // grip
    group.add(box(0.05, 0.05, 0.12, M.polymer, 0, -0.055, 0.16)); // stock
    group.add(apertureSight(0, 0.055, -0.02));
    group.add(box(0.012, 0.02, 0.012, M.gunmetalLight, 0, 0.045, -0.36)); // front post
    group.add(glovedHand(0, -0.07, 0.10, 0.2));
    group.add(glovedHand(0.01, -0.055, -0.16, 0.1)); // support hand on shroud
    muzzle.position.set(0, 0.005, -0.38);
  } else if (id === 'ar77') {
    group.add(box(0.062, 0.075, 0.36, M.gunmetal, 0, 0, -0.02)); // receiver
    group.add(box(0.055, 0.06, 0.26, M.polymer, 0, -0.005, -0.30)); // handguard
    group.add(cyl(0.014, 0.014, 0.22, M.gunmetal, 0, 0.01, -0.50)); // barrel
    group.add(box(0.05, 0.13, 0.07, M.polymer, 0, -0.09, -0.06, 0.22)); // curved mag
    group.add(box(0.05, 0.09, 0.07, M.polymer, 0, -0.065, 0.12, 0.2)); // grip
    group.add(box(0.055, 0.075, 0.16, M.wood, 0, -0.01, 0.24)); // stock
    group.add(box(0.03, 0.02, 0.05, M.gunmetalLight, 0, 0.05, -0.16)); // carry handle
    group.add(apertureSight(0, 0.06, -0.10));
    group.add(box(0.012, 0.022, 0.012, M.gunmetalLight, 0, 0.045, -0.42)); // front post
    group.add(glovedHand(0, -0.07, 0.12, 0.2));
    group.add(glovedHand(0.01, -0.06, -0.28, 0.08)); // support hand
    muzzle.position.set(0, 0.01, -0.62);
  } else if (id === 'longbow') {
    group.add(box(0.06, 0.08, 0.42, M.gunmetal, 0, 0, 0.0)); // receiver
    group.add(cyl(0.013, 0.013, 0.42, M.gunmetal, 0, 0.015, -0.55)); // long barrel
    group.add(cyl(0.02, 0.02, 0.06, M.gunmetalLight, 0, 0.015, -0.76)); // muzzle brake
    group.add(cyl(0.028, 0.028, 0.16, M.gunmetal, 0, 0.055, -0.05, 0, 16)); // scope tube
    group.add(cyl(0.032, 0.032, 0.02, M.glass, 0, 0.055, -0.13, 0, 16)); // scope lens
    group.add(box(0.045, 0.09, 0.06, M.polymer, 0, -0.085, -0.04, 0.1)); // mag
    group.add(box(0.05, 0.09, 0.07, M.polymer, 0, -0.065, 0.14, 0.2)); // grip
    group.add(box(0.055, 0.08, 0.2, M.wood, 0, -0.01, 0.28)); // wooden stock
    group.add(cyl(0.008, 0.008, 0.07, M.gunmetalLight, 0.045, -0.01, 0.02, 0, 8)); // bolt
    group.add(glovedHand(0, -0.07, 0.14, 0.2));
    group.add(glovedHand(0.01, -0.055, -0.30, 0.06));
    muzzle.position.set(0, 0.015, -0.79);
  } else {
    // HE grenade: a dark green ovoid with pin + lever, held in a gloved hand.
    const gren = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x3d4a2e, roughness: 0.6, metalness: 0.4 }),
    );
    gren.scale.set(1, 1.25, 1);
    group.add(gren);
    group.add(cyl(0.008, 0.008, 0.05, M.gunmetalLight, 0.03, 0.07, 0, 0.6, 8)); // pin ring pull
    group.add(box(0.012, 0.09, 0.02, M.gunmetalLight, 0.05, 0.02, 0)); // lever
    group.add(glovedHand(0, -0.06, 0.02, 0.1));
    muzzle.position.set(0, 0.07, 0);
  }
  group.add(muzzle);
  group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { group, muzzle };
}
