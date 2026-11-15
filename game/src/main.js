// COLD RANGE — browser FPS built on three.js for the threejs-fps-01 bounty.
// Boots the renderer, wires input and HUD, and runs the round loop.

import * as THREE from 'three';
import { World } from './world.js';
import { Player } from './player.js';
import { Weapon } from './weapon.js';
import { Enemies } from './enemy.js';
import { FX } from './fx.js';
import { HUD } from './hud.js';
import { Sfx } from './audio.js';
import { clamp, rand } from './util.js';

// ── rules ───────────────────────────────────────────────────
const ROUND_TIME = 120;         // seconds
const KILL_QUOTA = 12;          // kills needed before the clock runs out
const SCORE_KILL = 100;
const SCORE_HEADSHOT = 40;
const REGEN_DELAY = 7.0;
const REGEN_RATE = 7.5;

const canvas = document.getElementById('view');
const hud = new HUD();
const sfx = new Sfx();

// ── renderer ───────────────────────────────────────────────
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    preserveDrawingBuffer: true, canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
} catch (err) {
  hud.showOverlay('No WebGL', 'This browser could not create a WebGL context.\nA desktop browser with hardware acceleration is required.', 'Reload');
  hud.playButton.addEventListener('click', () => location.reload());
  throw err;
}

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.05, 260);
camera.rotation.order = 'YXZ';
scene.add(camera);

const world = new World(scene);
const player = new Player(camera, world);
const weapon = new Weapon(camera, world, sfx, scene);
const enemies = new Enemies(scene, world, sfx);
const fx = new FX(scene);

weapon.enemies = enemies;

// ── input ──────────────────────────────────────────────────
const input = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false,
};

const KEYMAP = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

window.addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) { input[KEYMAP[e.code]] = true; e.preventDefault(); }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.sprint = true;
  if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') {
    input.crouch = true;
    e.preventDefault();
  }
  if (e.code === 'KeyR' && round.state === 'playing') weapon.startReload();
  if (e.code === 'KeyM') { sfx.enabled = !sfx.enabled; }
}, { passive: false });

window.addEventListener('keyup', (e) => {
  if (KEYMAP[e.code]) input[KEYMAP[e.code]] = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.sprint = false;
  if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') input.crouch = false;
});

window.addEventListener('blur', () => {
  input.forward = input.back = input.left = input.right = false;
  input.sprint = input.crouch = false;
  weapon.setTrigger(false);
  player.aiming = false;
});

canvas.addEventListener('mousedown', (e) => {
  if (round.state !== 'playing') return;
  if (e.button === 0) weapon.setTrigger(true);
  if (e.button === 2) { player.aiming = true; e.preventDefault(); }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) weapon.setTrigger(false);
  if (e.button === 2) player.aiming = false;
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Mouse look works two ways. With pointer lock the cursor is captured and
// movementX/Y stream continuously — the normal case. If the page is embedded
// in an iframe that forbids pointer lock, the same deltas still arrive while
// the cursor is over the canvas, so the game stays fully playable.
document.addEventListener('mousemove', (e) => {
  if (round.state !== 'playing') return;
  const locked = document.pointerLockElement === canvas;
  if (!locked && e.target !== canvas && !canvas.contains(e.target)) return;
  player.look(e.movementX || 0, e.movementY || 0);
});

// pointer lock drives pause/resume
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  pointerLocked = locked;
  canvas.style.cursor = locked ? 'none' : 'crosshair';
  if (!locked && round.state === 'playing' && lockWasRequested) {
    round.state = 'paused';
    weapon.setTrigger(false);
    player.aiming = false;
    lockWasRequested = false;
    hud.showOverlay('Paused', 'The round is still running.\nClick resume to take back control.', 'Resume');
  }
});

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(w, h, false);
});

// ── round state ────────────────────────────────────────────
const round = {
  state: 'menu',        // menu | playing | paused | over
  timeLeft: ROUND_TIME,
  score: 0,
  kills: 0,
  headshots: 0,
  shotsFired: 0,
  shotsHit: 0,
  elapsed: 0,
  lastDamageAt: -99,
  pendingDamage: 0,
  pendingHits: 0,
};

function startRound() {
  sfx.resume();

  player.reset();
  weapon.reset();
  enemies.reset();
  fx.reset();
  hud.reset({
    health: player.health,
    mag: weapon.mag,
    reserve: weapon.reserve,
    time: ROUND_TIME,
    score: 0,
    quota: KILL_QUOTA,
  });

  round.state = 'playing';
  round.timeLeft = ROUND_TIME;
  round.score = 0;
  round.kills = 0;
  round.headshots = 0;
  round.shotsFired = 0;
  round.shotsHit = 0;
  round.elapsed = 0;
  round.lastDamageAt = -99;
  round.pendingDamage = 0;
  round.pendingHits = 0;

  enemies.spawnBudget = 999;
  enemies.spawnTimer = 2.0;
  enemies.spawnWave(3, player.pos);

  hud.setKills(0, KILL_QUOTA);
  hud.hideOverlay();
  lockPointer();
}

let pointerLocked = false;
let lockWasRequested = false;

function lockPointer() {
  if (!canvas.requestPointerLock) return;
  lockWasRequested = true;
  try {
    // unadjustedMovement is a hint; browsers that reject it still lock on the
    // plain call, so a failure here is never fatal to the round.
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* pointer lock unavailable — keyboard still works */ }
}

function endRound(win) {
  if (round.state === 'over') return;
  round.state = 'over';
  weapon.setTrigger(false);
  player.aiming = false;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  sfx.roundEnd(win);

  const acc = round.shotsFired > 0 ? Math.round((round.shotsHit / round.shotsFired) * 100) : 0;
  const stats =
    'Kills ' + round.kills + ' / ' + KILL_QUOTA +
    '   ·   Headshots ' + round.headshots +
    '   ·   Accuracy ' + acc + '%' +
    '   ·   Score ' + round.score;

  if (win) {
    hud.showOverlay(
      'Range Cleared',
      'You held the line with ' + Math.max(0, Math.ceil(round.timeLeft)) + 's left.\n' + stats,
      'Play Again'
    );
  } else {
    const reason = player.health <= 0
      ? 'You went down with ' + round.kills + ' of ' + KILL_QUOTA + ' hostiles cleared.'
      : 'The clock ran out with ' + round.kills + ' of ' + KILL_QUOTA + ' hostiles cleared.';
    hud.showOverlay('Range Lost', reason + '\n' + stats, 'Try Again');
  }
}

hud.playButton.addEventListener('click', () => {
  if (round.state === 'paused') {
    round.state = 'playing';
    hud.hideOverlay();
    lockPointer();
    return;
  }
  startRound();
});

// ── combat callbacks ───────────────────────────────────────
weapon.onHit = (info) => {
  const { kind, part, point, killed } = info;

  if (kind === 'world') {
    fx.spark(point, { x: 0, y: 1, z: 0 }, 6);
    return;
  }

  // a hit on a body counts toward accuracy; headshots are still body hits
  round.shotsHit++;
  const head = part === 'head';
  fx.blood(point, killed ? 14 : head ? 10 : 6);

  if (!killed) {
    hud.hitmarker('hit');
    return;
  }

  round.kills++;
  round.score += SCORE_KILL;
  if (head) { round.headshots++; round.score += SCORE_HEADSHOT; }
  hud.hitmarker('kill');
  hud.setScore(round.score);
  hud.setKills(round.kills, KILL_QUOTA);
  sfx.kill();
};

weapon.onFire = () => {
  round.shotsFired++;
  player.lastShotAt = round.elapsed;
};

// enemies shoot back; this is where their bullets land
function enemyShoot(enemy, eye, target, chance, dist) {
  const muzzle = enemy.root.localToWorld(enemy.muzzleLocal.clone());

  let hit = Math.random() < chance;
  // a bullet fired point-blank is almost never a miss
  if (dist < 5) hit = Math.random() < Math.min(0.92, chance + 0.28);

  let end;
  if (hit) {
    end = { x: target.x, y: target.y, z: target.z };
  } else {
    // miss wide: land on the floor or a wall near the player
    const spread = 0.7 + dist * 0.035;
    end = {
      x: target.x + rand(-spread, spread),
      y: target.y + rand(-0.5, 0.9),
      z: target.z + rand(-spread, spread),
    };
  }

  // if cover is in the way the shot simply stops there — no damage through walls
  const dx = end.x - muzzle.x, dy = end.y - muzzle.y, dz = end.z - muzzle.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const wall = world.clipSegment(muzzle.x, muzzle.y, muzzle.z, dx / len, dy / len, dz / len, len);
  if (wall) {
    end = wall.point;
    hit = false;
    fx.spark(wall.point, wall.normal, 4);
  }

  fx.enemyTracer(muzzle, end);
  sfx.enemyShot(dist);

  if (hit) {
    // one bullet, one damage event — no healing between rounds of a frame
    let dmg = 7 * clamp(1.12 - dist / 55, 0.55, 1.12);
    round.pendingDamage += dmg;
    round.pendingHits++;
    round.lastDamageAt = round.elapsed;
    fx.flashDamage(dmg);
    sfx.hurt();
  }
}

// ── main loop ──────────────────────────────────────────────
let last = performance.now();

// Adaptive quality: if frames are consistently slow (software GL, integrated
// GPU on a 4K panel) drop shadows and resolution rather than stutter.
const perf = { frames: 0, time: 0, checked: false, downgraded: false };
function trackPerf(dt) {
  if (perf.checked) return;
  perf.frames++;
  perf.time += dt;
  if (perf.frames < 45) return;
  const avg = perf.time / perf.frames;
  perf.checked = true;
  if (avg > 0.045) {
    perf.downgraded = true;
    renderer.shadowMap.enabled = false;
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    scene.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    if (world.key) world.key.castShadow = false;
    camera.far = 190;
    camera.updateProjectionMatrix();
  }
}

function frame(now) {

  let dt = (now - last) / 1000;
  last = now;
  // Guard against tab-switch spikes. The map's thinnest collider is 1.2 m
  // and the fastest step is 7.6 m/s, so 0.08 s can never tunnel a wall.
  if (dt > 0.08) dt = 0.08;
  if (dt < 0) dt = 0;

  trackPerf(dt);
  try { step(dt); } catch (e) { console.error('[step]', e); }
  renderer.render(scene, camera);
}

function step(dt) {
  const playing = round.state === 'playing';

  if (playing) {
    round.elapsed += dt;
    round.timeLeft -= dt;

    // ── player ────────────────────────────────────────────
    player.aiming = player.aiming && !player.crouching && weapon.mag > 0 && !weapon.reloading;
    player.update(dt, playing ? input : NO_INPUT);

    // automatic fire while the trigger is held
    if (playing && weapon.canAutoFire()) weapon.tryFire();

    // health regeneration after a lull, so a round is recoverable
    if (player.alive && round.elapsed - round.lastDamageAt > REGEN_DELAY && player.health < 100) {
      player.health = Math.min(100, player.health + REGEN_RATE * dt);
      hud.setHealth(player.health);
    }

    hud.setHealth(player.health);
    hud.setAmmo(weapon.mag, weapon.reserve);
    hud.setTimer(round.timeLeft);
    // 0.055 rad is the widest practical cone; normalise for the crosshair
    hud.setSpread(weapon.spread / 0.055);

    // ── enemies ───────────────────────────────────────────
    round.pendingDamage = 0;
    round.pendingHits = 0;
    enemies.update(dt, player, round.elapsed, enemyShoot);

    // all incoming fire this frame lands as a single health update
    if (round.pendingDamage > 0) {
      const dead = player.damage(round.pendingDamage, null);
      hud.setHealth(player.health);
      if (dead) endRound(false);
    }

    // ── round end conditions ──────────────────────────────
    if (playing && round.kills >= KILL_QUOTA) {
      endRound(true);
    } else if (playing && round.timeLeft <= 0) {
      round.timeLeft = 0;
      hud.setTimer(0);
      endRound(false);
    } else if (playing && !player.alive) {
      endRound(false);
    }
  } else {
    // paused / menu / over: keep the camera still but animate the world a little
    player.update(dt, NO_INPUT);
  }

  weapon.update(dt, player, input);
  fx.update(dt);
  world.update(dt, round.elapsed);
  hud.setScore(round.score);
  hud.setKills(round.kills, KILL_QUOTA);
}

const NO_INPUT = { forward: false, back: false, left: false, right: false, sprint: false, crouch: false };

// ── boot ───────────────────────────────────────────────────
hud.reset({ health: player.health, mag: weapon.mag, reserve: weapon.reserve, time: ROUND_TIME, score: 0, quota: KILL_QUOTA });
player.syncCamera(0.016);
hud.showOverlay(
  'Cold Range',
  'Clear the range. Hostiles patrol, spot you and shoot back.\n' +
  'Get ' + KILL_QUOTA + ' kills before the ' + (ROUND_TIME / 60).toFixed(0) + ':00 clock runs out.\n\n' +
  'W A S D  move   ·   SHIFT  sprint   ·   CTRL  crouch\n' +
  'MOUSE  look   ·   LMB  fire   ·   RMB  aim   ·   R  reload',
  'Play'
);

// draw a still frame behind the menu so the first thing you see is the arena
renderer.render(scene, camera);
requestAnimationFrame(frame);

// expose a tiny handle for debugging / verification in the console
const api = {
  scene, camera, player, weapon, enemies, round, world, hud, input, renderer,
  startRound, endRound,
  perf,
  paused: false,
  // deterministic fixed-step advance, used by the headless verification harness
  step: (dt) => step(dt),
};
window.__coldRange = api;


// Headless verification hooks (also used to capture the entry's screenshots).
window.__DBG = { scene, camera, renderer };
window.__CAP = (w = 1280, h = 720, q = 0.86) => {
  try {
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const sm = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    if (camera.aspect !== w / h) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/jpeg', q);
    renderer.setSize(size.x, size.y, false);
    renderer.setPixelRatio(pr);
    renderer.shadowMap.enabled = sm;
    if (camera.aspect !== size.x / size.y) { camera.aspect = size.x / size.y; camera.updateProjectionMatrix(); }
    renderer.render(scene, camera);
    return url;
  } catch (e) { return 'err ' + e.message; }
};
window.__STATE = () => ({ cam: camera.position.toArray().map((v) => +v.toFixed(2)), meshes: scene.children.filter((o) => o.isMesh).length });
