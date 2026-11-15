// sky.js — bright daytime over the snow yard: pale blue horizon, deeper
// blue overhead, high white sun in the east-south-east, pale blue-white
// haze. v3.6 replaces the v3.5 sunset (orange horizon, purple dusk,
// low orange sun) — the snow goes back to white and the containers read
// in their blue/green/rust colours again instead of near-black silhouettes.
// The sky is a gradient dome with a high sun disc and glow baked into the
// shader, plus procedural cloud bands. The same sky is fed through a PMREM
// generator so every PBR material gets image-based lighting from the actual
// sky — the single biggest realism win for an outdoor scene. Fog is
// exponential, pale and thin (aerial perspective: far lanes fade into day
// haze, never cut to black).
import * as THREE from 'three';

// Day sun, high in the east-south-east — it sits in the play/start/end shots
// (all three look east) so the high sun disc + glow read in frame, and the
// crane + containers are lit from the front-side, not backlit like the
// sunset cut. Shared by the sky shader, the directional light, and the
// neutral day grade.
export const SUN_DIR = new THREE.Vector3(0.55, 0.75, 0.25).normalize();
export const SUN_COLOR = 0xfff3da; // v3.6 day: pale warm white (was 0xff9a3d deep orange)
export const HORIZON_COLOR = new THREE.Color(0xcfe2f2); // pale horizon blue
export const MID_COLOR = new THREE.Color(0x7fb0e2); // sky blue
export const ZENITH_COLOR = new THREE.Color(0x3a76c4); // deeper blue overhead

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
uniform vec3 uMid;
uniform vec3 uZenith;
uniform vec3 uSunColor;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.08, 1.0);
  // Day gradient, three stops: pale horizon blue -> sky blue ->
  // deeper blue overhead.
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, h));
  col = mix(col, uZenith, smoothstep(0.18, 0.65, h));
  // A whisper of warmth toward the sun's azimuth — just enough to keep
  // the sky from looking flat, far below the sunset's 0.45 spill.
  float toward = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 2.0);
  col += uSunColor * toward * (1.0 - pow(max(h, 0.0), 0.6)) * 0.12;
  // Below the horizon: pale blue-gray haze, not black.
  col = mix(vec3(0.72, 0.80, 0.88), col, smoothstep(-0.08, 0.02, d.y));
  // High sun disc + small halo.
  float s = dot(d, normalize(uSunDir));
  float disc = smoothstep(0.9988, 0.9994, s);
  float halo = pow(max(s, 0.0), 120.0) * 0.35 + pow(max(s, 0.0), 10.0) * 0.10;
  col += uSunColor * halo + vec3(1.0, 0.95, 0.85) * disc * 2.0;
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
      uMid: { value: MID_COLOR.clone() },
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

// Day clouds: white bodies with a soft blue-gray underside, placed high
// and far so they read as daytime cloud. Seeded, static.
export function createClouds(seed = 4) {
  const group = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 48, 4, 128, 48, 120);
  grad.addColorStop(0, 'rgba(255,255,255,0.92)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 96);
  // Soft blue-gray shading along the bottom edge, like a cloud shaded
  // from below.
  const shade = g.createLinearGradient(0, 48, 0, 96);
  shade.addColorStop(0, 'rgba(170,195,220,0)');
  shade.addColorStop(1, 'rgba(170,195,220,0.35)');
  g.fillStyle = shade;
  g.fillRect(0, 0, 256, 96);
  const t = new THREE.CanvasTexture(c);
  const spots = [
    [-140, 66, -180, 150], [60, 78, -220, 190], [170, 60, -120, 130],
    [-60, 84, 190, 170], [130, 72, 170, 150], [-190, 58, 60, 120],
    [-160, 44, -140, 190], [40, 48, -190, 220], [180, 42, 60, 170], [-40, 46, 200, 200],
  ];
  for (const [x, y, z, w] of spots) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, w * 0.36),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, fog: false, opacity: 0.6 }),
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
  scene.environmentIntensity = 0.8; // v3.6 day: bright blue sky feeds more light than the dusk env, so slightly less weight (was 0.9)
  pmrem.dispose();
  return rt;
}

// Lights: day hemisphere (blue sky above, bright snow bounce below), the
// high white sun with a 2048 shadow map fitted to the level AABB, and a
// faint cool fill from the opposite side so shadowed faces never go black.
// PCSS is not available in the vendored core (no examples/jsm), so shadows
// use PCF + radius — the honest fallback the design doc allows.
export function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0xe8eef2, 1.25); // v3.6 day: neutral blue sky + snow bounce (was lavender 1.1)
  scene.add(hemi);
  // White noon-ish sun: full-strength orange turned the snow monochrome
  // red in v3.5, so the day sun is pale warm white instead.
  const sun = new THREE.DirectionalLight(0xfff4e0, 3.0);
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
  const fill = new THREE.DirectionalLight(0xdfeaf5, 0.35); // v3.6: cool sky fill (was 0xffd9b0 warm bounce 0.4)
  fill.position.set(28, 14, 30);
  scene.add(fill);
  scene.fog = new THREE.FogExp2(0xd6e4ee, 0.004); // v3.6 day: pale blue-white haze, thinner than the dusk fog for day clarity
  return { hemi, sun, fill };
}
