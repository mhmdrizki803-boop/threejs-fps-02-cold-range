// Player: acceleration-based movement, crouch, AABB collision, mouse look.
// The camera's yaw/pitch are stored here; the weapon adds recoil on top.

import * as THREE from 'three';
import { clamp, damp, lerp } from './util.js';

const EYE_STAND = 1.68;
const EYE_CROUCH = 1.06;
const RADIUS = 0.34;

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;

    this.pos = new THREE.Vector3(0, 0, 10);
    this.vel = new THREE.Vector3();     // horizontal only
    this.yaw = 0;                       // yaw 0 looks down -Z, into the arena
    this.pitch = 0;

    this.crouching = false;
    this.crouchAmount = 0;              // 0..1 smoothed
    this.eye = EYE_STAND;

    this.health = 100;
    this.alive = true;

    this.bobPhase = 0;
    this.bobAmount = 0;
    this.stepPhase = 0;

    this.sensitivity = 0.0022;
    this.walkSpeed = 5.3;
    this.sprintSpeed = 7.6;
    this.crouchSpeed = 2.5;
    this.aimSpeed = 2.9;

    this.accel = 38;                    // m/s^2: ~0.2s to reach walking speed
    this.friction = 13;                 // exponential stop when input stops

    this.speed2D = 0;                   // read by the weapon for spread
    this.aiming = false;

    this.onFootstep = null;

    // recoil / shake state, driven by the weapon and by taking damage
    this.shake = 0;
    this.pitchKick = 0;
    this.yawKick = 0;

    this._tmp = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  reset() {
    this.pos.set(0, 0, 10);
    this.vel.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.health = 100;
    this.alive = true;
    this.crouching = false;
    this.crouchAmount = 0;
    this.eye = EYE_STAND;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.shake = 0;
    this.pitchKick = 0;
    this.yawKick = 0;
    this.speed2D = 0;
    this.aiming = false;
    this.syncCamera(0);
  }

  get eyeHeight() {
    return lerp(EYE_STAND, EYE_CROUCH, this.crouchAmount);
  }

  look(dx, dy) {
    if (!this.alive) return;
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    const limit = Math.PI / 2 - 0.04;
    this.pitch = clamp(this.pitch, -limit, limit);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  damage(amount, fromDir) {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this.shake = Math.min(1, this.shake + amount * 0.022);
    if (this.health <= 0) this.alive = false;
    return this.health <= 0;
  }

  // Forward/right basis on the XZ plane (yaw only) — used for movement.
  forward(out = this._tmp) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  update(dt, input) {
    if (!this.alive) {
      this.vel.multiplyScalar(Math.max(0, 1 - dt * 6));
      this.shake = Math.max(0, this.shake - dt * 2.2);
      this.syncCamera(dt);
      return;
    }

    // ── crouch ────────────────────────────────────────────
    this.crouching = input.crouch;
    this.crouchAmount = damp(this.crouchAmount, this.crouching ? 1 : 0, 12, dt);

    // ── desired velocity ──────────────────────────────────
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);

    let ix = 0;
    let iz = 0;
    if (input.forward) iz += 1;
    if (input.back) iz -= 1;
    if (input.right) ix += 1;
    if (input.left) ix -= 1;
    const inputLen = Math.hypot(ix, iz);
    if (inputLen > 0) { ix /= inputLen; iz /= inputLen; }

    let speed = this.walkSpeed;
    if (this.crouching) speed = this.crouchSpeed;
    else if (this.aiming) speed = this.aimSpeed;
    else if (input.sprint && iz > 0.1) speed = this.sprintSpeed;

    const wishX = (fx * iz + rx * ix) * speed;
    const wishZ = (fz * iz + rz * ix) * speed;

    const moving = inputLen > 0;
    if (moving) {
      // bounded acceleration: velocity chases the wish vector at a fixed m/s^2,
      // so changing direction or starting from rest always takes time.
      const dvx = wishX - this.vel.x;
      const dvz = wishZ - this.vel.z;
      const dv = Math.hypot(dvx, dvz);
      const maxStep = this.accel * dt;
      if (dv > 1e-5) {
        const k = Math.min(1, maxStep / dv);
        this.vel.x += dvx * k;
        this.vel.z += dvz * k;
      }
    } else {
      // friction: exponential decay, frame-rate independent
      const f = Math.exp(-this.friction * dt);
      this.vel.x *= f;
      this.vel.z *= f;
      if (Math.hypot(this.vel.x, this.vel.z) < 0.02) this.vel.set(0, 0, 0);
    }

    // never exceed the current mode's top speed (crouch/aim transitions clamp)
    const sp = Math.hypot(this.vel.x, this.vel.z);
    const cap = speed * 1.06;
    if (sp > cap && sp > 0) {
      this.vel.x = (this.vel.x / sp) * cap;
      this.vel.z = (this.vel.z / sp) * cap;
    }

    // ── integrate with per-axis collision ─────────────────
    const p = this.pos;
    p.x += this.vel.x * dt;
    this.world.resolve(p, RADIUS);
    p.z += this.vel.z * dt;
    this.world.resolve(p, RADIUS);

    this.speed2D = Math.hypot(this.vel.x, this.vel.z);

    // ── head bob & footsteps ──────────────────────────────
    const speedRatio = clamp(this.speed2D / this.walkSpeed, 0, 1.4);
    const target = this.speed2D > 0.4 ? speedRatio : 0;
    this.bobAmount = damp(this.bobAmount, target, 8, dt);
    if (this.speed2D > 0.4) {
      const prev = this.stepPhase;
      this.bobPhase += dt * (5.4 + speedRatio * 5.2);
      this.stepPhase = Math.floor(this.bobPhase / Math.PI);
      if (this.stepPhase !== prev && this.onFootstep) this.onFootstep(this.crouching);
    }

    // ── recoil recovery & shake ───────────────────────────
    this.pitchKick = damp(this.pitchKick, 0, 9, dt);
    this.yawKick = damp(this.yawKick, 0, 9, dt);
    this.shake = Math.max(0, this.shake - dt * 1.9);

    this.syncCamera(dt);
  }

  syncCamera(dt) {
    const cam = this.camera;
    this.eye = damp(this.eye, this.eyeHeight, 14, dt);

    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * 0.028 * this.bobAmount;

    const sx = (Math.random() - 0.5) * this.shake * 0.10;
    const sy = (Math.random() - 0.5) * this.shake * 0.10;

    cam.position.set(
      this.pos.x + bobX * Math.cos(this.yaw) + sx,
      this.pos.y + this.eye + bobY + sy,
      this.pos.z - bobX * Math.sin(this.yaw)
    );

    this._euler.set(this.pitch + this.pitchKick, this.yaw + this.yawKick, 0, 'YXZ');
    cam.quaternion.setFromEuler(this._euler);

    // aim-down-sights: a modest FOV pull, no zoom faking
    const fovTarget = this.aiming ? 58 : 76;
    if (Math.abs(cam.fov - fovTarget) > 0.05) {
      cam.fov = damp(cam.fov, fovTarget, 12, dt || 0.016);
      cam.updateProjectionMatrix();
    }
  }
}
