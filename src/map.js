// map.js — "Ironworks Ridge": a snowy industrial warzone, 44 x 36 m.
// Original layout: three lanes (A ridge north, mid service road, B crane lane
// south), two bombsites (A "Foundry", B "Crane Yard"), Solara spawning west,
// Bastion east. Every visual prop has a matching AABB collider (or is clearly
// non-collidable and never blocks a path). Waypoints form a graph the bots
// walk; edges are built with a segment-vs-AABB line-of-sight test.
import * as THREE from 'three';
import { fbm, mulberry32 } from './rng.js';
import {
  concreteTextures, containerTextures, hazardTextures, rockTextures,
  sandbagTextures, snowTextures, woodTextures, siteLetterTexture, siteSignTexture,
} from './textures.js';

export const MAP = { w: 44, h: 36, halfW: 22, halfH: 18 };
export const SITES = {
  A: { name: 'Foundry', center: { x: 15, z: -12 }, r: 6.5 },
  B: { name: 'Crane Yard', center: { x: 15, z: 12 }, r: 6.5 },
};
export const SPAWNS = {
  solara: [{ x: -20, z: -4 }, { x: -20, z: 0 }, { x: -20, z: 4 }, { x: -18, z: -7 }, { x: -18, z: 7 }],
  // v3.13 fix: (20,14) sat INSIDE the boiler block collider, so the bot
  // spawned there could never move (proven 16 Nov: the Bastion carrier
  // Hail spawned there and stayed put for a whole round). (13,16) is clear
  // ground just west of the block, still on the Bastion side of site B.
  // v3.13 fix 2: (20,-14) and (20,-10) sat INSIDE the foundry east wall
  // collider (x 20.2..21.0) — the spawnAt safety net handled them, but
  // clear spawns are better than relying on the net. (19.5,-14) then
  // landed inside the foundry furnace collider (x 17.1..19.3, z -15.4..-13.8),
  // so the first spawn is (19.5,-13) instead — clear of both.
  bastion: [{ x: 19.5, z: -13 }, { x: 19.5, z: -10 }, { x: 20, z: 10 }, { x: 13, z: 16 }, { x: 18, z: 0 }],
};

function std(params) { return new THREE.MeshStandardMaterial(params); }
function boxAt(mat, w, h, d, x, y, z, ry = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.rotation.y = ry;
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cylAt(mat, rt, rb, h, x, y, z, seg = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// Displace a geometry's vertices radially with tileable fbm noise —
// breaks the perfect sphere/icosahedron silhouette. The noise is a
// function of position, so duplicated seam vertices move identically
// and no cracks open up.
function displace(geo, amt, seed) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm(v.x * 0.12 + seed * 3.1, v.z * 0.12 + seed * 1.7, 8, seed, 3);
    v.multiplyScalar(1 + (n - 0.5) * 2 * amt);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// Segment (x0,z0)-(x1,z1) blocked by any AABB? (2D test, used for waypoints.)
export function segmentBlocked(x0, z0, x1, z1, colliders) {
  for (const c of colliders) {
    const dx = x1 - x0, dz = z1 - z0;
    let tmin = 0, tmax = 1;
    if (Math.abs(dx) < 1e-9) { if (x0 < c.minX || x0 > c.maxX) continue; }
    else {
      let t1 = (c.minX - x0) / dx, t2 = (c.maxX - x0) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    if (Math.abs(dz) < 1e-9) { if (z0 < c.minZ || z0 > c.maxZ) continue; }
    else {
      let t1 = (c.minZ - z0) / dz, t2 = (c.maxZ - z0) / dz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    return true;
  }
  return false;
}

export function buildMap(scene) {
  const group = new THREE.Group();
  const colliders = [];
  const addCollider = (x, z, hw, hd, h = 3) => {
    colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd, h });
  };
  const snow = snowTextures(11);
  const concrete = concreteTextures(23);
  const wood = woodTextures(51);
  const hazard = hazardTextures(67);
  const sandbag = sandbagTextures(71);
  const rock = rockTextures(83);
  const contRed = containerTextures([158, 62, 44], 37);
  const contBlue = containerTextures([74, 96, 116], 41);
  const contGreen = containerTextures([74, 104, 72], 43);

  const snowMat = std({ ...snow, roughness: 0.9, metalness: 0 });
  const concMat = std({ ...concrete, roughness: 0.92, metalness: 0 });
  const woodMat = std({ ...wood, roughness: 0.85, metalness: 0 });
  const hazardMat = std({ ...hazard, roughness: 0.6, metalness: 0.55 });
  const sandMat = std({ ...sandbag, roughness: 0.96, metalness: 0 });
  const rockMat = std({ ...rock, roughness: 0.95, metalness: 0 });
  const redMat = std({ ...contRed, roughness: 0.55, metalness: 0.7 });
  const blueMat = std({ ...contBlue, roughness: 0.55, metalness: 0.7 });
  const greenMat = std({ ...contGreen, roughness: 0.55, metalness: 0.7 });
  const steelMat = std({ color: 0x5a6673, roughness: 0.5, metalness: 0.8 });
  // v3.5: roof material is warm, rough and non-metallic. The old steelMat
  // (metalness 0.8) reflected the dark lower hemisphere of the env on its
  // underside, so the foundry roof read almost black in the plant shot.
  // This catches hemisphere + furnace fire light instead.
  const roofMat = std({ color: 0x8a7663, roughness: 0.85, metalness: 0.1 });
  const darkSteel = std({ color: 0x2e3238, roughness: 0.45, metalness: 0.85 });
  const craneMat = std({ color: 0xa33327, roughness: 0.6, metalness: 0.4 });
  const barkMat = std({ color: 0x4a3a28, roughness: 0.95, metalness: 0 });
  const leafMat = std({ color: 0xc96a24, roughness: 0.9, metalness: 0 });
  const grassMat = std({ color: 0x8a713c, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }); // v3.2: darker, less cardboard-orange (was 0x9a7d46)
  const pineMat = std({ color: 0x2e4d33, roughness: 0.95, metalness: 0 }); // v3.4: dark pine green
  const snowWhite = std({ color: 0xe8edf2, roughness: 0.9, metalness: 0 }); // v3.4: snow-tipped pine tops

  // --- Ground ----------------------------------------------------------------
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP.w + 30, MAP.h + 30), snowMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // --- Perimeter: low concrete walls + fence posts ----------------------------
  const wallH = 2.2;
  const walls = [
    [0, -MAP.halfH - 0.6, MAP.w + 2, 1.2], [0, MAP.halfH + 0.6, MAP.w + 2, 1.2],
    [-MAP.halfW - 0.6, 0, 1.2, MAP.h + 2], [MAP.halfW + 0.6, 0, 1.2, MAP.h + 2],
  ];
  for (const [x, z, w, d] of walls) {
    group.add(boxAt(concMat, w, wallH, d, x, wallH / 2, z));
    addCollider(x, z, w / 2, d / 2, wallH);
  }

  // --- Site A: the Foundry (concrete U, open west) ----------------------------
  const foundry = (cx, cz) => {
    // v3.13 (item 9): the Foundry is a bomb SITE now, so it is wider —
    // walls at ±5.6 instead of ±4.6 and the east wall out at +5.6, leaving
    // real room to move, fight and plant around the furnace.
    group.add(boxAt(concMat, 11, 4.5, 0.8, cx, 2.25, cz - 5.6)); // north wall
    group.add(boxAt(concMat, 11, 4.5, 0.8, cx, 2.25, cz + 5.6)); // south wall
    group.add(boxAt(concMat, 0.8, 4.5, 12, cx + 5.6, 2.25, cz)); // east wall
    addCollider(cx, cz - 5.6, 5.5, 0.4, 4.5);
    addCollider(cx, cz + 5.6, 5.5, 0.4, 4.5);
    addCollider(cx + 5.6, cz, 0.4, 6, 4.5);
    // Furnace: dark box with a glowing orange mouth (fire spot).
    const furnace = boxAt(darkSteel, 2.2, 2.6, 1.6, cx + 3.2, 1.3, cz - 2.6);
    group.add(furnace);
    const mouth = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.9),
      new THREE.MeshBasicMaterial({ color: 0xff7a2f }),
    );
    mouth.position.set(cx + 2.05, 1.1, cz - 2.6);
    mouth.rotation.y = -Math.PI / 2;
    group.add(mouth);
    addCollider(cx + 3.2, cz - 2.6, 1.1, 0.8, 2.6);
    // Pipes along the north wall.
    group.add(cylAt(steelMat, 0.22, 0.22, 10.4, cx, 3.6, cz - 5.1, 10));
    const pipe = group.children[group.children.length - 1];
    pipe.rotation.z = Math.PI / 2;
    // Destruction detail (Gemini realism pass): rubble chunks + exposed rebar
    // scattered around the foundry, like the shattered concrete in the reference.
    const rRnd = mulberry32(444);
    for (let i = 0; i < 8; i++) {
      const rx = cx + (rRnd() - 0.5) * 9, rz = cz + (rRnd() - 0.5) * 9;
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.1 + rRnd() * 0.2, 0), concMat);
      chunk.position.set(rx, 0.1, rz);
      chunk.rotation.set(rRnd() * Math.PI, rRnd() * Math.PI, rRnd() * Math.PI);
      chunk.castShadow = true; chunk.receiveShadow = true;
      group.add(chunk);
      if (i % 3 === 0) {
        const bar = cylAt(steelMat, 0.012, 0.012, 0.8, rx, 0.35, rz, 6);
        bar.rotation.set((rRnd() - 0.5) * 1.6, 0, (rRnd() - 0.5) * 1.6);
        group.add(bar);
      }
    }
  };
  foundry(SITES.A.center.x, SITES.A.center.z);

  // --- Site B: Boiler House + the red lattice crane ---------------------------
  const boiler = (cx, cz) => {
    // v3.13 (item 9): the boiler block slides south-east so the site centre
    // opens up; the tank and chimney move with it. Waypoints (15,8), (17,12)
    // and (19,12) all stay clear of the new colliders.
    group.add(boxAt(concMat, 6, 4, 5, cx + 4.5, 2, cz + 3)); // boiler block
    addCollider(cx + 4.5, cz + 3, 3, 2.5, 4);
    group.add(cylAt(steelMat, 1.1, 1.1, 3.4, cx + 2, 1.7, cz - 3.5, 16)); // water tank
    addCollider(cx + 2, cz - 3.5, 1.1, 1.1, 3.4);
    const chimney = cylAt(darkSteel, 0.45, 0.6, 7, cx + 6, 3.5, cz + 5.5, 12);
    group.add(chimney);
    addCollider(cx + 6, cz + 5.5, 0.6, 0.6, 7);
  };
  boiler(SITES.B.center.x, SITES.B.center.z);

  // Red lattice crane over the B yard: 4 legs, cross-braces, cab, long jib,
  // hanging cable + hook. Our own lattice design (boxes + cylinders).
  const crane = (cx, cz) => {
    const H = 13;
    for (const [lx, lz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) {
      group.add(boxAt(craneMat, 0.35, H, 0.35, cx + lx, H / 2, cz + lz));
    }
    for (let y = 2; y < H; y += 2.4) {
      group.add(boxAt(craneMat, 2.55, 0.22, 0.22, cx, y, cz - 1.1));
      group.add(boxAt(craneMat, 2.55, 0.22, 0.22, cx, y, cz + 1.1));
      group.add(boxAt(craneMat, 0.22, 0.22, 2.55, cx - 1.1, y, cz));
      group.add(boxAt(craneMat, 0.22, 0.22, 2.55, cx + 1.1, y, cz));
      const diag = boxAt(craneMat, 0.16, 3.1, 0.16, cx, y + 1.1, cz - 1.1);
      diag.rotation.x = 0.6; group.add(diag);
    }
    group.add(boxAt(craneMat, 2.8, 1.4, 2.8, cx, H + 0.7, cz)); // cab
    // Jib: 11 m truss reaching west over the yard, counter-jib east.
    const jib = new THREE.Group();
    jib.position.set(cx, H + 1.6, cz);
    jib.add(boxAt(craneMat, 11, 0.3, 0.3, -5.5, 0, 0));
    jib.add(boxAt(craneMat, 11, 0.3, 0.3, -5.5, -0.9, 0));
    for (let x = -10; x <= -1; x += 1.5) {
      jib.add(boxAt(craneMat, 0.18, 1.1, 0.18, x, -0.45, 0));
    }
    jib.add(boxAt(craneMat, 3.5, 0.3, 0.3, 1.75, 0, 0)); // counter-jib
    jib.add(boxAt(craneMat, 1.2, 1.0, 1.2, 2.6, -0.6, 0)); // counterweight
    group.add(jib);
    // Cable + hook hanging over the yard.
    group.add(cylAt(darkSteel, 0.03, 0.03, 5.5, cx - 8.5, H - 1.4, cz, 6));
    group.add(boxAt(darkSteel, 0.5, 0.7, 0.4, cx - 8.5, H - 4.4, cz));
    addCollider(cx, cz, 1.3, 1.3, H);
  };
  crane(12, 10);

  // --- Containers (cover) ------------------------------------------------------
  const container = (x, z, mat, ry = 0, len = 6) => {
    group.add(boxAt(mat, len, 2.6, 2.6, x, 1.3, z, ry));
    const hw = ry === 0 ? len / 2 : 1.3, hd = ry === 0 ? 1.3 : len / 2;
    addCollider(x, z, hw, hd, 2.6);
    // Snow cap on top.
    const cap = boxAt(std({ color: 0xe8edf2, roughness: 0.9, metalness: 0 }), len * 0.98, 0.12, 2.55, x, 2.66, z, ry);
    cap.castShadow = false;
    group.add(cap);
  };
  container(-8, -8, redMat);
  container(2, -6, blueMat, Math.PI / 2);
  container(-2, 8, greenMat, 0, 5);
  container(8, 10, redMat, Math.PI / 2, 5);
  container(-14, 2, blueMat, 0, 5);
  container(6, -13, greenMat, 0, 5);

  // --- Sandbag walls + wooden barricades ---------------------------------------
  const sandbags = (x, z, ry = 0) => {
    for (let row = 0; row < 3; row++) {
      for (let i = -1; i <= 1; i++) {
        const s = boxAt(sandMat, 1.1, 0.42, 0.55, x + Math.cos(ry) * i * 1.15, 0.21 + row * 0.4, z - Math.sin(ry) * i * 1.15, ry);
        s.scale.x = 1 - row * 0.12;
        group.add(s);
      }
    }
    addCollider(x, z, 1.8, 0.5, 1.3);
  };
  sandbags(-12, 0, 0);
  sandbags(6, -2, Math.PI / 2);
  sandbags(11, 2, 0.3);
  const barricade = (x, z, ry = 0) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z); g.rotation.y = ry;
    g.add(boxAt(hazardMat, 2.4, 0.9, 0.12, 0, 0.85, 0));
    g.add(boxAt(woodMat, 0.18, 1.3, 0.18, -1.0, 0.65, 0));
    g.add(boxAt(woodMat, 0.18, 1.3, 0.18, 1.0, 0.65, 0));
    g.add(boxAt(woodMat, 2.4, 0.14, 0.14, 0, 0.35, 0));
    group.add(g);
    addCollider(x, z, 1.3, 0.4, 1.3);
  };
  barricade(-6, -12, 0.2);
  barricade(4, 12, -0.15);
  barricade(10, -4, Math.PI / 2);

  // --- Wood pile + bonfire (mid) ------------------------------------------------
  const firewood = (x, z) => {
    const rnd = mulberry32(99);
    for (let i = 0; i < 14; i++) {
      const log = cylAt(woodMat, 0.14, 0.14, 1.6 + rnd() * 0.5, x + (rnd() - 0.5) * 1.2, 0.3 + rnd() * 0.5, z + (rnd() - 0.5) * 1.2, 8);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = rnd() * Math.PI;
      group.add(log);
    }
    addCollider(x, z, 1.0, 1.0, 1.0);
  };
  firewood(0, 6);
  // Destruction detail (Gemini realism pass): rubble + rebar around the mid
  // bonfire, visible in the play shot — the foundry cluster is at site A.
  {
    const mRnd = mulberry32(445);
    for (let i = 0; i < 6; i++) {
      const rx = (mRnd() - 0.5) * 6, rz = 6 + (mRnd() - 0.5) * 6;
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.08 + mRnd() * 0.18, 0), concMat);
      chunk.position.set(rx, 0.08, rz);
      chunk.rotation.set(mRnd() * Math.PI, mRnd() * Math.PI, mRnd() * Math.PI);
      chunk.castShadow = true; chunk.receiveShadow = true;
      group.add(chunk);
      if (i % 2 === 0) {
        const bar = cylAt(steelMat, 0.012, 0.012, 0.7, rx, 0.3, rz, 6);
        bar.rotation.set((mRnd() - 0.5) * 1.6, 0, (mRnd() - 0.5) * 1.6);
        group.add(bar);
      }
    }
  }

  // --- Destroyed wall slab + rebar (v3.2 CoD pass): shattered concrete
  // panel leaning in mid, visual only (no collider — gameplay unchanged).
  {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.0, 0.3), concMat);
    slab.position.set(3, 0.85, -2.5);
    slab.rotation.set(0.15, 0.5, -0.28);
    slab.castShadow = true; slab.receiveShadow = true;
    group.add(slab);
    const sRnd = mulberry32(777);
    for (let i = 0; i < 4; i++) {
      const bar = cylAt(steelMat, 0.012, 0.012, 0.9 + sRnd() * 0.5, 3 + (sRnd() - 0.5) * 1.6, 1.3 + sRnd() * 0.6, -2.5 + (sRnd() - 0.5) * 1.2, 6);
      bar.rotation.set((sRnd() - 0.5) * 1.8, 0, (sRnd() - 0.5) * 1.8);
      group.add(bar);
    }
    // Second rubble field across mid (visual only).
    for (let i = 0; i < 10; i++) {
      const cx = i < 5 ? 1 + (sRnd() - 0.5) * 4 : 5 + (sRnd() - 0.5) * 4;
      const cz = i < 5 ? 3 + (sRnd() - 0.5) * 4 : -4 + (sRnd() - 0.5) * 4;
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.08 + sRnd() * 0.2, 0), concMat);
      chunk.position.set(cx, 0.08, cz);
      chunk.rotation.set(sRnd() * Math.PI, sRnd() * Math.PI, sRnd() * Math.PI);
      chunk.castShadow = true; chunk.receiveShadow = true;
      group.add(chunk);
      if (i % 3 === 0) {
        const bar = cylAt(steelMat, 0.012, 0.012, 0.7, cx, 0.3, cz, 6);
        bar.rotation.set((sRnd() - 0.5) * 1.6, 0, (sRnd() - 0.5) * 1.6);
        group.add(bar);
      }
    }
  }

  // --- Burning barrel (v3.2 CoD pass): second fire + smoke column in mid.
  group.add(cylAt(darkSteel, 0.35, 0.35, 0.9, 3, 0.45, 3, 12));
  {
    const crate = boxAt(woodMat, 0.9, 0.9, 0.9, 3.9, 0.45, 2.2, 0.4);
    crate.rotation.z = 0.2;
    group.add(crate);
  }

  // --- Bare trees (trunk + naked branches + a few orange leaves) ---------------
  const tree = (x, z, s = 1) => {
    const rnd = mulberry32(Math.round(x * 10 + z));
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const trunk = cylAt(barkMat, 0.14 * s, 0.22 * s, 3.2 * s, 0, 1.6 * s, 0, 8);
    g.add(trunk);
    for (let i = 0; i < 6; i++) {
      const br = cylAt(barkMat, 0.03 * s, 0.06 * s, 1.6 * s, 0, 2.9 * s, 0, 6);
      br.rotation.z = 0.7 + rnd() * 0.5;
      br.rotation.y = (i / 6) * Math.PI * 2;
      br.position.y = 2.9 * s;
      br.translateY(0.5 * s);
      g.add(br);
    }
    for (let i = 0; i < 4; i++) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22 * s, 0), leafMat);
      leaf.position.set((rnd() - 0.5) * 1.6 * s, (2.6 + rnd() * 1.2) * s, (rnd() - 0.5) * 1.6 * s);
      leaf.scale.y = 0.5;
      leaf.castShadow = true;
      g.add(leaf);
    }
    group.add(g);
    addCollider(x, z, 0.3, 0.3, 3.2);
  };
  tree(-18, -14, 1.2); tree(-16, 14, 1); tree(18, -15, 1.1);
  tree(-10, 15.5, 0.9); tree(4, -15.5, 1); tree(-19, 6, 1.15);

  // --- Snow-capped rocks ---------------------------------------------------------
  const rockSpots = [[-5, -3, 1.2], [9, 4, 0.9], [-13, -9, 1.5], [13, -2, 0.8], [1, 14, 1.1], [-4, -14, 0.7]];
  for (const [x, z, s] of rockSpots) {
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
    r.position.set(x, s * 0.45, z);
    r.rotation.set(0.4, x, 0.2);
    r.scale.y = 0.65;
    r.castShadow = true; r.receiveShadow = true;
    group.add(r);
    addCollider(x, z, s * 0.8, s * 0.8, s);
  }

  // --- v3.4 organic shapes pass ------------------------------------------------
  // The world was almost all boxes on a flat plane. This pass adds curved
  // and displaced forms WITHOUT touching gameplay: everything new is either
  // outside the walls, piled against a wall base, on top of a building, or
  // a collider hugging an existing one. New in-bounds colliders were
  // link-checked against the bot waypoint graph (39 links before and
  // after, none cut).

  // Snow hills outside the compound: tall enough (2.6–3.6 m) to read over
  // the 2.2 m walls. Squashed displaced spheres, centres at ground level.
  const hillSpots = [
    [0, -26, 6, 0.5], [-16, -25, 5, 0.55], [16, -26, 5.5, 0.5],
    [-8, 26, 6, 0.5], [12, 27, 5, 0.55],
    [-29, -6, 5, 0.55], [-29, 10, 4.5, 0.6],
    [29, -8, 5, 0.55], [28, 12, 5, 0.5],
  ];
  {
    const hRnd = mulberry32(3401);
    for (const [x, z, r, sy] of hillSpots) {
      const geo = displace(new THREE.SphereGeometry(r, 20, 14), 0.22, Math.floor(hRnd() * 1000));
      const hill = new THREE.Mesh(geo, snowMat);
      hill.scale.set(1, sy, 0.9);
      hill.position.set(x, 0, z);
      hill.castShadow = true; hill.receiveShadow = true;
      group.add(hill);
    }
  }

  // Low drifts banked against the inside wall bases (soft snow, no
  // colliders — a player stepping on a drift edge is snow, not a wall).
  const driftSpots = [
    [-14, -17.3, 2.2, 0.3], [-4, -17.5, 1.8, 0.35], [6, -17.2, 2.0, 0.3], [-19, -17.3, 2.4, 0.3],
    [-12, 17.3, 2.0, 0.35], [2, 17.4, 2.2, 0.3], [14, 17.2, 1.9, 0.3],
    [-21.3, -10, 1.8, 0.35], [-21.3, 10, 2.0, 0.3], [21.3, 2, 1.8, 0.35],
  ];
  {
    const dRnd = mulberry32(3402);
    for (const [x, z, r, sy] of driftSpots) {
      const geo = displace(new THREE.SphereGeometry(r, 16, 10), 0.25, Math.floor(dRnd() * 1000));
      const drift = new THREE.Mesh(geo, snowMat);
      drift.scale.set(1, sy, 0.85);
      drift.position.set(x, 0, z);
      drift.receiveShadow = true;
      group.add(drift);
    }
  }

  // Displaced-icosahedron rocks (the old rocks are plain dodecahedrons).
  // Big ones outside the walls; in-bounds ones hug the edges outside the
  // waypoint box (x ±20 / z ±12); two sit near container cover.
  const newRocks = [
    // [x, z, r, solid]
    [-27, -16, 2.2, false], [27, 2, 2.6, false], [6, -27, 2.4, false],
    [-21, -14.5, 1.1, true], [21, 14.5, 1.2, true], [-21, 15.5, 0.9, true], [-6, 16.8, 1.0, true],
    [5.6, 9.5, 0.7, true], [-5.6, 8, 0.7, true],
  ];
  {
    const kRnd = mulberry32(3403);
    for (const [x, z, r, solid] of newRocks) {
      const geo = displace(new THREE.IcosahedronGeometry(r, 1), 0.3, Math.floor(kRnd() * 1000));
      const rock = new THREE.Mesh(geo, rockMat);
      rock.position.set(x, r * 0.45, z);
      rock.rotation.set(kRnd() * 0.6, kRnd() * Math.PI, kRnd() * 0.6);
      rock.scale.y = 0.7;
      rock.castShadow = true; rock.receiveShadow = true;
      group.add(rock);
      if (solid) addCollider(x, z, r * 0.8, r * 0.8, r);
    }
  }

  // Pine trees: trunk + 3 stacked cones, snow-tipped top cone. Tall ones
  // outside the walls read over them; three in-bounds pines sit in the
  // corners, outside the waypoint box, with colliders.
  // v3.7: each pine group is recorded so upgradePines() can swap the cones
  // for a clone of the CC0 Quaternius pine GLB (same spot/scale/collider).
  const pineGroups = [];
  const pine = (x, z, s, solid) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.add(cylAt(barkMat, 0.12 * s, 0.2 * s, 1.6 * s, 0, 0.8 * s, 0, 8));
    for (const [r, h, y, mat] of [
      [1.5, 2.2, 1.6, pineMat], [1.1, 1.9, 3.0, pineMat], [0.7, 1.6, 4.3, snowWhite],
    ]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r * s, h * s, 10), mat);
      cone.position.y = y * s;
      cone.castShadow = true; cone.receiveShadow = true;
      g.add(cone);
    }
    group.add(g);
    pineGroups.push({ g, s });
    if (solid) addCollider(x, z, 0.3, 0.3, 6 * s);
  };
  pine(-27, -4, 1.1, false); pine(-28, 16, 1.3, false); pine(27, -16, 1.2, false);
  pine(28, 6, 1.3, false); pine(-6, -27, 1.1, false); pine(18, 27, 1.3, false); pine(-16, 27, 1.2, false);
  pine(-20.8, -16.8, 1.0, true); pine(20.8, 16.8, 1.0, true); pine(-20.8, 16.8, 1.1, true);

  // Cylindrical silos with domed tops, outside the east/west walls and
  // tall enough to read over them.
  const silo = (x, z, r, h) => {
    group.add(cylAt(steelMat, r, r, h, x, h / 2, z, 18));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), darkSteel);
    dome.position.set(x, h, z);
    dome.castShadow = true; dome.receiveShadow = true;
    group.add(dome);
    group.add(cylAt(darkSteel, r + 0.08, r + 0.08, 0.25, x, 0.12, z, 18)); // base ring
  };
  silo(25.5, -12, 1.8, 5.5);
  silo(25.5, 8, 1.5, 4.5);
  silo(-25.5, -2, 1.8, 5.5);

  // Pipes running along the perimeter wall crowns (above head height, on
  // the wall tops — no collider needed).
  const crownPipe = (x, z, len, alongZ) => {
    const p = cylAt(steelMat, 0.18, 0.18, len, x, 2.32, z, 10);
    if (alongZ) p.rotation.x = Math.PI / 2;
    else p.rotation.z = Math.PI / 2;
    group.add(p);
  };
  crownPipe(0, -18.6, 44, false);
  crownPipe(0, 18.6, 44, false);
  crownPipe(-22.6, 0, 36, true);
  crownPipe(22.6, 0, 36, true);

  // Sloped roofs on the two flat-roofed buildings (foundry + boiler
  // house). Triangle profile extruded along the ridge. Containers keep
  // their flat snow caps — a pitched roof on a shipping container would
  // read wrong, so there is no third roof.
  const prismRoof = (x, y, z, base, height, len) => {
    const shape = new THREE.Shape();
    shape.moveTo(-base / 2, 0);
    shape.lineTo(base / 2, 0);
    shape.lineTo(0, height);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
    const roof = new THREE.Mesh(geo, roofMat); // v3.5: warm non-metal roof (see roofMat)
    roof.rotation.y = -Math.PI / 2; // extrusion -> world X, shape X -> world Z
    roof.position.set(x + len / 2, y, z);
    roof.castShadow = true; roof.receiveShadow = true;
    group.add(roof);
  };
  prismRoof(15.2, 4.5, -12, 11.6, 2.4, 11.6); // foundry (v3.13: wider room)
  prismRoof(19.5, 4, 15, 5.4, 1.8, 6.4); // boiler house (v3.13: moved block)

  // Barrel clusters pressed against container faces (colliders hug the
  // existing container colliders — link-checked, no lane cut).
  const barrelCluster = (spots, seed) => {
    const bRnd = mulberry32(seed);
    for (const [x, z] of spots) {
      const barrel = cylAt(bRnd() < 0.5 ? steelMat : darkSteel, 0.32, 0.32, 0.85, x, 0.43, z, 12);
      group.add(barrel);
      group.add(cylAt(darkSteel, 0.33, 0.33, 0.06, x, 0.82, z, 12)); // rim
      addCollider(x, z, 0.32, 0.32, 0.85);
    }
  };
  barrelCluster([[-9.7, -9.62], [-8.9, -9.62], [-9.3, -10.15]], 3404); // container (-8,-8) north face
  barrelCluster([[3.62, -7.2], [3.62, -6.3], [3.62, -5.4]], 3405); // container (2,-6) east face
  barrelCluster([[5, -11.38], [6, -11.38], [7, -11.38]], 3406); // container (6,-13) south face
  barrelCluster([[8, 7.0]], 3407); // v3.5: burn barrel north face of container (8,10) — hugs its collider, no lane cut

  // --- Dry grass tufts poking through the snow (non-collidable) ------------------
  const rnd = mulberry32(2024);
  const grassGeo = new THREE.PlaneGeometry(0.2, 0.45); // v3.2: narrower + taller blades, less cardboard (was 0.34 x 0.3)
  for (let i = 0; i < 140; i++) { // Gemini realism pass: doubled tufts + rubble pebbles (was 70)
    const x = (rnd() - 0.5) * 42, z = (rnd() - 0.5) * 34;
    if (i % 3 === 0) {
      const pebble = new THREE.Mesh(new THREE.DodecahedronGeometry(0.05 + rnd() * 0.1, 0), rockMat);
      pebble.position.set(x, 0.02, z);
      pebble.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
      group.add(pebble);
    }
    const tuft = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const blade = new THREE.Mesh(grassGeo, grassMat);
      blade.position.y = 0.13;
      blade.rotation.y = (k / 3) * Math.PI;
      blade.rotation.x = (rnd() - 0.5) * 0.25;
      tuft.add(blade);
    }
    tuft.position.set(x, 0, z);
    group.add(tuft);
  }

  // --- Floodlight poles -----------------------------------------------------------
  for (const [x, z] of [[-10, -6], [8, 2], [-2, -14]]) {
    group.add(cylAt(darkSteel, 0.09, 0.12, 5.5, x, 2.75, z, 8));
    const head = boxAt(darkSteel, 0.7, 0.3, 0.4, x, 5.5, z);
    group.add(head);
    const lamp = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, 0.2),
      new THREE.MeshBasicMaterial({ color: 0xfff2dd }),
    );
    lamp.position.set(x, 5.42, z + 0.21);
    group.add(lamp);
    addCollider(x, z, 0.2, 0.2, 5.5);
  }

  // --- Mid-lane rubble: break up the flat snow --------------------------------
  // Small dark chunks + a few tilted rebar bars along the mid service road
  // (Gemini v3.3 re-review: the open snow reads as a flat test floor).
  // Seeded, non-collidable on purpose — they sit off the waypoint lanes
  // (z = ±2..5, never on the z = 0 / ±6 / ±12 lines bots walk).
  {
    const mRnd = mulberry32(777);
    for (let i = 0; i < 10; i++) {
      const rx = -14 + mRnd() * 28;
      const rz = (mRnd() < 0.5 ? -1 : 1) * (2 + mRnd() * 3);
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.12 + mRnd() * 0.22, 0), i % 2 ? rockMat : concMat);
      chunk.position.set(rx, 0.1, rz);
      chunk.rotation.set(mRnd() * Math.PI, mRnd() * Math.PI, mRnd() * Math.PI);
      chunk.castShadow = true; chunk.receiveShadow = true;
      group.add(chunk);
      if (i % 3 === 0) {
        const bar = cylAt(steelMat, 0.012, 0.012, 0.7 + mRnd() * 0.4, rx, 0.3, rz, 6);
        bar.rotation.set((mRnd() - 0.5) * 1.4, 0, (mRnd() - 0.5) * 1.4);
        group.add(bar);
      }
    }
  }

  // --- Site letters painted on the snow --------------------------------------------
  const letter = (ch, x, z) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: siteLetterTexture(ch), transparent: true, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.02, z);
    m.receiveShadow = true;
    group.add(m);
  };
  letter('A', SITES.A.center.x - 1, SITES.A.center.z + 1);
  letter('B', SITES.B.center.x - 1, SITES.B.center.z - 1);

  // --- Site sign boards: "SITE A — FOUNDRY" / "SITE B — CRANE YARD" ---------
  // Standing boards just off the west lane into each site, facing the Solara
  // spawn so attackers read them on approach. Off-lane (z = ∓15.5) and
  // collider-free on purpose: a collider here would sit on the bot waypoint
  // lane (8,∓12)-(13,∓12) and stall pushes.
  const sign = (key, x, z) => {
    const tex = siteSignTexture(key, SITES[key].name);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 1.35),
      new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4 }),
    );
    panel.position.set(x, 2.1, z);
    panel.rotation.y = -Math.PI / 2; // face west, toward the attackers
    panel.castShadow = true;
    group.add(panel);
    for (const dz of [-1.55, 1.55]) {
      group.add(boxAt(darkSteel, 0.12, 2.1, 0.12, x, 1.05, z + dz));
    }
  };
  sign('A', 10.5, -15.5);
  sign('B', 10.5, 15.5);

  scene.add(group);

  // --- Waypoints: lanes + site approaches -----------------------------------------
  // v3.13 fix (16 Nov, Node audit): 5 waypoints sat INSIDE colliders, so no
  // bot could ever stand on them and BFS routes through them were dead.
  // [-12,0] was on the sandbag wall -> [-12,-2] (south of the sandbags; the
  // [-12,2] detour landed inside the (-14,2) container). [8,-12] was inside
  // the (6,-13) container -> [8,-9] (north of it AND north of the (5,-11.4)
  // barrel that blocks the (2,-12)->(8,-10) line). [8,12] was inside the
  // (8,10) container -> [8,14] (south side). [0,6] was on the bonfire
  // woodpile -> [2,6]. [12,-6] was on the foundry east wall -> [12,-4]
  // (mid side; the wall has no gap there, so no north/mid junction).
  // [-4,-12] -> [-4,-15]: the (-6,-12) sandbag wall sits across the north
  // lane between (-10,-12) and (-4,-12); the lane jogs north around it.
  // REVERTED (16 Nov): (-4,-15) sits 0.05 m from a crate at (-4,-14) and
  // its (-4,-15)->(2,-12) line is blocked by a tree at (-2,-14). The
  // original (-4,-12) is a valid node (links to (2,-12) and (0,-6)); the
  // west/east north-lane join is done by the new bridge node (-2,-10)
  // below, which links (-10,-12), (2,-12) and (0,-6).
  const pts = [
    [-20, 0], [-16, 0], [-12, -2], [-8, 0], [-4, 0], [0, 0], [4, 0], [8, 0], [12, 0], [16, 0], [20, 0],
    [-16, -12], [-10, -12], [-4, -12], [2, -12], [8, -9], [13, -12], [17, -12],
    [-16, 12], [-10, 12], [-4, 12], [2, 12], [8, 14], [13, 12], [17, 12],
    [-12, -6], [-12, 6], [0, -6], [2, 6], [12, -4], [12, 6], [-2, -10],
    [15, -8], [15, 8], [19, -12], [19, 12],
  ];
  const waypoints = pts.map(([x, z]) => ({ x, z, links: [] }));
  for (let i = 0; i < waypoints.length; i++) {
    for (let j = i + 1; j < waypoints.length; j++) {
      const a = waypoints[i], b = waypoints[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 8.5 && !segmentBlocked(a.x, a.z, b.x, b.z, colliders)) {
        a.links.push(j); b.links.push(i);
      }
    }
  }

  return {
    group, colliders, waypoints, sites: SITES, spawns: SPAWNS,
    bounds: { minX: -MAP.halfW, maxX: MAP.halfW, minZ: -MAP.halfH, maxZ: MAP.halfH },
    // v3.7: replace the cone pines with clones of the CC0 pine GLB.
    // The GLB is ~7.3 m tall; the cone pines top out at ~5.1*s, so scale
    // 0.7*s matches the old silhouette. Rotation varies per tree.
    upgradePines(glbPine) {
      pineGroups.forEach(({ g, s }, i) => {
        g.clear();
        const tree = glbPine.clone();
        tree.scale.setScalar(0.7 * s);
        tree.rotation.y = (i * 1.7) % (Math.PI * 2);
        g.add(tree);
      });
    },
    fireSpots: [
      { pos: new THREE.Vector3(0, 0.4, 6), kind: 'bonfire' },
      { pos: new THREE.Vector3(3, 0.9, 3), kind: 'bonfire' }, // v3.2: burning barrel in mid
      { pos: new THREE.Vector3(18.2, 1.1, -14.6), kind: 'furnace' },
      // v3.5: burn barrels — two reuse existing barrel meshes/colliders, one
      // is the new barrel at (8,7). All hug container colliders; no lane cut.
      { pos: new THREE.Vector3(3.62, 0.9, -6.3), kind: 'barrel' },
      { pos: new THREE.Vector3(6, 0.9, -11.38), kind: 'barrel' },
      { pos: new THREE.Vector3(8, 0.9, 7.0), kind: 'barrel' },
      { pos: new THREE.Vector3(21, 7, 17.5), kind: 'chimney' }, // v3.13: follows the moved chimney
      { pos: new THREE.Vector3(15, 4.5, -12), kind: 'chimney' }, // v3.2: smoke column over the foundry
    ],
  };
}
