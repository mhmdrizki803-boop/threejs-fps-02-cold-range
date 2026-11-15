// Thin binding layer between game state and the HUD markup in index.html.
// Nothing here invents values: every setter is fed from the simulation.

const pad = (n) => (n < 10 ? '0' + n : String(n));

export class HUD {
  constructor() {
    this.health = document.getElementById('health');
    this.healthValue = document.getElementById('health-value');
    this.ammo = document.getElementById('ammo');
    this.ammoMag = document.getElementById('ammo-mag');
    this.ammoReserve = document.getElementById('ammo-reserve');
    this.timer = document.getElementById('timer');
    this.timerValue = document.getElementById('timer-value');
    this.score = document.getElementById('score');
    this.scoreValue = document.getElementById('score-value');
    this.scoreLabel = this.score.querySelector ? this.score.querySelector('.label') : null;
    this.hitmarkerEl = document.getElementById('hitmarker');
    this.crosshairEl = document.getElementById('crosshair');

    this.overlay = document.getElementById('overlay');
    this.overlayTitle = document.getElementById('overlay-title');
    this.overlayCopy = document.getElementById('overlay-copy');
    this.playButton = document.getElementById('play');

    this._hitTimer = 0;
    this._last = { health: -1, mag: -1, reserve: -1, timer: -1, score: -1 };

    this.reset();
  }

  // Values come from the simulation, never invented here.
  reset({ health = 100, mag = 30, reserve = 150, time = 120, score = 0, quota = 12 } = {}) {
    this._last = { health: -1, mag: -1, reserve: -1, timer: -1, score: -1 };
    this.setHealth(health);
    this.setAmmo(mag, reserve);
    this.setTimer(time);
    this.setScore(score);
    this.setKills(0, quota);
    this.setSpread(0);
  }

  // The crosshair opens up with real weapon spread, so what you see on
  // screen is what the bullets actually do.
  setSpread(norm) {
    if (!this.crosshairEl) return;
    const s = 1 + Math.min(1, Math.max(0, norm)) * 1.5;
    this.crosshairEl.style.transform = 'scale(' + s.toFixed(3) + ')';
  }

  setHealth(hp) {
    const v = Math.max(0, Math.round(hp));
    if (v === this._last.health) return;
    this._last.health = v;
    this.healthValue.textContent = String(v);
    this.health.classList.toggle('low', v <= 35);
  }

  setAmmo(mag, reserve) {
    if (mag === this._last.mag && reserve === this._last.reserve) return;
    this._last.mag = mag;
    this._last.reserve = reserve;
    this.ammoMag.textContent = String(mag);
    this.ammoReserve.textContent = String(reserve);
    this.ammo.classList.toggle('empty', mag === 0);
  }

  setTimer(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    if (s === this._last.timer) return;
    this._last.timer = s;
    this.timerValue.textContent = Math.floor(s / 60) + ':' + pad(s % 60);
    this.timer.classList.toggle('urgent', s <= 15);
  }

  setScore(score) {
    const s = Math.round(score);
    if (s === this._last.score) return;
    this._last.score = s;
    this.scoreValue.textContent = String(s);
  }

  // Score stays the numeric column; the label above it carries the objective,
  // so the round's win condition is visible on the HUD at all times.
  setKills(kills, quota) {
    this._kills = kills;
    if (this.scoreLabel) this.scoreLabel.textContent = 'Targets ' + kills + '/' + quota;
  }

  // Flash the crosshair X. 'kill' paints it red.
  hitmarker(kind = 'hit') {
    const el = this.hitmarkerEl;
    el.classList.toggle('kill', kind === 'kill');
    el.classList.add('show');
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => {
      el.classList.remove('show');
      el.classList.remove('kill');
    }, kind === 'kill' ? 190 : 110);
  }

  showOverlay(title, copy, buttonLabel) {
    this.overlayTitle.textContent = title;
    this.overlayCopy.textContent = copy;
    this.playButton.textContent = buttonLabel;
    this.overlay.classList.remove('hidden');
    this.overlayTitle.style.color = '';
    this.overlayTitle.style.textShadow = '';
  }

  hideOverlay() {
    this.overlay.classList.add('hidden');
  }

  get overlayVisible() {
    return !this.overlay.classList.contains('hidden');
  }
}
