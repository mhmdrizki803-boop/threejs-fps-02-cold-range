// threejs-fps-01 entry (Node 22, standard library only): it hands the game in.
// It copies game/ and screenshots/ to the output directory and writes dossier.json
// with buildDossier from vendor/makefun-threejs.ts, which is the kit's own library.
// The game is static: three.js from the import map, no network, no build step.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-threejs.ts';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(OUTPUT_DIR, { recursive: true });
cpSync(join(BOT_DIR, 'game'), join(OUTPUT_DIR, 'game'), { recursive: true });
cpSync(join(BOT_DIR, 'screenshots'), join(OUTPUT_DIR, 'screenshots'), { recursive: true });

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes;
// the others refuse an entry the scorer would refuse.
writeFileSync(
  join(OUTPUT_DIR, 'dossier.json'),
  buildDossier(OUTPUT_DIR, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
  }),
);

console.error('threejs-fps-01: copied game/ and screenshots/, wrote dossier.json');
