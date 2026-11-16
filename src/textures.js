// textures.js — procedural PBR textures for FROSTLINE (snowy industrial).
// Every texture is painted at runtime on a <canvas> from a fixed seed:
// no image files, no network, deterministic across runs. Each material gets
// albedo + a normal map (Sobel from a height field) + one ORM map packed as
// R=ambient occlusion, G=roughness, B=metalness — the channels three.js reads
// for aoMap (R), roughnessMap (G) and metalnessMap (B). Noise is tileable
// (rng.js vnoise/fbm/voronoi wrap at the period) so repeats have no seams.
// Edge wear is baked into the albedo: edges and low spots go darker / rustier.
import * as THREE from 'three';
import { fbm, hash2, mulberry32, vnoise, voronoi } from './rng.js';

// v3.7 HD pass: anisotropy starts at 4 (safe default) and main.js raises it
// to min(8, renderer max) once the renderer exists — the single biggest
// cheap win for grazing-angle sharpness on ground/containers. Textures are
// painted inside buildMap, which runs after the renderer is created, so
// the raised value applies to every texture.
let TEX_ANISO = 4;
export function setTextureAnisotropy(v) { TEX_ANISO = Math.max(1, Math.floor(v)); }

function cv(size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}
function tex(canvas, repeat = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = TEX_ANISO;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function texLinear(canvas, repeat = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = TEX_ANISO;
  return t; // data maps (normal / ORM) stay linear — never sRGB.
}

// Sobel normal map from a height field. strength ~ 1-3.
function normalCanvas(height, size, strength) {
  const c = cv(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const h = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Pack AO / roughness / metalness into one canvas: R=AO, G=rough, B=metal.
function ormCanvas(ao, rough, metal, size) {
  const c = cv(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    img.data[i * 4] = Math.round(ao[i] * 255);
    img.data[i * 4 + 1] = Math.round(rough[i] * 255);
    img.data[i * 4 + 2] = Math.round(metal[i] * 255);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Assemble one material's texture set from painted channels.
function pbrSet(albedo, height, ao, rough, metal, size, repeat) {
  const orm = ormCanvas(ao, rough, metal, size);
  return {
    map: tex(albedo, repeat),
    normalMap: texLinear(normalCanvas(height, size, 2.0), repeat),
    roughnessMap: texLinear(orm, repeat),
    metalnessMap: texLinear(orm, repeat),
    aoMap: texLinear(orm, repeat),
  };
}

// --- Snow ground ------------------------------------------------------------
// Wind-packed snow: soft FBM drifts + sparkle speckle + footprints (paired
// ovals wandering across the tile) + two tyre ruts down the service road +
// patches of dirty slush near the road. Repeats 6x6 over the 44 m map.
export function snowTextures(seed = 11, size = 512) {
  const albedo = cv(size), g = albedo.getContext('2d');
  const img = g.createImageData(size, size);
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  const rnd = mulberry32(seed);
  const sparkles = [];
  for (let i = 0; i < 700; i++) sparkles.push([rnd() * size, rnd() * size]);
  // Footprint trails: 3 wandering trails of paired ovals.
  const trails = [];
  for (let t = 0; t < 3; t++) {
    let x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI * 2;
    const pts = [];
    for (let s = 0; s < 26; s++) {
      a += (rnd() - 0.5) * 0.7;
      x += Math.cos(a) * 9; y += Math.sin(a) * 9;
      pts.push([x, y, a]);
    }
    trails.push(pts);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      const drift = fbm(u * 5, v * 5, 5, seed, 4);
      const fine = vnoise(u * 48, v * 48, 48, seed + 3);
      const dirt = fbm(u * 3 + 9, v * 3, 3, seed + 5, 3);
      // v3.4: soft large-scale mottling (wind-blown grey-blue patches) so
      // the snow is not one flat white sheet. ±7 shade, snow stays bright.
      const blotch = fbm(u * 2 + 31, v * 2 + 17, 2, seed + 9, 3);
      // Two tyre ruts running vertically (the service road), packed + dirty.
      const rut = Math.max(0, 1 - Math.abs(u - 0.30) / 0.04) + Math.max(0, 1 - Math.abs(u - 0.70) / 0.04);
      const shade = 232 + drift * 20 + fine * 8 - dirt * 26 - rut * 55 + (blotch - 0.5) * 14;
      img.data[i * 4] = shade;
      img.data[i * 4 + 1] = shade + 2;
      img.data[i * 4 + 2] = Math.min(255, shade + 8 - dirt * 6 + (blotch - 0.5) * 10);
      img.data[i * 4 + 3] = 255;
      height[i] = drift * 0.5 + fine * 0.2 - rut * 0.18 + (blotch - 0.5) * 0.06;
      ao[i] = 0.86 + drift * 0.14 - rut * 0.18;
      rough[i] = 0.9; metal[i] = 0.0;
    }
  }
  g.putImageData(img, 0, 0);
  // Sparkle glints: white in the albedo AND polished metal in the ORM,
  // so they catch the sun and glint as the camera moves (Gemini realism pass).
  g.fillStyle = 'rgba(255,255,255,1.0)';
  for (const [px, py] of sparkles) {
    g.fillRect(px, py, 1.2, 1.2);
    const idx = Math.floor(py) * size + Math.floor(px);
    if (idx >= 0 && idx < size * size) {
      rough[idx] = 0.1;
      metal[idx] = 1.0;
    }
  }
  // Footprints: dark blue-grey ovals, slightly offset pairs.
  for (const pts of trails) {
    for (const [px, py, a] of pts) {
      g.fillStyle = 'rgba(150,168,188,0.5)';
      for (const off of [-4, 4]) {
        g.beginPath();
        g.ellipse(px + Math.cos(a + 1.57) * off, py + Math.sin(a + 1.57) * off, 3.2, 5.2, a, 0, 7);
        g.fill();
      }
    }
  }
  return pbrSet(albedo, height, ao, rough, metal, size, 6);
}

// --- Snow-capped rock --------------------------------------------------------
export function rockTextures(seed = 83, size = 256) {
  const albedo = cv(size), g = albedo.getContext('2d');
  const img = g.createImageData(size, size);
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      const n = fbm(u * 5, v * 5, 5, seed, 4);
      const snowCap = Math.max(0, n - 0.55) * 2.4; // high spots hold snow
      const tone = 96 + n * 52;
      const r = tone * (1 - snowCap) + 235 * snowCap;
      const gg = tone * 0.94 * (1 - snowCap) + 238 * snowCap;
      const b = tone * 0.84 * (1 - snowCap) + 244 * snowCap;
      img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
      height[i] = n; ao[i] = 0.78 + n * 0.2; rough[i] = 0.95 - snowCap * 0.1; metal[i] = 0;
    }
  }
  g.putImageData(img, 0, 0);
  return pbrSet(albedo, height, ao, rough, metal, size, 1);
}

// --- Concrete (industrial walls, pads) — cold, stained ----------------------
// v3.7: 256 -> 512 (most visible wall surface; the extra paint time is ~1 s).
export function concreteTextures(seed = 23, size = 512) {
  const albedo = cv(size), g = albedo.getContext('2d');
  const img = g.createImageData(size, size);
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      const stain = fbm(u * 4, v * 4, 4, seed, 4);
      const fine = vnoise(u * 32, v * 32, 32, seed + 2);
      const vor = voronoi(u * 7, v * 7, 7, seed + 4);
      const crack = Math.max(0, 1 - Math.abs(vor.d2 - vor.d1) * 22);
      const edge = Math.min(u, 1 - u, v, 1 - v); // 0 at border -> worn edge
      const wear = Math.max(0, 1 - edge / 0.12);
      const snow = Math.max(0, 1 - edge / 0.2) * 0.25; // dusting near edges
      const base = 138 + stain * 36 + fine * 18 - crack * 64 - wear * 40;
      img.data[i * 4] = base * (1 - snow) + 235 * snow;
      img.data[i * 4 + 1] = base * 0.94 * (1 - snow) + 238 * snow;
      img.data[i * 4 + 2] = base * 0.86 * (1 - snow) + 244 * snow;
      img.data[i * 4 + 3] = 255;
      height[i] = stain * 0.35 + fine * 0.2 - crack * 0.25;
      ao[i] = 0.78 + stain * 0.2 - wear * 0.25;
      rough[i] = 0.92; metal[i] = 0.0;
    }
  }
  g.putImageData(img, 0, 0);
  return pbrSet(albedo, height, ao, rough, metal, size, 2);
}

// --- Rusted container steel ---------------------------------------------------
// Corrugated ribs (vertical stripes in height) + rust blooms + paint worn
// to bare metal on the ribs' crests. `tint` picks the container's paint.
// v3.7: 256 -> 512 (the biggest visible surface in the game).
export function containerTextures(tint = [158, 62, 44], seed = 37, size = 512) {
  const albedo = cv(size), g = albedo.getContext('2d');
  const img = g.createImageData(size, size);
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      const rib = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 16); // corrugation
      const rust = fbm(u * 5, v * 6, 5, seed, 3);
      const rustBloom = Math.max(0, rust - 0.58) * 2.2;
      // v3.5: vertical rust streaks running down the ribs — fast noise in u,
      // slow in v, so the drips read as vertical. Stronger than the bloom
      // so containers stop looking flat-painted in the low sunset light.
      const streak = vnoise(u * 48, v * 4, 48, seed + 7);
      const drip = Math.max(0, streak - 0.60) * 2.4;
      const rustAmt = Math.min(1, rustBloom + drip * 0.7);
      const edge = Math.min(u, 1 - u, v, 1 - v);
      const wear = Math.max(0, 1 - edge / 0.1);
      const crest = rib > 0.85 ? 0.25 : 0; // paint rubbed off the crests
      let r = tint[0] * (1 - rustAmt) + 122 * rustAmt;
      let gg = tint[1] * (1 - rustAmt) + 74 * rustAmt;
      let b = tint[2] * (1 - rustAmt) + 40 * rustAmt;
      r = r * (1 - crest) + 150 * crest;
      gg = gg * (1 - crest) + 152 * crest;
      b = b * (1 - crest) + 155 * crest;
      const shade = 0.82 + rib * 0.28 - wear * 0.3;
      img.data[i * 4] = r * shade; img.data[i * 4 + 1] = gg * shade; img.data[i * 4 + 2] = b * shade; img.data[i * 4 + 3] = 255;
      height[i] = rib * 0.5 + rust * 0.15;
      ao[i] = 0.8 + rib * 0.1 - wear * 0.2;
      rough[i] = 0.55 + rustAmt * 0.35; metal[i] = 0.7 - rustAmt * 0.5;
    }
  }
  g.putImageData(img, 0, 0);
  return pbrSet(albedo, height, ao, rough, metal, size, 1);
}

// --- Wood (crates, barricades, firewood) --------------------------------------
// v3.7: 256 -> 512 (crates are the most-handled prop surface).
export function woodTextures(seed = 51, size = 512) {
  const albedo = cv(size), g = albedo.getContext('2d');
  const img = g.createImageData(size, size);
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  const PLANKS = 4, ph = size / PLANKS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      const plank = Math.floor(y / ph);
      const grain = vnoise(u * 24, plank * 3.7 + v * 2, 24, seed + plank);
      const gap = Math.abs((y % ph)) < 1.5 || Math.abs((y % ph) - ph) < 1.5;
      const edge = Math.min(u, 1 - u, v, 1 - v);
      const wear = Math.max(0, 1 - edge / 0.08);
      const tone = 118 + grain * 42 - wear * 30 - (gap ? 55 : 0);
      img.data[i * 4] = tone; img.data[i * 4 + 1] = tone * 0.72; img.data[i * 4 + 2] = tone * 0.46; img.data[i * 4 + 3] = 255;
      height[i] = grain * 0.3 - (gap ? 0.3 : 0);
      ao[i] = 0.8 - wear * 0.2; rough[i] = 0.85; metal[i] = 0.0;
    }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#3a3a3a';
  for (const [bx, by] of [[14, 14], [size - 14, 14], [14, size - 14], [size - 14, size - 14]]) {
    g.beginPath(); g.arc(bx, by, 5, 0, 7); g.fill();
  }
  return pbrSet(albedo, height, ao, rough, metal, size, 1);
}

// --- Sandbag (woven sacking, stitched seams) ----------------------------------
export function sandbagTextures(seed = 71, size = 256) {
  const albedo = cv(size), g = albedo.getContext('2d');
  const img = g.createImageData(size, size);
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      const weave = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 32) * Math.sin(v * Math.PI * 2 * 32);
      const stain = fbm(u * 4, v * 4, 4, seed, 3);
      const tone = 148 + weave * 22 + stain * 30 - 14;
      img.data[i * 4] = tone; img.data[i * 4 + 1] = tone * 0.88; img.data[i * 4 + 2] = tone * 0.68; img.data[i * 4 + 3] = 255;
      height[i] = weave * 0.25 + stain * 0.2;
      ao[i] = 0.82; rough[i] = 0.96; metal[i] = 0;
    }
  }
  g.putImageData(img, 0, 0);
  return pbrSet(albedo, height, ao, rough, metal, size, 1);
}

// --- Hazard barrier (painted metal + yellow/black chevrons + rust) -------------
export function hazardTextures(seed = 67, size = 256) {
  const albedo = cv(size), g = albedo.getContext('2d');
  const img = g.createImageData(size, size);
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      const band = v > 0.32 && v < 0.62;
      const diag = ((x + y) / 28) % 2 < 1;
      const rust = fbm(u * 5, v * 9, 5, seed, 3);
      const streak = vnoise(u * 40, v * 6, 40, seed + 11) * (v > 0.6 ? 1 : 0.3);
      let r, gg, b, ro = 0.6, me = 0.55;
      if (band && diag) { r = 232; gg = 178; b = 32; ro = 0.55; }
      else if (band) { r = 28; gg = 26; b = 24; ro = 0.6; }
      else { r = 96 + rust * 30; gg = 88 + rust * 26; b = 78 + rust * 20; ro = 0.7; me = 0.6; }
      const rustTint = Math.max(0, rust - 0.55) * 2 + streak * 0.25;
      r = r * (1 - rustTint * 0.4) + 122 * rustTint * 0.4;
      gg = gg * (1 - rustTint * 0.4) + 74 * rustTint * 0.4;
      b = b * (1 - rustTint * 0.4) + 40 * rustTint * 0.4;
      img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
      height[i] = 0.15 + rust * 0.2; ao[i] = 0.85; rough[i] = ro; metal[i] = me;
    }
  }
  g.putImageData(img, 0, 0);
  return pbrSet(albedo, height, ao, rough, metal, size, 1);
}

// --- Painted site letter (A / B) on the snow -----------------------------------
// Transparent canvas, drawn once, laid flat as a decal plane on the snow.
export function siteLetterTexture(letter) {
  const size = 256;
  const c = cv(size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.font = 'bold 190px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(30,40,52,0.8)';
  g.fillText(letter, size / 2, size / 2 + 8);
  // Worn paint: erase speckles.
  const rnd = mulberry32(letter === 'A' ? 5 : 9);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    g.beginPath();
    g.arc(rnd() * size, rnd() * size, 1 + rnd() * 4, 0, 7);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = TEX_ANISO;
  return t;
}

// --- Metal grate walkway (v3.16 Phase 3a, reference-style) -----------------
// Dark steel plate with a grid of bars; the holes read near-black and the
// bar edges catch light. Used flat on the mid service road.
export function grateTextures(seed = 97, size = 256, repeat = 1) {
  const albedo = cv(size), g = albedo.getContext('2d');
  g.fillStyle = '#2b3036'; g.fillRect(0, 0, size, size);
  const cell = 32;
  const rnd = mulberry32(seed);
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      g.fillStyle = '#101316';
      g.fillRect(x + 4, y + 4, cell - 8, cell - 8);
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(x, y, cell, 2); g.fillRect(x, y, 2, cell);
      const rust = rnd();
      if (rust > 0.6) {
        g.fillStyle = `rgba(122,74,40,${(rust - 0.6) * 0.9})`;
        g.fillRect(x + 2, y + 2, cell - 4, 3);
      }
    }
  }
  g.fillStyle = 'rgba(232,237,242,0.25)';
  for (let i = 0; i < 40; i++) g.fillRect(rnd() * size, rnd() * size, 2 + rnd() * 5, 2 + rnd() * 3);
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const hole = (x % cell > 4 && x % cell < cell - 4 && y % cell > 4 && y % cell < cell - 4);
      height[i] = hole ? 0 : 0.4; ao[i] = hole ? 0.5 : 0.9; rough[i] = 0.55; metal[i] = hole ? 0.2 : 0.8;
    }
  }
  return pbrSet(albedo, height, ao, rough, metal, size, repeat);
}

// --- Big wall sign (v3.16 Phase 3a): dark steel plate, huge text, orange rule.
export function wallSignTexture(line1, line2 = '') {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#23262b'; g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = '#4a5568'; g.lineWidth = 6; g.strokeRect(6, 6, 1012, 244);
  g.fillStyle = '#ff7a2f'; g.fillRect(40, 196, 220, 10);
  g.fillStyle = '#eef2f6';
  g.font = 'bold 96px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(line1, 40, line2 ? 100 : 128);
  if (line2) {
    g.fillStyle = '#9aa8b8';
    g.font = 'bold 52px system-ui, sans-serif';
    g.fillText(line2, 40, 196);
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = TEX_ANISO;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Site sign board: dark steel plate, hazard stripe top, big site letter +
// site name ("SITE A — FOUNDRY"). Canvas 512x192, used on a double-sided
// plane mounted on two posts at each site entrance.
export function siteSignTexture(letter, name) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = '#23262b';
  g.fillRect(0, 0, 512, 192);
  // Hazard stripe along the top edge.
  g.save();
  g.beginPath(); g.rect(0, 0, 512, 26); g.clip();
  for (let x = -26; x < 512; x += 52) {
    g.fillStyle = '#ffb347';
    g.beginPath();
    g.moveTo(x, 26); g.lineTo(x + 26, 0); g.lineTo(x + 52, 0); g.lineTo(x + 26, 26);
    g.closePath(); g.fill();
  }
  g.restore();
  g.strokeStyle = '#4a5568'; g.lineWidth = 4;
  g.strokeRect(3, 3, 506, 186);
  g.fillStyle = letter === 'A' ? '#ff7a2f' : '#6fc3d8';
  g.font = 'bold 92px system-ui, sans-serif';
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(letter, 28, 112);
  g.fillStyle = '#eef2f6';
  g.font = 'bold 44px system-ui, sans-serif';
  g.fillText(`SITE ${letter}`, 118, 82);
  g.fillStyle = '#9aa8b8';
  g.font = 'bold 30px system-ui, sans-serif';
  g.fillText(name.toUpperCase(), 118, 132);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = TEX_ANISO;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
