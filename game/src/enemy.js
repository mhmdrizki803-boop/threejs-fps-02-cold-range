// Hostiles: a procedurally built humanoid with real hitboxes (head / body / limbs),
// patrol + investigate + engage behaviour, and bullets that hurt the player.
// They path crudely — steer, slide on collision, and re-route when stuck.

import * as THREE from 'three';
import { clamp, damp, lerp, rand, pick, angleDelta } from './util.js';

const HEAD_DMG = 108;   // one shot inside the falloff range
const BODY_DMG = 31;
const LIMB_DMG = 19;

const SKIN = 0xb08060;
const ARMOR = 0x23262c;      // near-black plates read instantly on a light floor
const ARMOR_DARK = 0x14161a;
const VISOR = 0xff5a3c;

// radius offsets in local space (relative to enemy origin at feet) used for hit tests
// Hitboxes track the model's 1.16x visual scale, so what you see is what you hit.
const BODY_SCALE = 1.16;
const HITBOXES = {
  head: { y: 1.63 * BODY_SCALE, r: 0.185 },
  body: { y: 1.18 * BODY_SCALE, r: 0.31 },
  limb: { y: 0.55 * BODY_SCALE, r: 0.34 },
};

class Enemy {
  constructor(scene, world, opts) {
    this.scene = scene;
    this.world = world;

    this.pos = new THREE.Vector3(opts.x, 0, opts.z);
    this.vel = new THREE.Vector3();
    this.yaw = opts.yaw || 0;
    this.targetYaw = this.yaw;

    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;
    this.dying = 0;

    this.radius = 0.36;
    this.speed = opts.speed || 2.9;
    this.state = 'patrol';
    this.stateTimer = 0;

    this.accuracy = opts.accuracy ?? 0.62;   // hit chance scaler
    this.reactionTime = opts.reaction ?? 0.34;
    this.fireInterval = opts.fireInterval ?? 1.15;
    this.fireCooldown = rand(0.4, 1.4);
    this.burst = 0;
    this.burstTimer = 0;

    this.alerted = 0;
    this.lastSeen = new THREE.Vector3().copy(this.pos);
    this.timeSinceSeen = 99;
    this.sees = false;

    this.patrolTarget = new THREE.Vector3(opts.x, 0, opts.z);
    this.patrolWait = rand(0.6, 3.0);
    this.stuckTimer = 0;
    this.lastPos = new THREE.Vector3().copy(this.pos);

    this.walkPhase = rand(0, 6.28);
    this.hitFlash = 0;
    this.muzzleLife = 0;

    this.buildModel();
    this.placeModel();
  }

  buildModel() {
    const root = new THREE.Group();

    const armorMat = new THREE.MeshStandardMaterial({ color: ARMOR, roughness: 0.72, metalness: 0.35 });
    const darkMat = new THREE.MeshStandardMaterial({ color: ARMOR_DARK, roughness: 0.85, metalness: 0.25 });
    const skinMat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.95, metalness: 0.0 });
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x2a0a06, emissive: VISOR, emissiveIntensity: 4.0, roughness: 0.35, metalness: 0.2,
    });
    this.mats = [armorMat, darkMat, skinMat, visorMat];
    this.baseEmissive = visorMat.emissiveIntensity;

    // torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.72, 0.32), armorMat);
    torso.position.y = 1.18;
    torso.castShadow = true;
    root.add(torso);

    // chest plate detail
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.30, 0.06), darkMat);
    plate.position.set(0, 1.22, 0.175);
    root.add(plate);

    // shoulder pads
    for (const sx of [-1, 1]) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.20, 0.26), darkMat);
      pad.position.set(sx * 0.33, 1.43, 0);
      pad.castShadow = true;
      root.add(pad);
    }

    // head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.28, 0.27), skinMat);
    head.position.y = 1.63;
    head.castShadow = true;
    root.add(head);

    const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.16, 0.30), armorMat);
    helmet.position.y = 1.74;
    helmet.castShadow = true;
    root.add(helmet);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.235, 0.085, 0.045), visorMat);
    visor.position.set(0, 1.645, 0.145);
    root.add(visor);

    // arms — pivoted at the shoulder so they can swing when walking
    this.arms = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.34, 1.42, 0);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.46, 0.16), armorMat);
      upper.position.y = -0.23;
      upper.castShadow = true;
      pivot.add(upper);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.13), darkMat);
      hand.position.y = -0.50;
      pivot.add(hand);
      root.add(pivot);
      this.arms.push({ pivot, side: sx });
    }

    // legs
    this.legs = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.15, 0.82, 0);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.78, 0.20), darkMat);
      leg.position.y = -0.39;
      leg.castShadow = true;
      pivot.add(leg);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.11, 0.29), armorMat);
      boot.position.set(0, -0.80, 0.03);
      boot.castShadow = true;
      pivot.add(boot);
      root.add(pivot);
      this.legs.push({ pivot, side: sx });
    }

    // rifle in the right hand, angled forward
    const gun = new THREE.Group();
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.52), darkMat);
    gunBody.position.z = -0.10;
    gun.add(gunBody);
    const gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.26, 8), armorMat);
    gunBarrel.rotation.x = Math.PI / 2;
    gunBarrel.position.z = -0.46;
    gun.add(gunBarrel);
    gun.position.set(0.20, 1.18, 0.16);
    gun.rotation.x = 0.05;
    root.add(gun);
    this.gun = gun;

    // enemy muzzle flash
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffc06a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.enemyFlashMat = flashMat;
    const f1 = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 0.20), flashMat);
    const f2 = new THREE.Mesh(new THREE.PlaneGeometry(0.10, 0.34), flashMat);
    f2.rotation.z = Math.PI / 2;
    const fg = new THREE.Group();
    fg.add(f1, f2);
    fg.position.set(0.20, 1.18, -0.42);
    root.add(fg);
    this.enemyFlash = fg;
    this.muzzleLocal = new THREE.Vector3(0.20, 1.18, -0.60);

    // shoulder lamp: a hard orange accent that reads at range
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff6a3c })
    );
    lamp.position.set(-0.36, 1.50, 0.06);
    root.add(lamp);

    // team marker: a thin glowing ring at the feet so enemies read against the floor
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.30, 0.42, 24),
      new THREE.MeshBasicMaterial({
        color: 0xff4b32, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    root.add(ring);
    this.ring = ring;

    root.scale.setScalar(1.16);
    this.root = root;
    root.position.copy(this.pos);
    this.scene.add(root);
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  }

  placeModel() {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
  }

  // ── perception ───────────────────────────────────────────
  eyePos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, 1.60, this.pos.z);
  }

  canSeePlayer(player) {
    if (!player.alive) return false;
    const eye = this.eyePos(_tmpA);
    const target = _tmpB.set(player.pos.x, player.pos.y + player.eye, player.pos.z);
    const dist = eye.distanceTo(target);
    if (dist > 42) return false;

    // field of view: enemies have a cone, not 360° vision
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const dx = (target.x - eye.x) / dist;
    const dz = (target.z - eye.z) / dist;
    const dot = fx * dx + fz * dz;
    const fovCos = this.state === 'engage' ? -0.15 : 0.30;  // wider when already fighting
    if (dot < fovCos && this.timeSinceSeen > 0.6) return false;

    // crouching behind low cover hides you: test chest height, not eye height
    const probe = player.crouching && player.crouchAmount > 0.5
      ? _tmpC.set(player.pos.x, player.pos.y + 0.72, player.pos.z)
      : target;

    if (this.world.segmentBlocked(eye.x, eye.y, eye.z, probe.x, probe.y, probe.z)) return false;
    return true;
  }

  // ── damage ───────────────────────────────────────────────
  applyDamage(part, dist) {
    if (!this.alive) return false;
    let dmg = part === 'head' ? HEAD_DMG : part === 'body' ? BODY_DMG : LIMB_DMG;
    // damage falloff past 40 m so distance matters but headshots still end fights
    if (dist > 40) dmg *= clamp(1 - (dist - 40) / 80, 0.55, 1);
    this.health -= dmg;
    this.hitFlash = 1;
    this.alerted = 1;
    this.timeSinceSeen = 0;
    this.lastSeen.copy(this.playerRef ? this.playerRef.pos : this.pos);
    if (this.state === 'patrol') this.setState('engage');

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.dying = 0.0001;
      return true;
    }
    return false;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTimer = 0;
    if (s === 'engage') this.fireCooldown = Math.max(this.fireCooldown, this.reactionTime);
    if (s === 'patrol') this.pickPatrolPoint();
  }

  pickPatrolPoint() {
    // wander toward a reachable spot near the current position
    const w = this.world;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = rand(4, 16);
      const x = clamp(this.pos.x + Math.cos(a) * d, -20, 20);
      const z = clamp(this.pos.z + Math.sin(a) * d, -20, 20);
      const test = new THREE.Vector3(x, 0, z);
      w.resolve(test, this.radius + 0.05);
      if (Math.abs(test.x - x) < 0.01 && Math.abs(test.z - z) < 0.01) {
        this.patrolTarget.set(x, 0, z);
        this.patrolWait = 0;
        return;
      }
    }
    this.patrolTarget.set(rand(-16, 16), 0, rand(-16, 16));
    this.patrolWait = 0;
  }

  // ── main update ──────────────────────────────────────────
  update(dt, player, elapsed, onShootPlayer) {
    this.playerRef = player;

    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }

    this.stateTimer += dt;
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);

    // perception runs at a few hertz, staggered per enemy
    this._think = (this._think || rand(0, 0.12)) + dt;
    if (this._think > 0.11) {
      this._think = 0;
      const seen = this.canSeePlayer(player);
      this.sees = seen;
      if (seen) {
        this.timeSinceSeen = 0;
        this.lastSeen.set(player.pos.x, player.pos.y, player.pos.z);
        this.alerted = 1;
        if (this.state !== 'engage') this.setState('engage');
      } else {
        this.timeSinceSeen += 0.11;
        if (this.state === 'engage' && this.timeSinceSeen > 1.6) this.setState('search');
        if (this.state === 'search' && this.timeSinceSeen > 7) this.setState('patrol');
      }
      // hearing: firing nearby pulls enemies in even without line of sight
      if (!seen && this.alerted === 0 && this.playerRef && this.playerRef.lastShotAt) {
        const d = this.pos.distanceTo(this.playerRef.pos);
        if (elapsed - this.playerRef.lastShotAt < 0.5 && d < 26) {
          this.setState('search');
          this.lastSeen.set(player.pos.x, player.pos.y, player.pos.z);
        }
      }
    }

    let desired = new THREE.Vector3();
    let wantMove = false;
    let speedMul = 1;

    if (this.state === 'engage' && this.sees) {
      // hold a fighting distance, strafe, and shoot
      const toP = _tmpA.set(player.pos.x - this.pos.x, 0, player.pos.z - this.pos.z);
      const dist = toP.length();
      toP.normalize();

      this.targetYaw = Math.atan2(-toP.x, -toP.z);

      // strafe direction flips every second or so
      this.stateTimer += 0;
      if (!this.strafeDir || Math.random() < dt * 0.55) this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      const strafe = _tmpB.set(-toP.z * this.strafeDir, 0, toP.x * this.strafeDir);

      if (dist > 16) {
        desired.copy(toP).multiplyScalar(1.0);
        wantMove = true;
      } else if (dist < 7) {
        desired.copy(toP).multiplyScalar(-0.8);
        wantMove = true;
      } else {
        desired.copy(strafe).multiplyScalar(0.75);
        wantMove = true;
      }
      speedMul = 0.85;

      this.tryShoot(dt, player, dist, onShootPlayer);
    } else if (this.state === 'search') {
      // push toward where the player was last seen or heard
      const toL = _tmpA.set(this.lastSeen.x - this.pos.x, 0, this.lastSeen.z - this.pos.z);
      const d = toL.length();
      if (d > 2.0) {
        desired.copy(toL).normalize();
        this.targetYaw = Math.atan2(-desired.x, -desired.z);
        wantMove = true;
        speedMul = 1.15;
      } else {
        // sweep the area
        if (!this.sweepT || this.sweepT <= 0) {
          this.sweepT = rand(0.8, 1.5);
          this.sweepDir = Math.random() < 0.5 ? -1 : 1;
        }
        this.sweepT -= dt;
        this.targetYaw += this.sweepDir * dt * 1.9;
        this.patrolWait -= dt;
        if (this.patrolWait <= 0) { this.pickPatrolPoint(); this.patrolWait = rand(1, 2); }
      }
    } else {
      // patrol
      const toT = _tmpA.set(this.patrolTarget.x - this.pos.x, 0, this.patrolTarget.z - this.pos.z);
      const d = toT.length();
      if (d < 1.4) {
        this.patrolWait -= dt;
        if (this.patrolWait <= 0) this.pickPatrolPoint();
        // idle scan
        this.targetYaw += dt * 0.7 * (this.scanDir || 1);
      } else {
        desired.copy(toT).normalize();
        this.targetYaw = Math.atan2(-desired.x, -desired.z);
        wantMove = true;
        speedMul = 0.72;
      }
    }

    // ── steer & move ─────────────────────────────────────
    if (wantMove && desired.lengthSq() > 1e-6) {
      const targetVel = desired.normalize().multiplyScalar(this.speed * speedMul);
      // separation from other enemies so they don't stack
      if (this.neighbours) {
        for (const o of this.neighbours) {
          if (o === this || !o.alive) continue;
          const dx = this.pos.x - o.pos.x;
          const dz = this.pos.z - o.pos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < 2.25 && d2 > 1e-4) {
            const d = Math.sqrt(d2);
            targetVel.x += (dx / d) * (1.5 - d) * 2.2;
            targetVel.z += (dz / d) * (1.5 - d) * 2.2;
          }
        }
      }
      this.vel.x = damp(this.vel.x, targetVel.x, 9, dt);
      this.vel.z = damp(this.vel.z, targetVel.z, 9, dt);
    } else {
      this.vel.x = damp(this.vel.x, 0, 11, dt);
      this.vel.z = damp(this.vel.z, 0, 11, dt);
    }

    this.pos.x += this.vel.x * dt;
    this.world.resolve(this.pos, this.radius);
    this.pos.z += this.vel.z * dt;
    this.world.resolve(this.pos, this.radius);

    // stuck detection: if we want to move but aren't, pick a new target
    const moved = this.pos.distanceTo(this.lastPos);
    this.lastPos.copy(this.pos);
    if (wantMove && moved < 0.35 * dt * 60 * 0.016) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.9) {
        this.stuckTimer = 0;
        if (this.state === 'patrol') this.pickPatrolPoint();
        else {
          const a = Math.random() * Math.PI * 2;
          this.vel.x = Math.cos(a) * 2.5;
          this.vel.z = Math.sin(a) * 2.5;
        }
      }
    } else {
      this.stuckTimer = 0;
    }

    // ── face the target yaw ──────────────────────────────
    const dy = angleDelta(this.yaw, this.targetYaw);
    const turnRate = this.state === 'engage' ? 7.5 : 4.5;
    this.yaw += clamp(dy, -turnRate * dt, turnRate * dt);

    // ── animation ─────────────────────────────────────────
    const spd = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * (2.2 + spd * 2.6);
    const swing = clamp(spd / this.speed, 0, 1) * 0.62;
    for (let i = 0; i < this.legs.length; i++) {
      const s = i === 0 ? 1 : -1;
      this.legs[i].pivot.rotation.x = Math.sin(this.walkPhase) * swing * s;
    }
    if (this.arms[0]) {
      this.arms[0].pivot.rotation.x = -0.9 - Math.sin(this.walkPhase) * swing * 0.15;
      this.arms[0].pivot.rotation.z = 0.15;
    }
    if (this.arms[1]) {
      this.arms[1].pivot.rotation.x = -0.55 + Math.sin(this.walkPhase + Math.PI) * swing * 0.4;
      this.arms[1].pivot.rotation.z = -0.12;
    }

    // hit flash & muzzle flash decay
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.5);
    for (const m of this.mats) {
      if (m.emissive) m.emissiveIntensity = (m === this.mats[3] ? this.baseEmissive : 0) + this.hitFlash * 1.6;
    }
    this.muzzleLife = Math.max(0, this.muzzleLife - dt);
    this.enemyFlashMat.opacity = this.muzzleLife > 0 ? 0.95 : 0;
    this.enemyFlash.rotation.z = this.muzzleLife * 22;

    // ring pulses red when the enemy has you
    if (this.ring) {
      const hot = this.state === 'engage';
      this.ring.material.opacity = damp(this.ring.material.opacity, hot ? 0.85 : 0.45, 6, dt);
      this.ring.material.color.setHex(hot ? 0xff3b20 : 0xff8a5c);
    }

    this.placeModel();
  }

  tryShoot(dt, player, dist, onShootPlayer) {
    if (!this.sees) return;
    if (this.fireCooldown > 0) return;
    if (!player.alive) return;

    // burst logic: short bursts with a real pause between them, so incoming
    // fire has rhythm and a player can read it and break line of sight.
    if (this.burst > 0) {
      this.burst--;
      this.fireCooldown = 0.13;
    } else {
      this.burst = 1 + ((Math.random() * 2) | 0);
      this.fireCooldown = this.fireInterval * rand(1.0, 1.8);
    }

    this.muzzleLife = 0.05;
    const eye = this.eyePos(_tmpA);
    const target = _tmpB.set(player.pos.x, player.pos.y + player.eye - 0.15, player.pos.z);

    // accuracy: better up close, worse if the player is moving fast or crouched behind cover
    let chance = this.accuracy;
    // accuracy falls off with range: close fights are dangerous, long ones are
    // survivable if you keep moving between cover
    chance *= clamp(1.28 - dist / 22, 0.20, 1.0);
    if (player.speed2D > 3.2) chance *= 0.72;       // strafing works
    if (player.crouching) chance *= 0.82;
    chance = clamp(chance, 0.04, 0.55);

    if (onShootPlayer) onShootPlayer(this, eye, target, chance, dist);
  }

  updateDeath(dt) {
    this.dying += dt;
    const t = clamp(this.dying / 0.85, 0, 1);
    const e = 1 - Math.pow(1 - t, 3);
    this.root.rotation.z = e * 1.45;          // topple sideways
    this.root.position.y = -e * 0.35;
    if (this.ring) {
      this.ring.material.opacity = Math.max(0, 0.4 * (1 - t));
      this.ring.scale.setScalar(1 + t * 1.4);
    }
    for (const m of this.mats) {
      if (m.emissive && m !== this.mats[3]) m.emissiveIntensity = (1 - t) * 0.9;
    }
  }
}

// ── manager ────────────────────────────────────────────────
export class Enemies {
  constructor(scene, world, sfx) {
    this.scene = scene;
    this.world = world;
    this.sfx = sfx;
    this.list = [];
    this.spawnTimer = 0;
    this.maxAlive = 4;
    this.totalSpawned = 0;
    this.spawnBudget = 999;   // set by the round
    this._ray = new THREE.Vector3();
  }

  reset() {
    for (const e of this.list) e.dispose();
    this.list.length = 0;
    this.spawnTimer = 0;
    this.totalSpawned = 0;
  }

  spawnAt(p, opts = {}) {
    const e = new Enemy(this.scene, this.world, {
      x: p.x, z: p.z, yaw: p.yaw,
      speed: rand(2.5, 3.5),
      accuracy: rand(0.45, 0.70),
      reaction: rand(0.22, 0.5),
      fireInterval: rand(1.15, 1.75),
      ...opts,
    });
    this.list.push(e);
    this.totalSpawned++;
    return e;
  }

  spawnWave(count = 2, avoid) {
    const pts = [...this.world.spawnPoints];
    let spawned = 0;
    let guard = 0;
    while (spawned < count && guard++ < 40) {
      const p = pick(pts);
      if (!p) break;
      if (avoid && Math.hypot(p.x - avoid.x, p.z - avoid.z) < 11) continue;
      // don't spawn on top of a live enemy
      if (this.list.some((e) => e.alive && Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 3)) continue;
      this.spawnAt(p);
      spawned++;
    }
    return spawned;
  }

  get aliveCount() {
    return this.list.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
  }

  // Ray vs every living enemy's three hitboxes. Nearest wins.
  raycast(origin, dir, maxDist) {
    let best = null;
    for (const e of this.list) {
      if (!e.alive) continue;

      // broad phase: distance from the ray to the enemy's vertical axis
      const ox = e.pos.x - origin.x;
      const oz = e.pos.z - origin.z;
      const horiz = Math.hypot(dir.x, dir.z) || 1e-6;
      const proj = (ox * dir.x + oz * dir.z) / (horiz * horiz);
      if (proj < -1 || proj > maxDist + 2) continue;
      const px = origin.x + dir.x * proj;
      const pz = origin.z + dir.z * proj;
      if (Math.hypot(px - e.pos.x, pz - e.pos.z) > 1.0) continue;

      for (const key of ['head', 'body', 'limb']) {
        const hb = HITBOXES[key];
        const cx = e.pos.x;
        const cy = e.pos.y + hb.y;
        const cz = e.pos.z;
        const t = raySphere(origin, dir, cx, cy, cz, hb.r);
        if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.dist)) {
          best = { enemy: e, part: key, dist: t };
        }
      }
    }
    return best;
  }

  update(dt, player, elapsed, onShootPlayer, onKilled) {
    // spawn drip so the arena always has pressure
    this.spawnTimer -= dt;
    const alive = this.aliveCount;
    if (this.spawnTimer <= 0 && alive < this.maxAlive && this.totalSpawned < this.spawnBudget && player.alive) {
      this.spawnWave(1, player.pos);
      this.spawnTimer = rand(1.6, 3.4);
    }

    // give each enemy a neighbour list for separation
    for (const e of this.list) e.neighbours = this.list;

    for (const e of this.list) {
      e.update(dt, player, elapsed, onShootPlayer);
    }

    // reap finished corpses
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (!e.alive && e.dying > 2.6) {
        e.dispose();
        this.list.splice(i, 1);
      }
    }
  }
}

function raySphere(o, d, cx, cy, cz, r) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  const t1 = -b + sq;
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return null;
}

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();

export { HITBOXES };
