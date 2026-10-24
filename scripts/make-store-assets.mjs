#!/usr/bin/env node
/**
 * Generate placeholder Microsoft Store / MSIX artwork for CUCI.
 *
 *   node scripts/make-store-assets.mjs
 *
 * Outputs:
 *   store/Assets/*.png   (the MSIX tile set referenced by AppxManifest.xml)
 *   build/icon.ico       (electron-builder app icon)
 *
 * These are deliberately simple placeholders — replace them with real branding
 * before submitting. Requirements per asset are listed in
 * docs/STORE-SUBMISSION.md.
 *
 * Uses ffmpeg (already required by the project) with drawtext.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const BG = '0x0b0d12';
const ACCENT = '0x6c8cff';
const ACCENT2 = '0x22d3ee';
const FONT_BOLD = 'C\\:/Windows/Fonts/arialbd.ttf';
const FONT_REG = 'C\\:/Windows/Fonts/arial.ttf';

/** w x h, text ('' = letter mark), font size, font file */
const ASSETS = [
  { file: 'StoreLogo.png', w: 50, h: 50, text: 'C', size: 30, font: FONT_BOLD },
  { file: 'Square44x44Logo.png', w: 44, h: 44, text: 'C', size: 26, font: FONT_BOLD },
  { file: 'LockScreenLogo.png', w: 24, h: 24, text: 'C', size: 15, font: FONT_BOLD },
  { file: 'Square150x150Logo.png', w: 150, h: 150, text: 'CUCI', size: 30, font: FONT_BOLD },
  { file: 'Square310x310Logo.png', w: 310, h: 310, text: 'CUCI', size: 60, font: FONT_BOLD },
  { file: 'Wide310x150Logo.png', w: 310, h: 150, text: 'CUCI', size: 46, font: FONT_BOLD },
  { file: 'SplashScreen.png', w: 620, h: 300, text: 'CUCI', size: 86, font: FONT_BOLD },
];

function run(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed:\n${r.stderr ? r.stderr.toString() : ''}`);
  }
}

function buildFilter(a) {
  const filters = [];
  // accent underline proportional to the tile
  const barW = Math.round(a.w * 0.5);
  const barH = Math.max(2, Math.round(a.h * 0.035));
  const barX = Math.round((a.w - barW) / 2);
  const barY = Math.round(a.h * 0.68);
  filters.push(`drawbox=x=${barX}:y=${barY}:w=${barW}:h=${barH}:color=${ACCENT}@1:t=fill`);
  filters.push(
    `drawtext=fontfile='${a.font}':text='${a.text}':fontcolor=${a.h >= 150 ? ACCENT2 : ACCENT}:fontsize=${a.size}:x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(a.h * 0.05)}`,
  );
  return filters.join(',');
}

function main() {
  const assetsDir = path.join(root, 'store', 'Assets');
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  for (const a of ASSETS) {
    const out = path.join(assetsDir, a.file);
    run(['-f', 'lavfi', '-i', `color=c=${BG}:s=${a.w}x${a.h}`, '-vf', buildFilter(a), '-frames:v', '1', out]);
    console.log(`  ${a.w}x${a.h}  ${path.relative(root, out)}`);
  }

  // Partner Center "Store listing" box art (300x300)
  const listingDir = path.join(root, 'store', 'listing');
  fs.mkdirSync(listingDir, { recursive: true });
  const listingLogo = path.join(listingDir, 'StoreListingLogo300x300.png');
  run([
    '-f', 'lavfi', '-i', `color=c=${BG}:s=300x300`,
    '-vf', buildFilter({ w: 300, h: 300, text: 'CUCI', size: 58, font: FONT_BOLD }),
    '-frames:v', '1', listingLogo,
  ]);
  console.log(`  300x300 ${path.relative(root, listingLogo)}`);

  // electron-builder app icon (256x256 ICO)
  const png = path.join(buildDir, '_icon256.png');
  run(['-f', 'lavfi', '-i', `color=c=${BG}:s=256x256`, '-vf', buildFilter({ w: 256, h: 256, text: 'CUCI', size: 52, font: FONT_BOLD }), '-frames:v', '1', png]);
  run(['-i', png, '-vf', 'scale=256:256', path.join(buildDir, 'icon.ico')]);
  fs.rmSync(png, { force: true });
  console.log(`  256x256 ${path.relative(root, path.join(buildDir, 'icon.ico'))}`);
  console.log('\nStore assets generated (placeholders — replace with real branding).');
}

main();
