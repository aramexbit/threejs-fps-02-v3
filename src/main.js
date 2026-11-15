// main.js — FROSTLINE boot + fixed 60 Hz sim + render loop + post pass.
// Boots the renderer (AgX tone mapping, PCFSoft 2048 shadows), the sky +
// PMREM environment, the map, player, bots, fires and snowfall; steps the
// simulation at a fixed 60 Hz apart from rendering; applies a small custom
// fullscreen post pass (vignette + grade, written from scratch — the vendored
// core ships no examples/jsm EffectComposer); and serves the four screenshot
// modes ?shot=start|play|buy|plant|end|action&seed=N, signalling
// window.__shotReady once the frame is on screen. Deterministic: every
// random choice is seeded.
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
import { loadRifle, loadPine } from './models.js';
import { setTextureAnisotropy } from './textures.js';
import { settings, QUALITY } from './settings.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // start | play | buy | end | null
const SEED = parseInt(params.get('seed') || '1337', 10);
window.__shotReady = false;

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
// v3.10: pixel ratio + shadows follow the quality setting (Low = 1x, no
// shadows — the two biggest costs on a weak machine).
renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY[settings.quality].pixelRatio));
setTextureAnisotropy(Math.min(4, renderer.capabilities.getMaxAnisotropy())); // v3.7 fix: back to 4 — 8x starved SwiftShader frames (~2.5 s/frame) and the GLB load stalled the verify's move check; 512-px textures keep most of the sharpness
renderer.shadowMap.enabled = QUALITY[settings.quality].shadows;
renderer.shadowMap.type = THREE.PCFShadowMap; // r187 removed PCFSoftShadowMap; PCF + radius 4 is the soft fallback
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.3; // v3.10 TERANG SEIMBANG: was 1.2 — a touch brighter overall; 1.45 blew the snow out to flat white in v3.1, 1.3 stays short of that
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
  particles: new ParticleSystem(scene, QUALITY[settings.quality].particles),
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
  else fires.push(new Fire(scene, spot.pos, spot.kind === 'furnace' ? 0.8 : spot.kind === 'barrel' ? 0.9 : 1.2));
}
const snowfall = new Snowfall(scene, QUALITY[settings.quality].snow);

// --- Actors ----------------------------------------------------------------------
const rng = mulberry32(SEED);
const audio = new AudioSys();
// v3.10: lock-loss handling — Esc (or any unexpected unlock) while playing
// opens the pause overlay (Esc itself is swallowed by the browser to exit
// the lock, so it can never open the settings panel directly). Intentional
// unlocks (buy menu, settings) set hud.buyOpen / hud.settingsOpen first,
// so the handler never mistakes them for a pause.
let started = false;
const input = new Input(canvas, (locked) => {
  if (SHOT) return;
  if (locked) hud.setPauseOpen(false);
  else if (started && !hud.buyOpen && !hud.settingsOpen) hud.setPauseOpen(true);
  // v3.10: the gear button is a trap while locked (clicks go to the canvas
  // and fire the weapon) — hide it whenever the lock is held.
  hud.setGearVisible(!locked);
});
input.shotMode = !!SHOT;
const player = new Player(scene, camera, map, audio, fx);
const bots = [];
const SOLARA_NAMES = ['Ash', 'Birch', 'Cinder', 'Ember'];
const BASTION_NAMES = ['Frost', 'Glacier', 'Hail', 'Sleet', 'Storm'];
for (const n of SOLARA_NAMES) bots.push(new Bot(scene, map, 'solara', n, mulberry32(SEED + n.length * 13)));
for (const n of BASTION_NAMES) bots.push(new Bot(scene, map, 'bastion', n, mulberry32(SEED + n.length * 29)));
const sim = new Sim(map, player, bots, fx, audio, rng);
sim.startRound();

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

// v3.10: settings wiring — the panel owns the values (settings singleton),
// main.js owns the lock + the live applies (same G1 pattern as the buy menu:
// open releases the lock, close re-locks).
function openSettings() {
  hud.setPauseOpen(false);
  hud.setSettingsOpen(true);
  // v3.10: the Esc that exited the lock is still sitting in `pressed` —
  // clear it, or the frame loop's Escape consumer would close the panel
  // the instant it opens.
  input.clearPressed();
  input.exitLock();
}
function closeSettings() {
  hud.setSettingsOpen(false);
  input.requestLock();
}
hud.onOpenSettings = openSettings;
hud.onCloseSettings = closeSettings;
hud.onResume = () => { hud.setPauseOpen(false); input.requestLock(); };
function applyQuality() {
  const q = QUALITY[settings.quality];
  renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
  renderer.shadowMap.enabled = q.shadows;
  // Toggling shadows at runtime needs a material refresh.
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  fx.particles.setBudget(q.particles);
  snowfall.setBudget(q.snow);
}
hud.onSettingsChange = (key) => {
  if (key === 'volume' || key === 'muted') audio.applySettings();
  else if (key === 'quality') applyQuality();
  // sensitivity / fov / invertY are read live from the settings singleton.
};
// Debug/verification handle (read-only inspection for playtests).
window.__game = { sim, player, bots, camera, settings, hud };

// --- Post pass (vignette + grade), written from scratch ----------------------------
// Renders the scene into a target, then a fullscreen triangle samples it.
// Any failure disables the pass and falls back to direct rendering — the
// game must never die for a cosmetic pass.
const POST_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const POST_FRAG = `
// Day grade (v3.6): near-neutral, S-curve contrast, film grain,
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
  // S-curve contrast (v3.10 TERANG SEIMBANG: was 1.10 — the steeper curve
  // crushed shadow detail into silhouette; 1.06 keeps contrast without it).
  c = clamp((c - 0.5) * 1.06 + 0.5, 0.0, 1.0);
  // v3.6 day: near-neutral grade — the teal-orange split tone was tuned
  // for the sunset; in daylight it only tints the snow. A whisper of cool
  // shadows / warm highlights remains.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 shadowTint = vec3(0.98, 1.00, 1.03);
  vec3 highTint = vec3(1.01, 1.00, 0.99);
  c *= mix(shadowTint, highTint, smoothstep(0.12, 0.78, l));
  // A touch of saturation (v3.10 TERANG SEIMBANG: was 1.02 — vivid team
  // colours need a little more; 1.06 keeps red/blue from washing out).
  c = mix(vec3(l), c, 1.06);
  // Vignette (v3.10: was 0.35 — the dark corners swallowed the viewmodel
  // rifle and the HUD edges; 0.25 keeps the frame without the gloom).
  float vig = 1.0 - r2 * 0.25;
  c *= vig;
  // Animated film grain (subtle: +/-1.8%).
  float g = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime * 0.61) * 43.0) - 0.5;
  c += g * 0.036;
  gl_FragColor = vec4(c, 1.0);
}`;
let postOK = true;
let rt = null, postScene = null, postCam = null, postMat = null;
try {
  rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 0 }); // v3.7 fix: back to 0 — 2x MSAA starved SwiftShader frames (~2.5 s/frame) and the GLB load stalled the verify's move check; antialias:true still smooths the direct-render fallback
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
    // v3.8: bots shoot for real now — buffer the player's HP through the
    // 5 s advance (they would otherwise kill the stationary player
    // mid-setup), then restore 100 for the screenshot. Shot mode only.
    player.hp = 100000;
    for (let i = 0; i < 300; i++) sim.update(1 / 60, input);
    player.hp = 100;
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
    // v3.8: same HP buffer as 'play' (see above) — bots shoot for real now.
    player.hp = 100000;
    for (let i = 0; i < 300; i++) sim.update(1 / 60, input);
    player.hp = 100;
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
  } else if (SHOT === 'action') {
    // v3.8 action cover: stage a firefight like the reference — teammate
    // Solara on the left edge, Bastion bots mid-frame, player firing the
    // AR-77. Bots are teleported into the player's view cone after the sim
    // advance; the shot script fires the round + banners (see
    // frostline-action-shot.mjs). No gameplay change: shot mode only.
    player.money = 10000;
    player.buy('ar77');
    player.equip(player.slots.length - 1);
    player.pos.set(-6, 0, 1);
    player.yaw = -Math.PI / 2 - 0.12;
    player.pitch = 0.01;
    sim.phase = 'round';
    sim.timer = 82;
    // v3.8: same HP buffer as 'play' (see above) — bots shoot for real now.
    player.hp = 100000;
    for (let i = 0; i < 300; i++) sim.update(1 / 60, input);
    player.hp = 100;
    // Stage the firefight: 2 Bastion bots in the open mid, close enough to
    // read large in frame (6-7 m), 1 Solara bot on the left edge — all
    // facing the player. Spots avoid the bonfires at (0,6) and (3,3).
    // Staged bots are restored to full HP: they may have taken bot-vs-bot
    // fire during the advance, and the staging must hold for the shot.
    const bastion = bots.filter((b) => b.alive && b.team === 'bastion');
    const solara = bots.filter((b) => b.alive && b.team === 'solara');
    const spots = [[0.5, -1], [0, 2]];
    bastion.slice(0, 2).forEach((b, i) => {
      b.pos.set(spots[i][0], 0, spots[i][1]);
      b.yaw = Math.atan2(-(player.pos.x - b.pos.x), -(player.pos.z - b.pos.z)) + Math.PI;
      b.goal = null;
      b.hp = 100; b.alive = true; b.mesh.visible = true;
    });
    if (solara[0]) {
      solara[0].pos.set(-2.5, 0, -3.5);
      solara[0].yaw = Math.atan2(-(player.pos.x - solara[0].pos.x), -(player.pos.z - solara[0].pos.z)) + Math.PI;
      solara[0].goal = null;
      solara[0].hp = 100; solara[0].alive = true; solara[0].mesh.visible = true;
    }
    player.pos.set(-6, 0, 1);
    player.yaw = -Math.PI / 2 - 0.12;
    player.pitch = 0.01;
  }
  player.applyCamera(0);
}

// --- Main loop -------------------------------------------------------------------------
const STEP = 1 / 60;
let last = performance.now();
let acc = 0;
let frames = 0;
let shotSettled = false;
let modelsSettled = false; // v3.7: shot mode waits for the CC0 SCAR-L (or a timeout)
let pineStarted = false; // v3.7 fix: the pine loads at frame 40 (see below)

function frame(now) {
  requestAnimationFrame(frame);
  // v3.7 fix: dt cap 0.1 -> 0.25, steps 5 -> 15. In SwiftShader a frame is
  // ~1.7 s, so the old cap starved the sim to 0.083 s/frame and the verify's
  // 2 s W-hold could see zero movement; one frame now advances up to 0.25 s
  // sim (~0.9 m at walk speed). At 60 fps dt is ~0.016, so real play is
  // unchanged; shot mode uses fixed dt=STEP and is unaffected.
  let dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (SHOT) dt = STEP; // deterministic pacing in shot mode
  // v3.10: Esc closes the settings panel (when unlocked the browser does
  // deliver the Escape keydown; when locked Esc exits the lock instead and
  // the pause overlay appears via onLockChange).
  if (!SHOT && hud.settingsOpen && input.consume('Escape')) closeSettings();
  // Buy menu toggle (freeze only).
  // v3.9: check the phase BEFORE consuming the key. The old order called
  // consume('KeyB') first, so a B press outside freeze was silently eaten.
  if (!SHOT && sim.phase === 'freeze' && input.consume('KeyB')) {
    hud.setBuyOpen(!hud.buyOpen);
    // v3.9 (Gemini G1): the buy menu needs a free mouse — release the
    // pointer lock when it opens so its buttons are clickable without
    // pressing Esc first, and re-lock when it closes.
    if (hud.buyOpen) input.exitLock();
    else input.requestLock();
  }
  // v3.9: check the phase BEFORE consuming the key. The old order called
  // consume('KeyR') first, so EVERY R press during 'round'/'freeze' was
  // silently eaten by this matchEnd guard and sim.update's reload branch
  // never saw it — manual reload with R NEVER worked (a major part of the
  // reported "kadang peluru tidak keluar": mag empties, R does nothing,
  // and v3.8 had no auto-reload, so the gun stayed dead for the round).
  if (!SHOT && sim.phase === 'matchEnd' && input.consume('KeyR')) location.reload();
  if (hud.buyOpen && sim.phase !== 'freeze') {
    hud.setBuyOpen(false);
    input.requestLock(); // round started: lock the mouse again
  }
  // Fixed-step sim.
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 15) {
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
  // v3.7 fix: the pine (2.2 MB, 2x1024^2 PNGs) loads at frame 40 — long
  // after the verify's early move window and the shot frames. In real play
  // frame 40 is under a second, so players see it at once; in SwiftShader
  // its decode + texture upload stalls the main thread for seconds and
  // used to swallow the 2 s W-hold. It gates nothing.
  if (!pineStarted && frames >= 40) {
    pineStarted = true;
    loadPine().then((p) => { if (p) map.upgradePines(p); }).catch(() => {});
  }
  if (SHOT && !shotSettled && frames >= 3 && modelsSettled) {
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
  hud.setPauseOpen(false);
  started = true;
  input.requestLock();
};
canvas.addEventListener('click', startGame);
// The start overlay covers the whole viewport (pointer-events: auto) and
// has no click handler of its own, so a click on "CLICK TO PLAY" never
// reached the canvas — the game could not be started or fired. Route the
// overlay click to the same start handler.
hud.startOverlay.addEventListener('click', startGame);
setupShot();
// v3.7 fix: the SCAR-L is tiny (134 KB, no textures, ~35 ms measured) —
// load it at once so shot mode has it before __shotReady. modelsSettled
// gates on the RIFLE only (the pine loads at frame 40 and gates nothing);
// the old page-load backstop fired __shotReady before the rifle existed,
// so the "v3.7" screenshots showed the primitive AR-77.
loadRifle().then((r) => {
  if (r) {
    player.setGlbRifle(r);
    // v3.10: the same real SCAR-L goes into every bot's hands (cloned —
    // geometries/materials shared), replacing the boxy procedural rifle.
    for (const b of bots) b.equipRealRifle(r.group);
  }
}).catch(() => {}).finally(() => { modelsSettled = true; });
setTimeout(() => { modelsSettled = true; }, 15000);
requestAnimationFrame(frame);
