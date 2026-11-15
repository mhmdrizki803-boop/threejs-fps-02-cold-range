// The arena: everything here is generated geometry, no assets.
// Also owns the collision model (AABB) and the ray/segment tests used by
// gunfire and by enemy line-of-sight.

import * as THREE from 'three';
import { clamp } from './util.js';

const ARENA = 22;      // half-extent of the playable square
const WALL_H = 6;

function gridTexture(size = 512, cells = 16, line = 'rgba(180,215,245,0.34)', bg = '#3a4a5c') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  const step = size / cells;
  g.strokeStyle = line;
  g.lineWidth = 1.4;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * step) + 0.5;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  // faint larger divisions
  g.strokeStyle = 'rgba(200,230,255,0.55)';
  g.lineWidth = 2.4;
  for (let i = 0; i <= 4; i++) {
    const p = Math.round((i * size) / 4) + 0.5;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// Box props laid out by hand. x/z centre, w/d footprint, h height, t = tone index.
const PROPS = [
  // corner crate stacks
  { x: -13, z: -13, w: 4.2, d: 4.2, h: 2.6, t: 1 },
  { x: -13, z: -13, w: 2.2, d: 2.2, h: 4.3, t: 2 },
  { x: 13, z: -13, w: 4.2, d: 4.2, h: 2.6, t: 1 },
  { x: 13, z: -13, w: 2.2, d: 2.2, h: 4.3, t: 2 },
  { x: -13, z: 13, w: 4.2, d: 4.2, h: 2.6, t: 1 },
  { x: 13, z: 13, w: 4.2, d: 4.2, h: 2.6, t: 1 },
  { x: 13, z: 13, w: 2.2, d: 2.2, h: 4.3, t: 2 },

  // central low cover the player can crouch behind
  { x: 0, z: 0, w: 7.5, d: 1.5, h: 1.35, t: 3 },
  { x: 0, z: 3.4, w: 1.5, d: 5.0, h: 1.35, t: 3 },

  // mid pillars
  { x: -7.5, z: 6.5, w: 1.8, d: 1.8, h: WALL_H, t: 4 },
  { x: 7.5, z: -6.5, w: 1.8, d: 1.8, h: WALL_H, t: 4 },

  // north / south sight-blocking walls
  { x: 0, z: -15.5, w: 12, d: 1.2, h: 2.9, t: 0 },
  { x: 0, z: 15.5, w: 12, d: 1.2, h: 2.9, t: 0 },

  // east / west long cover
  { x: -17.5, z: 0, w: 1.4, d: 9, h: 3.2, t: 0 },
  { x: 17.5, z: 0, w: 1.4, d: 9, h: 3.2, t: 0 },

  // scattered crates
  { x: -8.5, z: 13.5, w: 2.6, d: 2.6, h: 1.8, t: 2 },
  { x: 8.5, z: -13.5, w: 2.6, d: 2.6, h: 1.8, t: 2 },
  { x: 6.2, z: 9.0, w: 3.0, d: 3.0, h: 1.5, t: 1 },
  { x: -6.2, z: -9.0, w: 3.0, d: 3.0, h: 1.5, t: 1 },
];

const TONES = [
  { color: 0x6b7a88, rough: 0.88, metal: 0.06, emissive: 0x0a1119 },
  { color: 0x7a8894, rough: 0.76, metal: 0.14, emissive: 0x0a1119 },
  { color: 0x5d6a76, rough: 0.68, metal: 0.22, emissive: 0x0b1420 },
  { color: 0x8494a2, rough: 0.84, metal: 0.08, emissive: 0x0a1119 },
  { color: 0x4d5964, rough: 0.62, metal: 0.32, emissive: 0x0d1826 },
];


// A vertical gradient baked into a canvas and wrapped on an inverted sphere.
// No external image: this is drawn at runtime.
function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#16324d');   // zenith
  grad.addColorStop(0.42, '#2c5475');
  grad.addColorStop(0.62, '#5b7f97');
  grad.addColorStop(0.80, '#8fa6b4');   // horizon haze
  grad.addColorStop(1.00, '#2a3742');   // below the horizon line
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  // faint bands to break up the gradient
  g.fillStyle = 'rgba(255,255,255,0.035)';
  for (let i = 0; i < 5; i++) g.fillRect(0, 40 + i * 30, 16, 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = [];     // { min:{x,z}, max:{x,z}, minY, maxY }
    this.spawnPoints = [];   // { x, z, yaw } where hostiles may appear
    this.build();
  }

  build() {
    const scene = this.scene;
    scene.background = new THREE.Color(0x2c5475);
    scene.fog = new THREE.Fog(0x0a1018, 30, 95);

    // ── lights ─────────────────────────────────────────────
    scene.add(new THREE.HemisphereLight(0x9dc6ef, 0x1a222c, 1.15));

    const key = new THREE.DirectionalLight(0xdfefff, 2.9);
    key.position.set(18, 30, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -26;
    key.shadow.camera.right = 26;
    key.shadow.camera.top = 26;
    key.shadow.camera.bottom = -26;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 80;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    this.key = key;

    const rim = new THREE.DirectionalLight(0x77bbff, 1.35);
    rim.position.set(-20, 12, -24);
    scene.add(rim);

    // second fill from the opposite side so no face is ever pure black
    const fill = new THREE.DirectionalLight(0xa8c4de, 0.75);
    fill.position.set(6, 9, -30);
    scene.add(fill);

    const warm = new THREE.PointLight(0xffc48a, 30, 46, 2);
    warm.position.set(0, 4.2, 0);
    scene.add(warm);

    // ── sky ────────────────────────────────────────────────
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(150, 32, 20),
      new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, depthWrite: false, fog: false })
    );
    scene.add(sky);

    // distant monoliths beyond the walls: pure silhouette, gives the horizon scale
    const farMat = new THREE.MeshStandardMaterial({ color: 0x2b3d4e, roughness: 1.0, metalness: 0.0 });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.16;
      const r = 42 + Math.random() * 34;
      const w = 4 + Math.random() * 10;
      const hgt = 10 + Math.random() * 30;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, w), farMat);
      m.position.set(Math.cos(a) * r, hgt / 2 - 1.5, Math.sin(a) * r);
      m.rotation.y = Math.random() * Math.PI;
      scene.add(m);
    }

    // ── floor ──────────────────────────────────────────────
    const grid = gridTexture();
    grid.repeat.set(11, 11);
    const floorMat = new THREE.MeshStandardMaterial({
      map: grid, color: 0xdfeaf5, roughness: 0.88, metalness: 0.08,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2, ARENA * 2), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // ground plane well outside the arena so the horizon never shows a void
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      new THREE.MeshStandardMaterial({ color: 0x1c2733, roughness: 1.0, metalness: 0.0 })
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.02;
    scene.add(outer);

    // ── perimeter ──────────────────────────────────────────
    const perimMat = new THREE.MeshStandardMaterial({ color: 0x53616f, roughness: 0.86, metalness: 0.12 });
    const T = 1.4;
    const sides = [
      { x: 0, z: -ARENA - T / 2, w: ARENA * 2 + T * 2, d: T },
      { x: 0, z: ARENA + T / 2, w: ARENA * 2 + T * 2, d: T },
      { x: -ARENA - T / 2, z: 0, w: T, d: ARENA * 2 },
      { x: ARENA + T / 2, z: 0, w: T, d: ARENA * 2 },
    ];
    for (const s of sides) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s.w, WALL_H, s.d), perimMat);
      m.position.set(s.x, WALL_H / 2, s.z);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      this.addCollider(s.x, s.z, s.w, s.d, WALL_H);
      this._accentStrip(s.x, s.z, s.w, s.d, WALL_H);
    }

    // ── props ──────────────────────────────────────────────
    for (const p of PROPS) {
      const tone = TONES[p.t] || TONES[0];
      const mat = new THREE.MeshStandardMaterial({
        color: tone.color, roughness: tone.rough, metalness: tone.metal,
        emissive: tone.emissive, emissiveIntensity: 1,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), mat);
      mesh.position.set(p.x, p.h / 2, p.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.addCollider(p.x, p.z, p.w, p.d, p.h);

      // edge trim so the silhouettes read clearly in screenshots
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry, 25),
        new THREE.LineBasicMaterial({ color: 0xa8d4f0, transparent: true, opacity: 0.55 })
      );
      edges.position.copy(mesh.position);
      scene.add(edges);

      // glowing cap on anything tall enough to be a landmark
      if (p.h > 2.5) {
        const cap = new THREE.Mesh(
          new THREE.BoxGeometry(p.w * 0.96, 0.06, p.d * 0.96),
          new THREE.MeshBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: 0.8 })
        );
        cap.position.set(p.x, p.h + 0.03, p.z);
        scene.add(cap);
      }
    }

    // ── ambient dust motes (Points, cheap, sells motion) ────
    const N = 420;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 0] = (Math.random() * 2 - 1) * ARENA;
      pos[i * 3 + 1] = Math.random() * 7;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * ARENA;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      color: 0xcfe8ff, size: 0.055, transparent: true, opacity: 0.5,
      depthWrite: false, sizeAttenuation: true,
    }));
    scene.add(dust);
    this.dust = dust;

    // wall-wash lights so the inside of the perimeter is never a black band
    const washSpots = [
      [0, 3.4, -ARENA + 2.5], [0, 3.4, ARENA - 2.5],
      [-ARENA + 2.5, 3.4, 0], [ARENA - 2.5, 3.4, 0],
    ];
    for (const [x, y, z] of washSpots) {
      const l = new THREE.PointLight(0x9fd0ff, 16, 30, 2);
      l.position.set(x, y, z);
      scene.add(l);
    }

    // ── spawn candidates for hostiles ──────────────────────
    const rings = [
      { x: -18, z: -18 }, { x: 18, z: -18 }, { x: -18, z: 18 }, { x: 18, z: 18 },
      { x: 0, z: -20 }, { x: 0, z: 20 }, { x: -20, z: 0 }, { x: 20, z: 0 },
      { x: -9, z: -17 }, { x: 9, z: 17 }, { x: 16, z: 9 }, { x: -16, z: -9 },
      { x: 10, z: 4 }, { x: -10, z: -4 }, { x: -3, z: -8 }, { x: 3, z: 8 },
    ];
    this.spawnPoints = rings.map((r) => ({
      x: r.x, z: r.z,
      yaw: Math.atan2(-r.x, -r.z), // roughly facing the centre
    }));
  }

  _accentStrip(x, z, w, d, h) {
    const alongX = w > d;
    const geo = alongX
      ? new THREE.BoxGeometry(w * 0.9, 0.12, 0.06)
      : new THREE.BoxGeometry(0.06, 0.12, d * 0.9);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4aa3d8, transparent: true, opacity: 0.85 });
    for (const y of [1.1, 2.6]) {
      const m = new THREE.Mesh(geo, mat);
      // nudge inward so the strip sits proud of the wall face
      const inset = 0.72;
      m.position.set(
        x + (alongX ? 0 : (x < 0 ? inset : -inset)),
        y,
        z + (alongX ? (z < 0 ? inset : -inset) : 0)
      );
      this.scene.add(m);
    }
  }

  addCollider(cx, cz, w, d, h, minY = 0) {
    this.colliders.push({
      min: { x: cx - w / 2, z: cz - d / 2 },
      max: { x: cx + w / 2, z: cz + d / 2 },
      minY,
      maxY: minY + h,
    });
  }

  // Push a circle of radius r out of every AABB it overlaps, on the XZ plane.
  // Called once per axis of movement so the player slides along surfaces.
  resolve(pos, radius) {
    for (const c of this.colliders) {
      const nx = clamp(pos.x, c.min.x, c.max.x);
      const nz = clamp(pos.z, c.min.z, c.max.z);
      const dx = pos.x - nx;
      const dz = pos.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;

      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = radius - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
      } else {
        // centre is inside the box: eject along the shallowest face
        const toL = pos.x - c.min.x, toR = c.max.x - pos.x;
        const toB = pos.z - c.min.z, toT = c.max.z - pos.z;
        const m = Math.min(toL, toR, toB, toT);
        if (m === toL) pos.x = c.min.x - radius;
        else if (m === toR) pos.x = c.max.x + radius;
        else if (m === toB) pos.z = c.min.z - radius;
        else pos.z = c.max.z + radius;
      }
    }
    const lim = ARENA - radius;
    pos.x = clamp(pos.x, -lim, lim);
    pos.z = clamp(pos.z, -lim, lim);
    return pos;
  }

  // Segment vs every collider. Returns the nearest { dist, point, normal }
  // hit within maxDist, or null. Used for bullets and for sight tests.
  clipSegment(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    for (const c of this.colliders) {
      const t = rayAABB(ox, oy, oz, dx, dy, dz, c);
      if (t !== null && t >= 0 && t <= maxDist && (best === null || t < best.dist)) {
        best = { dist: t, box: c };
      }
    }
    if (best) {
      best.point = { x: ox + dx * best.dist, y: oy + dy * best.dist, z: oz + dz * best.dist };
      best.normal = faceNormal(best.point, best.box, dx, dy, dz);
    }
    return best;
  }

  // Cheap boolean version for line-of-sight.
  segmentBlocked(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return false;
    const hit = this.clipSegment(ax, ay, az, dx / len, dy / len, dz / len, len);
    return hit !== null;
  }

  update(dt, elapsed) {
    if (this.dust) this.dust.rotation.y = elapsed * 0.008;
  }
}

// Slab test against a box's XZ footprint between minY..maxY.
function rayAABB(ox, oy, oz, dx, dy, dz, c) {
  let tmin = 0;
  let tmax = Infinity;

  // X
  if (Math.abs(dx) < 1e-9) {
    if (ox < c.min.x || ox > c.max.x) return null;
  } else {
    let t1 = (c.min.x - ox) / dx;
    let t2 = (c.max.x - ox) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Y
  if (Math.abs(dy) < 1e-9) {
    if (oy < c.minY || oy > c.maxY) return null;
  } else {
    let t1 = (c.minY - oy) / dy;
    let t2 = (c.maxY - oy) / dy;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Z
  if (Math.abs(dz) < 1e-9) {
    if (oz < c.min.z || oz > c.max.z) return null;
  } else {
    let t1 = (c.min.z - oz) / dz;
    let t2 = (c.max.z - oz) / dz;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

function faceNormal(p, c, dx, dy, dz) {
  const eps = 1e-3;
  if (Math.abs(p.y - c.maxY) < eps) return { x: 0, y: 1, z: 0 };
  if (Math.abs(p.y - c.minY) < eps) return { x: 0, y: -1, z: 0 };
  if (Math.abs(p.x - c.min.x) < eps) return { x: -1, y: 0, z: 0 };
  if (Math.abs(p.x - c.max.x) < eps) return { x: 1, y: 0, z: 0 };
  if (Math.abs(p.z - c.min.z) < eps) return { x: 0, y: 0, z: -1 };
  if (Math.abs(p.z - c.max.z) < eps) return { x: 0, y: 0, z: 1 };
  // fall back to facing the shooter
  const l = Math.hypot(dx, dy, dz) || 1;
  return { x: -dx / l, y: -dy / l, z: -dz / l };
}
