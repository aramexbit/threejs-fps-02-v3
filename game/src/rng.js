// rng.js — deterministic randomness for DUSTLINE.
// Every random choice in the game (map dressing, bot decisions, particles,
// textures) flows from a seed, so a ?seed=N run reproduces byte-for-byte.
// No Math.random() anywhere in game code: grep for it in review.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// PCG-style integer hash -> [0,1). Used by the tileable noise so textures
// wrap seamlessly at the edges (period = texture size in cells).
export function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 974634211) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

// Tileable value noise: coordinates wrap at `period` cells, so a texture
// repeated N times has no visible seam.
export function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const u = smooth(xf), v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, period, seed, octaves = 4) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * f, y * f, period * f, seed + o * 101);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

// Tileable Voronoi (cracks / cells): distance to nearest feature point in a
// wrapped grid. Returns {d1, d2} — nearest and second-nearest distances.
export function voronoi(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let d1 = 8, d2 = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ((xi + i) % period + period) % period;
      const cy = ((yi + j) % period + period) % period;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 7);
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return { d1: Math.sqrt(d1), d2: Math.sqrt(d2) };
}
