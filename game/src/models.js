// models.js — async loading of FREE CC0 GLB models (no account, no key, no credits).
//
// Rifle: "Assault Rifle" (SCAR-L) by Quaternius, Poly Pizza bundle
//   Ultimate-Guns-Pack, model page https://poly.pizza/m/Bgvuu4CUMV,
//   Licence field on the page: "CC0 1.0". File: assets/meshy/scar-l.glb.
// Pine: "Pine" by Quaternius, Poly Pizza Stylized-Nature-MegaKit bundle,
//   model page https://poly.pizza/m/rfnxJv0Rqa, Licence "CC0 1.0".
//   File: assets/meshy/pine.glb.
//
// The game always starts on its primitive builds and upgrades in place when
// a GLB arrives; a failed load resolves null and the primitive stays, so the
// game can never break for a missing model file.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { glovedHand } from './weapons.js';

const loader = new GLTFLoader();

// Normalize the SCAR-L rifle GLB into a viewmodel-ready group.
// The file's longest axis is X (barrel, ~5.17 m after the node's x100
// scale — Quaternius scale quirk; proportions are correct, so normalize by
// bounding box). Returns { group, muzzle } with the barrel pointing -Z
// (three.js camera forward) and a muzzle Object3D at the barrel tip.
export function normalizeRifle(gltf) {
  const inner = gltf.scene;
  const box = new THREE.Box3().setFromObject(inner);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  const s = 0.85 / size.x; // viewmodel rifle length, matches the primitive AR-77
  inner.scale.setScalar(s);
  inner.position.set(-center.x * s, -center.y * s, -center.z * s);
  const group = new THREE.Group();
  group.add(inner);
  group.rotation.y = Math.PI / 2; // +X (barrel) -> -Z (forward)
  // The source base colors are near-black (0.01–0.03) and read as a black
  // slab in daylight — brighten x12 + lift so the rifle reads as gunmetal
  // like the primitive did. Keep the relative shading between the 3 mats.
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false; o.receiveShadow = false;
      const m = o.material;
      if (m && m.isMeshStandardMaterial && m.color) {
        m.color.multiplyScalar(12).addScalar(0.05);
        m.color.r = Math.min(m.color.r, 0.9);
        m.color.g = Math.min(m.color.g, 0.9);
        m.color.b = Math.min(m.color.b, 0.9);
      }
    }
  });
  // Gloved hands, same spots as the primitive AR-77 (grip + foregrip),
  // so the rifle reads as held, not floating.
  group.add(glovedHand(0, -0.07, 0.15, 0.2));
  group.add(glovedHand(0.01, -0.06, -0.18, 0.08));
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0.02, -0.44);
  group.add(muzzle);
  return { group, muzzle };
}

// Normalize the Quaternius pine GLB: real-world scale already (~7.3 m tall),
// base shifted to y=0. The foliage texture is bright summer green — tint it
// darker so the tree sits in snow instead of clashing with it.
export function normalizePine(gltf) {
  const g = gltf.scene;
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      const m = o.material;
      if (m && m.isMeshStandardMaterial && m.color) {
        if (m.name === 'Leaves_Pine') m.color.setScalar(0.55);
        else m.color.multiplyScalar(0.8);
      }
    }
  });
  // Shift so the lowest point sits at y=0. The shift lives on the scene
  // child of a wrapper group, so clones scaled later keep the base exactly
  // on the ground (a shift on the scaled node itself would not scale).
  const box = new THREE.Box3().setFromObject(g);
  g.position.y -= box.min.y;
  const wrap = new THREE.Group();
  wrap.add(g);
  return wrap;
}

// Load the rifle and the pine separately. The rifle is tiny (134 KB, no
// textures, ~35 ms) so it loads at once; the pine is 2.2 MB with 2x1024^2
// PNGs, and its decode + texture upload stalls the main thread for seconds
// in SwiftShader — it must load late (frame 40 in main.js), never in the
// early move window. Each loader never rejects: a failed model resolves
// null and the caller keeps the primitive fallback.
export async function loadRifle() {
  try {
    return normalizeRifle(await loader.loadAsync('assets/meshy/scar-l.glb'));
  } catch { return null; }
}

export async function loadPine() {
  try {
    return normalizePine(await loader.loadAsync('assets/meshy/pine.glb'));
  } catch { return null; }
}

// Back-compat: load both in parallel (main.js uses the split fns instead).
export async function loadGameModels() {
  const [rifle, pine] = await Promise.all([loadRifle(), loadPine()]);
  return { rifle, pine };
}
