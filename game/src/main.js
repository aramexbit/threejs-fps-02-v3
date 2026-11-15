// main.js — FROSTLINE boot + fixed 60 Hz sim + render loop + post pass.
// Boots the renderer (AgX tone mapping, PCFSoft 2048 shadows), the sky +
// PMREM environment, the map, player, bots, fires and snowfall; steps the
// simulation at a fixed 60 Hz apart from rendering; applies a small custom
// fullscreen post pass (vignette + grade, written from scratch — the vendored
// core ships no examples/jsm EffectComposer); and serves the four screenshot
// modes ?shot=start|play|buy|plant|end&seed=N, signalling window.__shotReady once
// the frame is on screen. Deterministic: every random choice is seeded.
import * as THREE from 'three';
import { buildMap } from './map.js';
import { createSky, createClouds, createLights, applyEnvironment } from './sky.js';
import { Player } from './player.js';
import { Bot } from './bots.js';
import { Sim } from './sim.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { AudioSys } from './audio.js';
import { ParticleSystem, MuzzleFlash, DecalPool, Fire, ChimneySmoke, Snowfall, Explosion, TracerPool } from './effects.js';
import { mulberry32 } from './rng.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // start | play | buy | end | null
const SEED = parseInt(params.get('seed') || '1337', 10);
window.__shotReady = false;

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r187 removed PCFSoftShadowMap; PCF + radius 4 is the soft fallback
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.3; // Rebalance after v3.1 screenshots: 1.45 blew the snow out to flat white (was 1.05 in v3)
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.1, 600);
camera.rotation.order = 'YXZ';
scene.add(camera);

// --- World -------------------------------------------------------------------
const sky = createSky();
scene.add(sky);
scene.add(createClouds());
const lights = createLights(scene);
applyEnvironment(renderer, scene, sky);
const map = buildMap(scene);

// --- Effects -------------------------------------------------------------------
const fx = {
  particles: new ParticleSystem(scene, 700),
  flash: new MuzzleFlash(scene),
  decals: new DecalPool(scene),
  explosion: null,
  tracers: new TracerPool(scene), // Gemini realism pass: shot streaks
};
fx.explosion = new Explosion(scene, fx.particles);
const fires = [];
const chimneys = [];
for (const spot of map.fireSpots) {
  if (spot.kind === 'chimney') chimneys.push(new ChimneySmoke(scene, spot.pos));
  else fires.push(new Fire(scene, spot.pos, spot.kind === 'furnace' ? 0.8 : 1.2));
}
const snowfall = new Snowfall(scene, 800);

// --- Actors ----------------------------------------------------------------------
const rng = mulberry32(SEED);
const audio = new AudioSys();
const input = new Input(canvas);
input.shotMode = !!SHOT;
const player = new Player(scene, camera, map, audio, fx);
const bots = [];
const SOLARA_NAMES = ['Ash', 'Birch', 'Cinder', 'Ember'];
const BASTION_NAMES = ['Frost', 'Glacier', 'Hail', 'Sleet', 'Storm'];
for (const n of SOLARA_NAMES) bots.push(new Bot(scene, map, 'solara', n, mulberry32(SEED + n.length * 13)));
for (const n of BASTION_NAMES) bots.push(new Bot(scene, map, 'bastion', n, mulberry32(SEED + n.length * 29)));
const sim = new Sim(map, player, bots, fx, audio, rng);
sim.startRound();
// Debug/verification handle (read-only inspection for playtests).
window.__game = { sim, player, bots };

// Bomb mesh: a dark case with a blinking red light, shown while planted.
const bombMesh = new THREE.Group();
const bombCase = new THREE.Mesh(
  new THREE.BoxGeometry(0.45, 0.22, 0.3),
  new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.7 }),
);
bombCase.castShadow = true;
const bombLight = new THREE.Mesh(
  new THREE.SphereGeometry(0.05, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0xff2f2f }),
);
bombLight.position.set(0.15, 0.13, 0);
bombMesh.add(bombCase, bombLight);
bombMesh.visible = false;
scene.add(bombMesh);

// --- HUD -------------------------------------------------------------------------
const hud = new HUD(map, player, sim);
hud.audio = audio;

// --- Post pass (vignette + grade), written from scratch ----------------------------
// Renders the scene into a target, then a fullscreen triangle samples it.
// Any failure disables the pass and falls back to direct rendering — the
// game must never die for a cosmetic pass.
const POST_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const POST_FRAG = `
// CoD-style grade: teal-orange split tone, S-curve contrast, film grain,
// subtle chromatic aberration, stronger vignette. Written from scratch.
varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uTime;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);
  // Chromatic aberration: radial, strongest at the frame edges.
  float ca = 0.004 * r2;
  vec3 c;
  c.r = texture2D(tDiffuse, vUv + d * ca).r;
  c.g = texture2D(tDiffuse, vUv).g;
  c.b = texture2D(tDiffuse, vUv - d * ca).b;
  // S-curve contrast.
  c = clamp((c - 0.5) * 1.10 + 0.5, 0.0, 1.0);
  // Teal-orange split grade: shadows toward cool teal, highlights warm.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 shadowTint = vec3(0.93, 1.02, 1.07);
  vec3 highTint = vec3(1.03, 1.0, 0.97); // v3.2: softer — 1.07 pushed bright snow pink
  c *= mix(shadowTint, highTint, smoothstep(0.12, 0.78, l));
  // A touch of saturation.
  c = mix(vec3(l), c, 1.1);
  // Vignette.
  float vig = 1.0 - r2 * 0.35;
  c *= vig;
  // Animated film grain (subtle: +/-1.8%).
  float g = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime * 0.61) * 43.0) - 0.5;
  c += g * 0.036;
  gl_FragColor = vec4(c, 1.0);
}`;
let postOK = true;
let rt = null, postScene = null, postCam = null, postMat = null;
try {
  rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 0 });
  postScene = new THREE.Scene();
  postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  postMat = new THREE.ShaderMaterial({
    vertexShader: POST_VERT, fragmentShader: POST_FRAG,
    uniforms: { tDiffuse: { value: rt.texture }, uTime: { value: 0 } }, depthTest: false, depthWrite: false,
  });
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));
} catch {
  postOK = false;
}

// --- Shot modes ----------------------------------------------------------------------
function setupShot() {
  if (!SHOT) return;
  hud.hideStart(); // screenshots show the game, not the menu overlay
  if (SHOT === 'start') {
    // Menu view: from the Solara spawn, looking south-east down mid toward
    // the crane and the bonfire — sky, containers and crane in frame.
    player.pos.set(-19, 0, -4);
    player.yaw = -Math.PI / 2 - 0.3;
    player.pitch = 0.02;
  } else if (SHOT === 'play') {
    // Mid-round: the player has bought the AR-77 (the CoD hero viewmodel),
    // advance the sim 5 s so bots are mid-push and the player is at mid
    // with the bonfire and crane in frame.
    player.money = 10000;
    player.buy('ar77');
    player.equip(player.slots.length - 1);
    player.pos.set(-6, 0, 1);
    player.yaw = -Math.PI / 2 - 0.12;
    player.pitch = 0.01;
    sim.phase = 'round';
    sim.timer = 82;
    for (let i = 0; i < 300; i++) sim.update(1 / 60, input);
    player.pos.set(-6, 0, 1);
    player.yaw = -Math.PI / 2 - 0.12;
  } else if (SHOT === 'buy') {
    hud.setBuyOpen(true);
    player.pos.set(-19, 0, 0);
    player.yaw = -Math.PI / 2;
  } else if (SHOT === 'plant') {
    // Plant/defuse moment: advance the sim 5 s so bots are mid-push, then
    // rewind the objective to mid-plant on site A — channel bar ~73%,
    // furnace and foundry walls in frame.
    player.money = 10000;
    player.buy('ar77');
    player.equip(player.slots.length - 1);
    player.pos.set(-6, 0, -6);
    player.yaw = -Math.PI / 2 - 0.12;
    player.pitch = 0.01;
    sim.phase = 'round';
    sim.timer = 64;
    for (let i = 0; i < 300; i++) sim.update(1 / 60, input);
    sim.bombPlanted = false;
    sim.bombSite = null;
    sim.bombPos = null;
    player.hasBomb = true;
    player.pos.set(13.5, 0, -12);
    player.yaw = -Math.PI / 2 - 0.1;
    player.pitch = 0.0;
    sim.plantProgress = 2.2;
    sim.debugPlantHold = true;
  } else if (SHOT === 'end') {
    // Victory screen: match won 5–3, end overlay with the Solara roster.
    // Hero angle: from mid-south looking east-southeast at the red lattice
    // crane + boiler house, instead of a dark empty corner.
    sim.score = { solara: 5, bastion: 3 };
    sim.round = 9;
    sim.phase = 'matchEnd';
    sim.setBanner('SOLARA TAKES THE MATCH', 8);
    hud.showEnd('solara', sim.score, bots);
    if (player.viewmodel) player.viewmodel.visible = false; // cinematic: no gun in frame
    player.pos.set(0, 0, 6);
    player.yaw = -Math.PI / 2 - 0.35;
    player.pitch = 0.02;
  }
  player.applyCamera(0);
}

// --- Main loop -------------------------------------------------------------------------
const STEP = 1 / 60;
let last = performance.now();
let acc = 0;
let frames = 0;
let shotSettled = false;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (SHOT) dt = STEP; // deterministic pacing in shot mode
  // Buy menu toggle (freeze only).
  if (!SHOT && input.consume('KeyB') && sim.phase === 'freeze') {
    hud.setBuyOpen(!hud.buyOpen);
  }
  if (!SHOT && input.consume('KeyR') && sim.phase === 'matchEnd') location.reload();
  if (hud.buyOpen && sim.phase !== 'freeze') hud.setBuyOpen(false);
  // Fixed-step sim.
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    sim.update(STEP, input);
    acc -= STEP;
    steps++;
  }
  // Camera + effects (render-time).
  player.applyCamera(sim.time);
  const t = sim.time;
  fx.particles.update(dt);
  fx.flash.update(dt);
  fx.decals.update(dt);
  fx.explosion.update(dt);
  fx.tracers.update(dt); // Gemini realism pass
  for (const f of fires) f.update(dt, fx.particles);
  for (const c of chimneys) c.update(dt, fx.particles);
  snowfall.update(dt, t, player.pos.x, player.pos.z);
  // Smoke clouds: keep emitting particles while a cloud lives.
  for (const s of sim.smokes) {
    fx.particles.smoke(new THREE.Vector3(s.pos.x, 0.6, s.pos.z), 2, 2.0, 0.9, 2.5);
  }
  // Bomb mesh.
  if (sim.bombPlanted && sim.bombPos) {
    bombMesh.visible = true;
    bombMesh.position.copy(sim.bombPos);
    bombLight.material.color.setHex(Math.sin(t * 6) > 0 ? 0xff2f2f : 0x550000);
  } else bombMesh.visible = false;
  // Render (post pass, with direct fallback).
  try {
    if (postOK) {
      if (postMat) postMat.uniforms.uTime.value = t;
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    } else {
      renderer.render(scene, camera);
    }
  } catch {
    postOK = false;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
  hud.update(dt, bots, sim.events);
  frames++;
  window.__frames = frames;
  if (SHOT && !shotSettled && frames >= 3) {
    shotSettled = true;
    window.__shotReady = true;
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (rt) rt.setSize(innerWidth, innerHeight);
});
const startGame = () => {
  if (SHOT) return;
  audio.ensure();
  hud.hideStart();
  input.requestLock();
};
canvas.addEventListener('click', startGame);
// The start overlay covers the whole viewport (pointer-events: auto) and
// has no click handler of its own, so a click on "CLICK TO PLAY" never
// reached the canvas — the game could not be started or fired. Route the
// overlay click to the same start handler.
hud.startOverlay.addEventListener('click', startGame);
setupShot();
requestAnimationFrame(frame);
