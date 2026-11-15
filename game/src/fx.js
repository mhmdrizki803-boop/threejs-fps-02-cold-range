// Impact effects, enemy muzzle tracers, blood puffs and damage flashes.
// Fixed-size pools: no allocation during play.

import * as THREE from 'three';
import { rand, clamp } from './util.js';

export class FX {
  constructor(scene) {
    this.scene = scene;

    // ── sparks ────────────────────────────────────────────
    this.sparkCount = 90;
    const sGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(this.sparkCount * 3);
    sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    this.sparkMat = new THREE.PointsMaterial({
      color: 0xffd9a0, size: 0.075, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.sparks = new THREE.Points(sGeo, this.sparkMat);
    this.sparks.frustumCulled = false;
    scene.add(this.sparks);
    this.sparkVel = new Float32Array(this.sparkCount * 3);
    this.sparkLife = new Float32Array(this.sparkCount);
    this.sparkCursor = 0;

    // ── decals ────────────────────────────────────────────
    this.decalGeo = new THREE.PlaneGeometry(0.16, 0.16);
    this.decalMat = new THREE.MeshBasicMaterial({
      color: 0x0a0d11, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    this.decals = [];
    this.decalCursor = 0;
    for (let i = 0; i < 48; i++) {
      const d = new THREE.Mesh(this.decalGeo, this.decalMat);
      d.visible = false;
      scene.add(d);
      this.decals.push(d);
    }

    // ── enemy tracer lines ────────────────────────────────
    this.tracerPool = [];
    for (let i = 0; i < 16; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const m = new THREE.LineBasicMaterial({
        color: 0xff9a5a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(g, m);
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.tracerPool.push({ line, life: 0, max: 0.10 });
    }

    // ── blood puffs for body hits ────────────────────────
    this.puffMat = new THREE.PointsMaterial({
      color: 0xd9402e, size: 0.09, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.puffCount = 48;
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.puffCount * 3), 3));
    this.puffs = new THREE.Points(pGeo, this.puffMat);
    this.puffs.frustumCulled = false;
    scene.add(this.puffs);
    this.puffVel = new Float32Array(this.puffCount * 3);
    this.puffLife = new Float32Array(this.puffCount);
    this.puffCursor = 0;

    // hide unused points far below the arena
    const sp = this.sparks.geometry.attributes.position;
    for (let i = 0; i < this.sparkCount; i++) sp.setXYZ(i, 0, -999, 0);
    const pp = this.puffs.geometry.attributes.position;
    for (let i = 0; i < this.puffCount; i++) pp.setXYZ(i, 0, -999, 0);

    // ── damage vignette ──────────────────────────────────
    this.damageFlash = 0;
  }

  reset() {
    for (let i = 0; i < this.sparkCount; i++) {
      this.sparkLife[i] = 0;
      this.sparks.geometry.attributes.position.setXYZ(i, 0, -999, 0);
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
    for (let i = 0; i < this.puffCount; i++) {
      this.puffLife[i] = 0;
      this.puffs.geometry.attributes.position.setXYZ(i, 0, -999, 0);
    }
    this.puffs.geometry.attributes.position.needsUpdate = true;
    for (const d of this.decals) d.visible = false;
    for (const t of this.tracerPool) { t.life = 0; t.line.visible = false; }
    this.damageFlash = 0;
  }

  spark(pos, normal, count = 8) {
    const p = this.sparks.geometry.attributes.position;
    for (let k = 0; k < count; k++) {
      const i = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % this.sparkCount;
      p.setXYZ(i, pos.x, pos.y, pos.z);
      const n = normal || { x: 0, y: 1, z: 0 };
      this.sparkVel[i * 3 + 0] = n.x * rand(0.6, 2.6) + rand(-1.4, 1.4);
      this.sparkVel[i * 3 + 1] = n.y * rand(0.4, 2.0) + rand(0.2, 1.8);
      this.sparkVel[i * 3 + 2] = n.z * rand(0.6, 2.6) + rand(-1.4, 1.4);
      this.sparkLife[i] = rand(0.18, 0.42);
    }
    p.needsUpdate = true;
  }

  blood(pos, count = 6) {
    const p = this.puffs.geometry.attributes.position;
    for (let k = 0; k < count; k++) {
      const i = this.puffCursor;
      this.puffCursor = (this.puffCursor + 1) % this.puffCount;
      p.setXYZ(i, pos.x, pos.y, pos.z);
      this.puffVel[i * 3 + 0] = rand(-1.2, 1.2);
      this.puffVel[i * 3 + 1] = rand(0.2, 1.6);
      this.puffVel[i * 3 + 2] = rand(-1.2, 1.2);
      this.puffLife[i] = rand(0.25, 0.55);
    }
    p.needsUpdate = true;
  }

  decal(pos, normal) {
    const d = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % this.decals.length;
    d.position.set(pos.x + normal.x * 0.012, pos.y + normal.y * 0.012, pos.z + normal.z * 0.012);
    // orient the quad to face along the surface normal
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    d.quaternion.copy(q);
    d.rotateZ(rand(0, Math.PI));
    d.scale.setScalar(rand(0.6, 1.15));
    d.visible = true;
  }

  enemyTracer(from, to) {
    const t = this.tracerPool.find((x) => x.life <= 0) || this.tracerPool[0];
    if (!t) return;
    const p = t.line.geometry.attributes.position;
    p.setXYZ(0, from.x, from.y, from.z);
    p.setXYZ(1, to.x, to.y, to.z);
    p.needsUpdate = true;
    t.line.geometry.computeBoundingSphere();
    t.line.visible = true;
    t.line.material.opacity = 0.7;
    t.life = t.max;
  }

  flashDamage(amount) {
    this.damageFlash = clamp(this.damageFlash + amount / 40, 0, 1);
  }

  update(dt) {
    // sparks
    const sp = this.sparks.geometry.attributes.position;
    let dirty = false;
    for (let i = 0; i < this.sparkCount; i++) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt;
      if (this.sparkLife[i] <= 0) {
        sp.setXYZ(i, 0, -999, 0);
        dirty = true;
        continue;
      }
      const i3 = i * 3;
      this.sparkVel[i3 + 1] -= 9.8 * dt;
      sp.setXYZ(
        i,
        sp.getX(i) + this.sparkVel[i3 + 0] * dt,
        sp.getY(i) + this.sparkVel[i3 + 1] * dt,
        sp.getZ(i) + this.sparkVel[i3 + 2] * dt
      );
      dirty = true;
    }
    if (dirty) sp.needsUpdate = true;

    // blood
    const pp = this.puffs.geometry.attributes.position;
    let dirtyP = false;
    for (let i = 0; i < this.puffCount; i++) {
      if (this.puffLife[i] <= 0) continue;
      this.puffLife[i] -= dt;
      if (this.puffLife[i] <= 0) {
        pp.setXYZ(i, 0, -999, 0);
        dirtyP = true;
        continue;
      }
      const i3 = i * 3;
      this.puffVel[i3 + 1] -= 6.0 * dt;
      pp.setXYZ(
        i,
        pp.getX(i) + this.puffVel[i3 + 0] * dt,
        pp.getY(i) + this.puffVel[i3 + 1] * dt,
        pp.getZ(i) + this.puffVel[i3 + 2] * dt
      );
      dirtyP = true;
    }
    if (dirtyP) pp.needsUpdate = true;

    // tracers
    for (const t of this.tracerPool) {
      if (t.life > 0) {
        t.life -= dt;
        t.line.material.opacity = Math.max(0, t.life / t.max) * 0.7;
        if (t.life <= 0) t.line.visible = false;
      }
    }

    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.8);
    this.sparkMat.opacity = 0.95;
  }
}
