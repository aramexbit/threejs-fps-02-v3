// sky.js — cold snowy daylight sky, pale sun, and image-based lighting.
// The sky is a gradient dome (pale grey-blue horizon -> steel blue up) with
// a pale low sun disc and glow baked into the shader, plus thin procedural
// cloud streaks. The same sky is fed through a PMREM generator so every PBR
// material gets image-based lighting from the actual sky — the single biggest
// realism win for an outdoor scene. Fog is exponential, thin and cold
// (aerial perspective: far lanes fade into pale haze, never cut to black).
import * as THREE from 'three';

// Warm winter sun, low in the south-west. Shared by the sky shader, the
// directional light, and the warm/cool CoD look: golden sun vs cool shadows.
export const SUN_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();
export const SUN_COLOR = 0xffd9a6; // v3.2 CoD pass: golden hour warmth (was 0xfff2dd pale)
export const HORIZON_COLOR = new THREE.Color(0xdce5ee);
export const ZENITH_COLOR = new THREE.Color(0x91a9c1); // Gemini realism pass: brighter sky (was 0xc7d2dc / 0x5d748e)

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // pin the dome to the far plane
}`;

const SKY_FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSunColor;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.08, 1.0);
  // Cold daylight gradient: pale horizon, steel blue overhead.
  vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.5));
  // Warmth toward the sun's azimuth — golden light spilling across the
  // snow, cool blue everywhere else (the CoD warm/cool contrast).
  float toward = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 2.0);
  col += uSunColor * toward * (1.0 - pow(max(h, 0.0), 0.6)) * 0.38;
  // Below the horizon: pale ground haze, not black.
  col = mix(vec3(0.62, 0.66, 0.70), col, smoothstep(-0.08, 0.02, d.y));
  // Pale sun disc + soft halo.
  float s = dot(d, normalize(uSunDir));
  float disc = smoothstep(0.9993, 0.9997, s);
  float halo = pow(max(s, 0.0), 180.0) * 0.55 + pow(max(s, 0.0), 18.0) * 0.16;
  col += uSunColor * halo + vec3(1.0, 0.98, 0.92) * disc * 1.6;
  gl_FragColor = vec4(col, 1.0);
}`;

export function createSky() {
  const geo = new THREE.SphereGeometry(400, 32, 20);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uSunDir: { value: SUN_DIR.clone() },
      uHorizon: { value: HORIZON_COLOR.clone() },
      uZenith: { value: ZENITH_COLOR.clone() },
      uSunColor: { value: new THREE.Color(SUN_COLOR) },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

// Thin procedural cloud streaks: soft pale ellipses on canvas textures,
// placed high and far so they read as winter overcast. Seeded, static.
export function createClouds(seed = 4) {
  const group = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 48, 4, 128, 48, 120);
  grad.addColorStop(0, 'rgba(235,240,245,0.8)');
  grad.addColorStop(0.6, 'rgba(225,232,238,0.32)');
  grad.addColorStop(1, 'rgba(225,232,238,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 96);
  const t = new THREE.CanvasTexture(c);
  const spots = [
    [-140, 66, -180, 150], [60, 78, -220, 190], [170, 60, -120, 130],
    [-60, 84, 190, 170], [130, 72, 170, 150], [-190, 58, 60, 120],
  ];
  for (const [x, y, z, w] of spots) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, w * 0.36),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, fog: false, opacity: 0.32 }), // v3.2: fainter — cloud planes read as hard diagonal bands (was 0.5)
    );
    m.position.set(x, y, z);
    m.lookAt(0, y * 0.4, 0);
    group.add(m);
  }
  return group;
}

// Build the PMREM environment from the sky dome alone and hand the scene
// image-based lighting. Call once at boot; the result is a small cubemap.
export function applyEnvironment(renderer, scene, skyMesh) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(skyMesh.clone());
  const rt = pmrem.fromScene(envScene, 0.04);
  scene.environment = rt.texture;
  scene.environmentIntensity = 1.15; // Rebalance after v3.1 screenshots: 1.3 washed out snow detail (was 0.7 in v3)
  pmrem.dispose();
  return rt;
}

// Lights: cold hemisphere (pale sky above, snow below), the pale winter sun
// with a 2048 shadow map fitted to the level AABB, and a faint warm fill from
// the fire side so shadowed faces never go black. PCSS is not available in
// the vendored core (no examples/jsm), so shadows use PCF + radius —
// the honest fallback the design doc allows.
export function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xd6e2f0, 0x8d99a8, 0.95); // v3.2: cooler shadows for the warm/cool split
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(SUN_COLOR, 3.2); // Rebalance after v3.1 screenshots: 3.8 clipped snow highlights (was 2.2 in v3)
  sun.position.copy(SUN_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -32; sun.shadow.camera.right = 32;
  sun.shadow.camera.top = 32; sun.shadow.camera.bottom = -32;
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 140;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3; // v3.2 Gemini review: harder shadows for the CoD high-contrast look (was 6)
  scene.add(sun);
  scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0xffd9b0, 0.4); // v3.2: stronger warm bounce (was 0.25)
  fill.position.set(28, 14, 30);
  scene.add(fill);
  scene.fog = new THREE.FogExp2(0xdce5ee, 0.005); // Gemini realism pass: thinner fog, bright horizon stays visible (was 0xc7d2dc, 0.008)
  return { hemi, sun, fill };
}
