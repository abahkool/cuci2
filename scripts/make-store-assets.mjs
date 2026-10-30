#!/usr/bin/env node
/**
 * Generate Microsoft Store / MSIX artwork and the app icon for CUCI from the logo.
 *
 *   node scripts/make-store-assets.mjs
 *
 * Source:  icons/logo.png  (square branding art, any size ≥ 256 px)
 * Outputs:
 *   store/Assets/*.png         (the MSIX tile set referenced by AppxManifest.xml)
 *   store/listing/*.png        (Store listing box art)
 *   build/icon.ico             (electron-builder app icon, multi-size PNG-in-ICO)
 *
 * All tiles are produced by scaling the logo into the target box with its
 * aspect ratio preserved and padding it with the app background colour, so a
 * single square source covers every Store shape. Requirements per asset are
 * listed in docs/STORE-SUBMISSION.md.
 *
 * Uses ffmpeg (already required by the project) for the PNG rasterisation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SOURCE = path.join(root, 'icons', 'logo.png');
const BG = '0x0b0d12';

/** w x h, logo share of the box (0..1) */
const ASSETS = [
  { file: 'StoreLogo.png', w: 50, h: 50, fit: 0.88 },
  { file: 'Square44x44Logo.png', w: 44, h: 44, fit: 0.96 },
  { file: 'LockScreenLogo.png', w: 24, h: 24, fit: 1 },
  { file: 'Square150x150Logo.png', w: 150, h: 150, fit: 0.72 },
  { file: 'Square310x310Logo.png', w: 310, h: 310, fit: 0.72 },
  { file: 'Wide310x150Logo.png', w: 310, h: 150, fit: 0.82 },
  { file: 'SplashScreen.png', w: 620, h: 300, fit: 0.75 },
];

const LISTING = [{ file: 'StoreListingLogo300x300.png', w: 300, h: 300, fit: 0.78 }];

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function run(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed:\n${r.stderr ? r.stderr.toString() : ''}`);
  }
}

/** Scale the logo into w x h, preserving aspect, centred on the background. */
function render(a, out) {
  const box = Math.round(Math.min(a.w, a.h) * a.fit);
  const vf = [
    `scale=${box}:${box}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${a.w}:${a.h}:(ow-iw)/2:(oh-ih)/2:color=${BG}`,
  ].join(',');
  run(['-i', SOURCE, '-vf', vf, '-frames:v', '1', out]);
}

/** Assemble a multi-size PNG-in-ICO (supported by Windows Vista and later). */
function writeIco(pngPaths, out) {
  const images = pngPaths.map((p) => ({ size: path.basename(p, '.png') | 0, data: fs.readFileSync(p) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map((img) => {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // palette colours
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    return e;
  });
  fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`Logo not found: ${path.relative(root, SOURCE)}`);
  }
  const assetsDir = path.join(root, 'store', 'Assets');
  const listingDir = path.join(root, 'store', 'listing');
  const buildDir = path.join(root, 'build');
  for (const d of [assetsDir, listingDir, buildDir]) fs.mkdirSync(d, { recursive: true });

  for (const a of ASSETS) {
    const out = path.join(assetsDir, a.file);
    render(a, out);
    console.log(`  ${a.w}x${a.h}  ${path.relative(root, out)}`);
  }
  for (const a of LISTING) {
    const out = path.join(listingDir, a.file);
    render(a, out);
    console.log(`  ${a.w}x${a.h}  ${path.relative(root, out)}`);
  }

  // electron-builder app icon: multi-size ICO built from the same logo
  const tmp = fs.mkdtempSync(path.join(buildDir, '_ico-'));
  const pngs = ICO_SIZES.map((s) => {
    const p = path.join(tmp, `${s}.png`);
    run(['-i', SOURCE, '-vf', `scale=${s}:${s}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${s}:${s}:(ow-iw)/2:(oh-ih)/2:color=${BG}`, '-frames:v', '1', p]);
    return p;
  });
  const ico = path.join(buildDir, 'icon.ico');
  writeIco(pngs, ico);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  ${ICO_SIZES.join('/')}  ${path.relative(root, ico)}`);
  console.log('\nApp icon + Store assets generated from icons/logo.png.');
}

main();
