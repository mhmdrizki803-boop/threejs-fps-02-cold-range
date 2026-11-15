// The rifle: procedural viewmodel, hitscan firing with head/body/limb hitboxes,
// recoil climb, movement-driven spread, reload and ammo bookkeeping.

import * as THREE from 'three';
import { clamp, damp, lerp, rand } from './util.js';

const MAG_SIZE = 30;
const RESERVE_START = 120;      // matches the HUD's initial reserve
const FIRE_INTERVAL = 0.093;      // ~645 rpm
const RELOAD_TIME = 1.85;
const RANGE = 130;

// Headshots are a one-shot kill inside 40 m; bodies take four.
const DMG = { head: 108, body: 31, limb: 19 };

export class Weapon {
  constructor(camera, world, sfx, scene) {
    this.camera = camera;
    this.world = world;
    this.sfx = sfx;
    this.scene = scene;

    this.mag = MAG_SIZE;
    this.reserve = RESERVE_START;
    this.magSize = MAG_SIZE;

    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;

    this.recoilPitch = 0;     // visual + applied to camera via player
    this.recoilYaw = 0;
    this.bloom = 0;           // extra spread that builds while spraying
    this.triggerHeld = false;
    this.shotsFired = 0;

    // muzzle light lives on the camera so it always lights what you shoot at
    this.flashLight = new THREE.PointLight(0xffd9a0, 0, 7, 2);
    this.flashLight.position.set(0.18, -0.06, -1.0);
    this.camera.add(this.flashLight);

    this.group = new THREE.Group();
    this.buildModel();
    this.camera.add(this.group);
    this.group.position.set(0.30, -0.26, -0.52);

    // tracer pool
    this.tracers = [];
    this.buildTracers();

    this.onHit = null;        // (kind, worldPos) => void
    this.onAmmoChange = null;
    this.onFire = null;

    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._muzzleWorld = new THREE.Vector3();

    this.recoilState = 0;
    this._aimBlend = 0;
    this._clicked = false;
  }

  // ── model ────────────────────────────────────────────────
  buildModel() {
    const g = this.group;

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.55, metalness: 0.72 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.42, metalness: 0.85 });
    const polyMat = new THREE.MeshStandardMaterial({ color: 0x1e242b, roughness: 0.92, metalness: 0.08 });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x1a4f6b, roughness: 0.5, metalness: 0.3,
      emissive: 0x2fa8e0, emissiveIntensity: 0.55,
    });

    // receiver
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.10, 0.44), bodyMat);
    receiver.position.set(0, 0, -0.06);
    g.add(receiver);

    // upper rail
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.022, 0.40), darkMat);
    rail.position.set(0, 0.062, -0.08);
    g.add(rail);

    // barrel shroud + barrel
    const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.078, 0.30), darkMat);
    shroud.position.set(0, 0.014, -0.40);
    g.add(shroud);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.30, 10), bodyMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.018, -0.62);
    g.add(barrel);

    // muzzle brake
    const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.022, 0.075, 10), darkMat);
    brake.rotation.x = Math.PI / 2;
    brake.position.set(0, 0.018, -0.79);
    g.add(brake);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.018, -0.83);
    g.add(this.muzzle);

    // magazine
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.17, 0.085), bodyMat);
    mag.position.set(0, -0.13, -0.03);
    mag.rotation.x = 0.16;
    g.add(mag);
    this.magMesh = mag;

    // pistol grip
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.07), polyMat);
    grip.position.set(0, -0.115, 0.115);
    grip.rotation.x = -0.30;
    g.add(grip);

    // stock
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.085, 0.20), polyMat);
    stock.position.set(0, -0.012, 0.235);
    g.add(stock);

    // glow strip + front sight post, so the silhouette reads at a glance
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.012, 0.20), accentMat);
    strip.position.set(0.046, 0.02, -0.30);
    g.add(strip);

    const post = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.032, 0.008), accentMat);
    post.position.set(0, 0.083, -0.52);
    g.add(post);

    // hands: two blocky gloved shapes
    const glove = new THREE.MeshStandardMaterial({ color: 0x232a31, roughness: 0.95, metalness: 0.05 });
    const rightHand = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.10, 0.11), glove);
    rightHand.position.set(0.005, -0.10, 0.135);
    rightHand.rotation.x = -0.22;
    g.add(rightHand);

    const leftHand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.13), glove);
    leftHand.position.set(-0.012, -0.055, -0.39);
    leftHand.rotation.x = 0.10;
    g.add(leftHand);
    this.leftHand = leftHand;

    // muzzle flash: cross of two additive quads
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.flashMat = flashMat;
    const flashA = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), flashMat);
    const flashB = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.42), flashMat);
    flashB.rotation.z = Math.PI / 2;
    const flashC = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.42), flashMat);
    const flashGroup = new THREE.Group();
    flashGroup.add(flashA, flashB, flashC);
    flashGroup.position.copy(this.muzzle.position);
    g.add(flashGroup);
    this.flash = flashGroup;
    this.flashLife = 0;

    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  }

  buildTracers() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.LineBasicMaterial({
        color: 0xffe6b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const line = new THREE.Line(geo.clone(), mat);
      line.frustumCulled = false;
      line.visible = false;
      (this.scene || this.camera).add(line);
      this.tracers.push({ line, life: 0, max: 0.055 });
    }
  }

  // ── state helpers ────────────────────────────────────────
  get canFire() {
    return !this.reloading && this.cooldown <= 0 && this.mag > 0;
  }

  get spread() {
    // radians of cone half-angle
    let s = 0.0022;                            // tight, aimed, still
    s += 0.0095;                               // hipfire baseline
    const moveRatio = clamp(this.player ? this.player.speed2D / 5.3 : 0, 0, 1.6);
    s += moveRatio * moveRatio * 0.052;        // punishing while running
    s += this.bloom;                           // sustained fire
    if (this.player && this.player.crouching) s *= 0.62;
    if (this.player && this.player.aiming) s *= 0.34;
    return s;
  }

  reset() {
    this.mag = MAG_SIZE;
    this.reserve = RESERVE_START;
    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.bloom = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.triggerHeld = false;
    this.group.position.set(0.30, -0.26, -0.52);
    this.group.rotation.set(0, 0, 0);
    this.flashMat.opacity = 0;
    this.flashLight.intensity = 0;
    if (this.onAmmoChange) this.onAmmoChange(this.mag, this.reserve);
  }

  startReload() {
    if (this.reloading || this.mag === this.magSize || this.reserve <= 0) return false;
    this.reloading = true;
    this.reloadT = 0;
    if (this.sfx) this.sfx.reload();
    return true;
  }

  // ── firing ───────────────────────────────────────────────
  tryFire() {
    if (this.reloading) return;
    if (this.cooldown > 0) return;
    if (this.mag <= 0) {
      if (!this._clicked) {
        this._clicked = true;
        if (this.sfx) this.sfx.empty();
        this.autoReload();
      }
      return;
    }
    this._clicked = false;
    this.fire();
  }

  autoReload() {
    if (this.reserve > 0) this.startReload();
  }

  fire() {
    this.mag--;
    this.cooldown = FIRE_INTERVAL;
    this.shotsFired++;

    // spread cone around the camera's forward axis
    const cam = this.camera;
    this._v1.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    const s = this.spread;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * s;
    const dir = this._dir.copy(this._v1)
      .addScaledVector(this._right, Math.cos(a) * r)
      .addScaledVector(this._up, Math.sin(a) * r)
      .normalize();

    const origin = cam.getWorldPosition(this._v2);

    // muzzle flash + light
    this.flashMat.opacity = 0.95;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(rand(0.8, 1.25));
    this.flashLight.intensity = 9;
    this.flashLife = 0.045;

    if (this.sfx) this.sfx.shot();

    // recoil: climb, with a little horizontal wander
    const kick = this.player && this.player.crouching ? 0.62 : this.player && this.player.aiming ? 0.72 : 1;
    this.recoilPitch += 0.0165 * kick;
    this.recoilYaw += rand(-0.006, 0.006) * kick;
    this.recoilState = 1;
    this.bloom = Math.min(0.030, this.bloom + 0.0042);

    this.castShot(origin, dir);
    if (this.onAmmoChange) this.onAmmoChange(this.mag, this.reserve);
    if (this.mag === 0) this.autoReload();
    if (this.onFire) this.onFire();
  }

  castShot(origin, dir) {
    const worldHit = this.world.clipSegment(
      origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, RANGE
    );
    let worldDist = worldHit ? worldHit.dist : RANGE;

    // nearest enemy hitbox along the ray
    const hit = this.enemies ? this.enemies.raycast(origin, dir, worldDist) : null;

    let endX, endY, endZ;
    if (hit) {
      endX = origin.x + dir.x * hit.dist;
      endY = origin.y + dir.y * hit.dist;
      endZ = origin.z + dir.z * hit.dist;

      const killed = hit.enemy.applyDamage(hit.part, hit.dist);
      if (this.sfx) this.sfx.hit(hit.part === 'head');
      // one callback per bullet: what it hit and whether it finished the target
      if (this.onHit) {
        this.onHit({
          kind: killed ? 'kill' : 'hit',
          part: hit.part,
          point: { x: endX, y: endY, z: endZ },
          killed,
        });
      }
    } else {
      endX = origin.x + dir.x * worldDist;
      endY = origin.y + dir.y * worldDist;
      endZ = origin.z + dir.z * worldDist;
      if (worldHit && this.sfx) this.sfx.impact();
      if (worldHit && this.onHit) this.onHit({ kind: 'world', part: 'world', point: worldHit.point, killed: false });
    }

    this.spawnTracer(endX, endY, endZ);
  }

  spawnTracer(x, y, z) {
    const t = this.tracers.find((tr) => tr.life <= 0) || this.tracers[0];
    if (!t) return;
    this.muzzle.getWorldPosition(this._muzzleWorld);
    const p = t.line.geometry.attributes.position;
    p.setXYZ(0, this._muzzleWorld.x, this._muzzleWorld.y, this._muzzleWorld.z);
    p.setXYZ(1, x, y, z);
    p.needsUpdate = true;
    t.line.geometry.computeBoundingSphere();
    t.line.visible = true;
    t.line.material.opacity = 0.85;
    t.life = t.max;
  }

  // ── per-frame ────────────────────────────────────────────
  update(dt, player, input) {
    this.player = player;
    this.cooldown = Math.max(0, this.cooldown - dt);

    // reload progression
    if (this.reloading) {
      this.reloadT += dt;
      const t = this.reloadT / RELOAD_TIME;
      if (this.reloadT >= RELOAD_TIME) {
        const need = this.magSize - this.mag;
        const take = Math.min(need, this.reserve);
        this.mag += take;
        this.reserve -= take;
        this.reloading = false;
        this.reloadT = 0;
        if (this.sfx) this.sfx.reloadDone();
        if (this.onAmmoChange) this.onAmmoChange(this.mag, this.reserve);
      } else if (t > 0.25 && t < 0.3 && this.sfx) {
        this.sfx.reload();
      }
    }

    // bloom decays; recoil feeds into the player's aim pitch
    this.bloom = Math.max(0, this.bloom - dt * 0.055);

    // apply recoil to the aim (this is what makes spraying cost accuracy)
    if (player) {
      const applied = this.recoilPitch;
      player.pitch = clamp(player.pitch + applied, -1.5, 1.5);
      player.yaw += this.recoilYaw;
      this.recoilPitch = 0;
      this.recoilYaw = 0;
    }

    // ── viewmodel animation ───────────────────────────────
    const g = this.group;
    const speedRatio = player ? clamp(player.speed2D / 5.3, 0, 1.5) : 0;
    const bobAmp = speedRatio * (player && player.aiming ? 0.35 : 1);
    const bobX = Math.cos(player ? player.bobPhase : 0) * 0.013 * bobAmp;
    const bobY = Math.sin((player ? player.bobPhase : 0) * 2) * 0.011 * bobAmp;

    // idle breathing
    const t = performance.now() * 0.001;
    const idleY = Math.sin(t * 1.5) * 0.0035;
    const idleX = Math.cos(t * 1.1) * 0.0028;

    // aim pose vs hip pose
    const aim = player && player.aiming && !this.reloading ? 1 : 0;
    this._aimBlend = damp(this._aimBlend || 0, aim, 14, dt);
    const ab = this._aimBlend;

    let px = lerp(0.30, 0.0, ab) + bobX + idleX;
    let py = lerp(-0.26, -0.175, ab) + bobY + idleY;
    let pz = -0.52;
    let rx = 0;
    let ry = 0;
    let rz = 0;

    // recoil kick (visual only, aim recoil is applied above)
    this.recoilState = Math.max(0, this.recoilState - dt * 9);
    const rs = this.recoilState * this.recoilState;
    pz += rs * 0.055;
    rx += rs * 0.10;

    // reload choreography: dip, tilt, come back up
    if (this.reloading) {
      const k = this.reloadT / RELOAD_TIME;
      const dip = Math.sin(Math.min(1, k) * Math.PI);
      py -= dip * 0.16;
      pz += dip * 0.05;
      rz += dip * 0.55;
      rx -= dip * 0.22;
      // magazine out/in
      const magT = Math.sin(clamp((k - 0.18) / 0.55, 0, 1) * Math.PI);
      this.magMesh.position.y = -0.13 - magT * 0.16;
    } else {
      this.magMesh.position.y = damp(this.magMesh.position.y, -0.13, 18, dt);
    }

    // sprint lowers the gun a touch
    if (player && player.speed2D > 6.4 && !this.reloading && !aim) {
      py -= 0.05;
      rz += 0.22;
      rx += 0.12;
    }

    g.position.set(px, py, pz);
    g.rotation.set(rx, ry, rz);

    // hands follow loosely
    if (this.leftHand) this.leftHand.rotation.x = 0.10 + rs * 0.2;

    // flash decay
    this.flashLife = Math.max(0, this.flashLife - dt);
    if (this.flashLife <= 0) {
      if (this.flashMat.opacity > 0) this.flashMat.opacity = Math.max(0, this.flashMat.opacity - dt * 14);
      if (this.flashLight.intensity > 0) this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 220);
    }

    // tracers fade
    for (const tr of this.tracers) {
      if (tr.life > 0) {
        tr.life -= dt;
        tr.line.material.opacity = Math.max(0, tr.life / tr.max) * 0.85;
        if (tr.life <= 0) tr.line.visible = false;
      }
    }
  }

  // Called by the round loop when the trigger state changes.
  setTrigger(down) {
    if (down && !this.triggerHeld) {
      this.triggerHeld = true;
      this._clicked = false;
      this.tryFire();
    } else if (!down) {
      this.triggerHeld = false;
      this._clicked = false;
    }
  }

  canAutoFire() {
    return this.triggerHeld && this.canFire;
  }
}

export { MAG_SIZE, RESERVE_START, RELOAD_TIME, DMG };
