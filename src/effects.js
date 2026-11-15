// effects.js — deterministic visual effects for FROSTLINE.
// Everything here runs on the fixed-step sim clock with a seeded RNG:
// muzzle flash + smoke, impact sparks/debris, pooled bullet decals, ambient
// snowfall, bonfire flames with a flickering point light, thick chimney/bonfire
// smoke, and the bomb explosion. No per-frame allocations in the hot loop —
// particle buffers and decal meshes are pooled and reused.
import * as THREE from 'three';
import { mulberry32 } from './rng.js';

function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// --- Pooled point particles ------------------------------------------------------
// One THREE.Points draw call; each particle has position/velocity/life/color
// in preallocated Float32Arrays. Dead particles sit at y=-999.
export class ParticleSystem {
  constructor(scene, max = 600, size = 0.14) {
    this.max = max;
    this.active = max; // v3.10: live budget for the Low quality tier
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.head = 0;
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -999;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.mat = new THREE.PointsMaterial({
      size, vertexColors: true, transparent: true, opacity: 0.9,
      map: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
      depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.rnd = mulberry32(777);
  }
  // v3.10: shrink the live pool for the Low quality tier (or restore it).
  // Slots above the budget keep y=-999 until the budget grows again.
  setBudget(n) {
    this.active = Math.max(50, Math.min(this.max, n | 0));
    this.head = this.head % this.active;
  }
  spawn(x, y, z, vx, vy, vz, life, r, g, b, grav = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.active;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.life[i] = life; this.maxLife[i] = life; this.grav[i] = grav;
  }
  burst(p, n, speed, life, color, up = 0.5, grav = -4) {
    for (let k = 0; k < n; k++) {
      const a = this.rnd() * Math.PI * 2;
      const e = (this.rnd() - 0.3) * Math.PI;
      const s = speed * (0.4 + this.rnd() * 0.6);
      this.spawn(
        p.x, p.y, p.z,
        Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + up, Math.sin(a) * Math.cos(e) * s,
        life * (0.6 + this.rnd() * 0.7), color[0], color[1], color[2], grav,
      );
    }
  }
  smoke(p, n, spread, rise, life) {
    for (let k = 0; k < n; k++) {
      this.spawn(
        p.x + (this.rnd() - 0.5) * spread, p.y + this.rnd() * 0.3, p.z + (this.rnd() - 0.5) * spread,
        (this.rnd() - 0.5) * 0.4, rise * (0.7 + this.rnd() * 0.6), (this.rnd() - 0.5) * 0.4,
        life, 0.45, 0.45, 0.48, 0.6,
      );
    }
  }
  update(dt) {
    for (let i = 0; i < this.active; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -999; continue; }
      this.vel[i * 3 + 1] += this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const f = this.life[i] / this.maxLife[i];
      this.col[i * 3] *= 0.985 + f * 0.01;
      this.col[i * 3 + 1] *= 0.985 + f * 0.01;
      this.col[i * 3 + 2] *= 0.985 + f * 0.01;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

// --- Muzzle flash: sprite + short point light at the barrel tip ------------------
// v3.8 action pass: a 4-point starburst (drawn on canvas) at 2x the old
// scale, with a stronger light — the flash must read clearly in screenshots
// without blocking the player's view (it lives 0.12 s, a normal FPS flicker).
function starTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64);
  const grad = g.createRadialGradient(0, 0, 2, 0, 0, 60);
  grad.addColorStop(0, 'rgba(255,242,205,1)');
  grad.addColorStop(0.25, 'rgba(255,205,95,0.95)');
  grad.addColorStop(0.6, 'rgba(255,125,30,0.55)');
  grad.addColorStop(1, 'rgba(255,80,10,0)');
  g.fillStyle = grad;
  const spike = (angle, len, w) => {
    g.save();
    g.rotate(angle);
    g.beginPath();
    g.moveTo(0, -w);
    g.lineTo(len, 0);
    g.lineTo(0, w);
    g.closePath();
    g.fill();
    g.restore();
  };
  for (let i = 0; i < 4; i++) spike((i * Math.PI) / 2, 62, 7);
  for (let i = 0; i < 4; i++) spike((i * Math.PI) / 2 + Math.PI / 4, 34, 5);
  g.beginPath(); g.arc(0, 0, 16, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
}

export class MuzzleFlash {
  constructor(scene) {
    const t = starTexture();
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: t, color: 0xffc46a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.sprite.scale.set(0.85, 0.85, 1);
    this.sprite.visible = false;
    scene.add(this.sprite);
    this.light = new THREE.PointLight(0xffb347, 0, 9, 1.8);
    scene.add(this.light);
    this.t = 0;
  }
  fire(worldPos) {
    this.sprite.position.copy(worldPos);
    this.sprite.visible = true;
    this.sprite.scale.set(0.85, 0.85, 1);
    this.light.position.copy(worldPos);
    this.light.intensity = 30;
    this.t = 0.12;
  }
  update(dt) {
    if (this.t <= 0) return;
    this.t -= dt;
    if (this.t <= 0) {
      this.sprite.visible = false;
      this.light.intensity = 0;
    } else {
      this.light.intensity = 30 * (this.t / 0.12);
    }
  }
}

// --- Pooled bullet decals: small dark quads at impact points, fading -------------
export class DecalPool {
  constructor(scene, max = 40) {
    this.max = max;
    this.items = [];
    const t = radialTexture('rgba(40,36,30,0.9)', 'rgba(40,36,30,0)');
    for (let i = 0; i < max; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.22),
        new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0 }),
      );
      m.visible = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0 });
    }
    this.head = 0;
  }
  add(p, normal) {
    const d = this.items[this.head];
    this.head = (this.head + 1) % this.max;
    d.mesh.position.copy(p).addScaledVector(normal, 0.012);
    d.mesh.lookAt(p.clone().add(normal));
    d.mesh.visible = true;
    d.mesh.material.opacity = 0.85;
    d.life = 14; // seconds before fading out
  }
  update(dt) {
    for (const d of this.items) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life < 3) d.mesh.material.opacity = Math.max(0, d.life / 3) * 0.85;
      if (d.life <= 0) d.mesh.visible = false;
    }
  }
}

// --- Fire: flame sprites + flickering orange point light + smoke ------------------
export class Fire {
  constructor(scene, pos, scale = 1) {
    this.pos = pos.clone();
    this.scale = scale;
    this.t = 0;
    this.rnd = mulberry32(Math.round(pos.x * 31 + pos.z * 17) + 5);
    const t = radialTexture('rgba(255,190,90,1)', 'rgba(255,80,10,0)');
    this.flames = [];
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: t, color: i === 0 ? 0xffd27a : 0xff7a2f, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9,
      }));
      s.position.copy(pos);
      s.position.y += 0.25 + i * 0.3;
      s.scale.set(0.9 * scale, 1.3 * scale, 1);
      scene.add(s);
      this.flames.push(s);
    }
    // v3.6 day: fires are small daytime fires, not the dominant warm
    // light — the point light is a local warm pool at the barrel (was
    // 12/distance 15 in v3.5, which washed mid-field red when five summed).
    this.light = new THREE.PointLight(0xff7a20, 6, 10, 1.5);
    this.light.position.copy(pos);
    this.light.position.y += 0.8;
    scene.add(this.light);
    this.smokeTimer = 0;
  }
  update(dt, particles) {
    this.t += dt;
    // Flicker: sum of two sines, deterministic.
    const f = 0.75 + 0.25 * Math.sin(this.t * 11.3) * Math.sin(this.t * 5.1 + 1.7);
    this.light.intensity = 5 * this.scale * f; // v3.6 day: was 9 — small daytime fires only
    for (let i = 0; i < this.flames.length; i++) {
      const s = this.flames[i];
      const w = (0.75 + 0.3 * Math.sin(this.t * 9 + i * 2.1)) * this.scale;
      s.scale.set(w, (1.15 + 0.35 * Math.sin(this.t * 13 + i)) * this.scale, 1);
      s.material.opacity = 0.65 + 0.3 * f;
    }
    this.smokeTimer += dt;
    if (this.smokeTimer > 0.07) { // Gemini realism pass: thicker smoke, more often (was 0.12 / 1 particle)
      this.smokeTimer = 0;
      particles.smoke(
        new THREE.Vector3(this.pos.x, this.pos.y + 1.2 * this.scale, this.pos.z),
        2, 0.6, 1.6, 5,
      );
    }
  }
}

// --- Chimney smoke: steady thick column --------------------------------------------
export class ChimneySmoke {
  constructor(scene, pos) {
    this.pos = pos.clone();
    this.timer = 0;
  }
  update(dt, particles) {
    this.timer += dt;
    if (this.timer > 0.09) {
      this.timer = 0;
      particles.smoke(this.pos, 1, 0.4, 1.8, 6);
    }
  }
}

// --- Snowfall: seeded points drifting down, wrapping in a box around origin ------
export class Snowfall {
  constructor(scene, count = 900, area = 60) {
    this.count = count;
    this.drawCount = count; // v3.10: live budget for the Low quality tier
    this.area = area;
    this.pos = new Float32Array(count * 3);
    this.seed = new Float32Array(count * 2);
    const rnd = mulberry32(4242);
    for (let i = 0; i < count; i++) {
      this.pos[i * 3] = (rnd() - 0.5) * area;
      this.pos[i * 3 + 1] = rnd() * 22;
      this.pos[i * 3 + 2] = (rnd() - 0.5) * area;
      this.seed[i * 2] = rnd() * Math.PI * 2;
      this.seed[i * 2 + 1] = 0.4 + rnd() * 0.8; // fall speed
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.09, transparent: true, opacity: 0.85,
      map: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
      depthWrite: false, sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  // v3.10: draw only the first n flakes (Low tier). Positions keep updating
  // for the hidden ones, so restoring the budget is seamless.
  setBudget(n) {
    this.drawCount = Math.max(50, Math.min(this.count, n | 0));
    this.points.geometry.setDrawRange(0, this.drawCount);
  }
  update(dt, t, cx, cz) {
    for (let i = 0; i < this.drawCount; i++) {
      this.pos[i * 3 + 1] -= this.seed[i * 2 + 1] * dt;
      this.pos[i * 3] += Math.sin(t * 0.7 + this.seed[i * 2]) * dt * 0.35;
      if (this.pos[i * 3 + 1] < 0) this.pos[i * 3 + 1] = 20 + (this.seed[i * 2] % 2);
      // Keep the flurry centred on the camera.
      const dx = this.pos[i * 3] - cx, dz = this.pos[i * 3 + 2] - cz;
      if (dx > 30) this.pos[i * 3] -= 60; else if (dx < -30) this.pos[i * 3] += 60;
      if (dz > 30) this.pos[i * 3 + 2] -= 60; else if (dz < -30) this.pos[i * 3 + 2] += 60;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// --- Tracers: pooled thin additive streaks, muzzle -> impact ----------------
// One stretched box per shot, oriented along the shot line.
// v3.10 (Grok, confirmed by the user): the old 0.08 s life at 0.02 m thick
// was nearly invisible — a tracer that lives 0.30 s at 0.045 m thick reads
// as a real streak instead of a flicker.
export class TracerPool {
  constructor(scene, max = 20) {
    this.max = max;
    this.items = [];
    this.life = 0.30;
    const geo = new THREE.BoxGeometry(0.045, 0.045, 1);
    for (let i = 0; i < max; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xfff0aa, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0 });
    }
    this.head = 0;
  }
  spawn(start, end) {
    const d = this.items[this.head];
    this.head = (this.head + 1) % this.max;
    d.mesh.position.copy(start).add(end).multiplyScalar(0.5);
    d.mesh.lookAt(end);
    d.mesh.scale.set(1, 1, start.distanceTo(end));
    d.mesh.visible = true;
    d.mesh.material.opacity = 1.0;
    d.life = this.life;
  }
  update(dt) {
    for (const d of this.items) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.mesh.material.opacity = Math.max(0, d.life / this.life);
      if (d.life <= 0) d.mesh.visible = false;
    }
  }
}

// --- Bomb explosion: flash + fireball + smoke + camera shake impulse ---------------
export class Explosion {
  constructor(scene, particles) {
    this.particles = particles;
    this.light = new THREE.PointLight(0xff9a3c, 0, 40, 1.5);
    scene.add(this.light);
    this.t = 0;
  }
  trigger(p) {
    this.light.position.copy(p);
    this.light.position.y += 1;
    this.light.intensity = 220;
    this.t = 0.6;
    this.particles.burst(p, 60, 9, 0.9, [1, 0.55, 0.15], 2.5, -6);
    this.particles.burst(p, 30, 4, 1.6, [0.4, 0.4, 0.42], 3.5, 1.2);
    this.particles.smoke(new THREE.Vector3(p.x, p.y + 1, p.z), 14, 2.5, 2.2, 5);
  }
  update(dt) {
    if (this.t <= 0) return;
    this.t -= dt;
    this.light.intensity = Math.max(0, 220 * (this.t / 0.6));
  }
}
