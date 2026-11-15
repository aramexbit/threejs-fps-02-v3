// main.js — FROSTLINE boot + fixed 60 Hz sim + render loop + post pass.
// Boots the renderer (AgX tone mapping, PCFSoft 2048 shadows), the sky +
// PMREM environment, the map, player, bots, fires and snowfall; steps the
// simulation at a fixed 60 Hz apart from rendering; applies a small custom
// fullscreen post pass (vignette + grade, written from scratch — the vendored
// core ships no examples/jsm EffectComposer); and serves the four screenshot
// modes ?shot=start|play|buy|end&seed=N, signalling window.__shotReady once
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
varying vec2 vUv; uniform sampler2D tDiffuse;
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  // Gentle S-curve lift + a touch of saturation for the cold grade.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 1.08);
  c = pow(c, vec3(0.96));
  // Vignette.
  vec2 d = vUv - 0.5;
  float vig = 1.0 - dot(d, d) * 0.25; // Gemini realism pass: lighter vignette keeps the frame bright (was 0.55)
  gl_FragColor = vec4(c * vig, 1.0);
}`;
let postOK = true;
let rt = null, postScene = null, postCam = null, postMat = null;
try {
  rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 0 });
  postScene = new THREE.Scene();
  postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  postMat = new THREE.ShaderMaterial({
    vertexShader: POST_VERT, fragmentShader: POST_FRAG,
    uniforms: { tDiffuse: { value: rt.texture } }, depthTest: false, depthWrite: false,
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
    // Mid-round: advance the sim 5 s so bots are mid-push and the player is
    // at mid with the bonfire and crane in frame.
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
  } else if (SHOT === 'end') {
    sim.score = { solara: 4, bastion: 3 };
    sim.round = 8;
    sim.phase = 'end';
    sim.timer = 3.5;
    sim.setBanner('SOLARA WINS THE ROUND — TEAM ELIMINATED', 4);
    player.pos.set(8, 0, -6);
    player.yaw = -Math.PI / 2 + 0.5;
    player.pitch = 0.03;
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
  // Bomb mesh.
  if (sim.bombPlanted && sim.bombPos) {
    bombMesh.visible = true;
    bombMesh.position.copy(sim.bombPos);
    bombLight.material.color.setHex(Math.sin(t * 6) > 0 ? 0xff2f2f : 0x550000);
  } else bombMesh.visible = false;
  // Render (post pass, with direct fallback).
  try {
    if (postOK) {
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
