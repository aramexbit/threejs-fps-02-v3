// sky.js — sunset over the snow yard: orange horizon, purple mid-sky,
// dark indigo zenith, low sun in the east-south-east, warm dusk fog.
// The sky is a gradient dome with a low sun disc and glow baked into the
// shader, plus procedural cloud bands. The same sky is fed through a PMREM
// generator so every PBR material gets image-based lighting from the actual
// sky — the single biggest realism win for an outdoor scene. Fog is
// exponential, warm and thin (aerial perspective: far lanes fade into warm
// haze, never cut to black).
import * as THREE from 'three';

// Sunset, low in the east-south-east — it sits in the play/start/end shots
// (all three look east) so the low sun disc + glow read in frame, and the
// crane + containers go backlit like the reference. Shared by the sky
// shader, the directional light, and the warm/cool CoD look: orange sun
// vs purple shadows.
export const SUN_DIR = new THREE.Vector3(0.62, 0.20, 0.28).normalize();
export const SUN_COLOR = 0xff9a3d; // v3.5 sunset: deep orange (was 0xffd9a6 golden)
export const HORIZON_COLOR = new THREE.Color(0xff8a3d); // vivid sunset orange
export const MID_COLOR = new THREE.Color(0x9a5578); // purple-magenta dusk band
export const ZENITH_COLOR = new THREE.Color(0x4a4a7a); // indigo-violet overhead — kept luminous: 0x2f3358 was so dark the whole scene went dark with it

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
  // Sunset gradient, three stops: orange horizon -> purple dusk band ->
  // dark indigo overhead.
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, h));
  col = mix(col, uZenith, smoothstep(0.18, 0.65, h));
  // Warmth toward the sun's azimuth — orange light spilling across the
  // snow, purple everywhere else (the CoD warm/cool contrast, sunset cut).
  // Kept modest: 0.55 drowned the whole sky in orange on the first pass.
  float toward = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 2.0);
  col += uSunColor * toward * (1.0 - pow(max(h, 0.0), 0.6)) * 0.45;
  // Below the horizon: warm dark ground haze, not black.
  col = mix(vec3(0.32, 0.20, 0.16), col, smoothstep(-0.08, 0.02, d.y));
  // Low sun disc + halo. The halo was 0.9/0.35 and blew the whole sun
  // side of the sky into one orange wall; halved.
  float s = dot(d, normalize(uSunDir));
  float disc = smoothstep(0.9988, 0.9994, s);
  float halo = pow(max(s, 0.0), 120.0) * 0.45 + pow(max(s, 0.0), 10.0) * 0.18;
  col += uSunColor * halo + vec3(1.0, 0.85, 0.6) * disc * 2.2;
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

// Sunset cloud bands: dark mauve bodies with a warm orange underglow,
// placed high and far so they read as dusk cloud. Seeded, static.
export function createClouds(seed = 4) {
  const group = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 48, 4, 128, 48, 120);
  grad.addColorStop(0, 'rgba(52,36,72,0.9)');
  grad.addColorStop(0.55, 'rgba(110,52,80,0.45)');
  grad.addColorStop(1, 'rgba(110,52,80,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 96);
  // Warm underglow along the bottom edge, like a cloud lit from below
  // by the setting sun.
  const warm = g.createLinearGradient(0, 48, 0, 96);
  warm.addColorStop(0, 'rgba(255,140,60,0)');
  warm.addColorStop(1, 'rgba(255,140,60,0.4)');
  g.fillStyle = warm;
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
      new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, fog: false, opacity: 0.5 }),
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
  scene.environmentIntensity = 0.9; // v3.5 rebalance 2: 0.65 left the scene dark — the sunset env is dark overhead, so it needs more weight, not less, once the zenith is luminous again
  pmrem.dispose();
  return rt;
}

// Lights: dusk hemisphere (purple sky above, warm dark snow below), the low
// orange sunset with a 2048 shadow map fitted to the level AABB, and a faint
// warm fill from the fire side so shadowed faces never go black. PCSS is not
// available in the vendored core (no examples/jsm), so shadows use PCF +
// radius — the honest fallback the design doc allows.
export function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xc8bce0, 0x9a8074, 1.1); // v3.5 rebalance 2: brighter, paler lavender skylight — 1.0 with the darker sky colour still left the snow dark red-brown (snow-box avg (88,45,41))
  scene.add(hemi);
  // The directional sun is paler than the sky's sun colour: full-strength
  // orange (0xff9a3d) at 3.2 turned the snow monochrome red on the first
  // pass. Paler + dimmer keeps the snow white with a warm tint.
  const sun = new THREE.DirectionalLight(0xffc07a, 3.0);
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
  scene.fog = new THREE.FogExp2(0xd9a98e, 0.005); // v3.5 sunset: pale warm dusk haze — the first pass (0xcf8f6a, 0.006) was too saturated and red
  return { hemi, sun, fill };
}
