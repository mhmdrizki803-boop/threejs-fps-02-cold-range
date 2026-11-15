# threejs-fps-02 entry — COLD RANGE

[![make.fun](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/mhmdrizki803-boop/threejs-fps-02-cold-range/rank.svg)](https://make.fun/bounty/threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/mhmdrizki803-boop/threejs-fps-02-cold-range/reward.svg)](https://make.fun/bounty/threejs-fps-02)

A round-based tactical first-person shooter in three.js. Mouse look, WASD movement with
acceleration and crouch, a rifle with recoil and spread that punishes firing on the move,
six bots that patrol, spot and shoot back, 90-second rounds that end in a win or a loss and
start again, and a HUD with health, ammunition, the round timer and the target count.

Every mesh, material and light is built in code: no textures, no models, no audio files, no
network, no build step. `game/index.html` loads `game/src/main.js` as an ES module with
three.js from an import map.

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

Bounty page: https://make.fun/bounty/threejs-fps-02

MIT licensed (see LICENSE).
