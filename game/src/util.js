// Small math helpers shared by the game modules.
export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate independent exponential smoothing.
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);

export const randSign = () => (Math.random() < 0.5 ? -1 : 1);

export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// Shortest signed difference between two angles.
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
