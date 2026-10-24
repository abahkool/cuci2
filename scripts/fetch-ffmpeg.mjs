#!/usr/bin/env node
/**
 * Download a recent ffmpeg + ffprobe into vendor/ffmpeg/ so the app can ship a
 * bundled fallback (used only when the user has no system ffmpeg).
 *
 *   node scripts/fetch-ffmpeg.mjs           # skip if already present
 *   node scripts/fetch-ffmpeg.mjs --force   # re-download
 *   node scripts/fetch-ffmpeg.mjs --strict  # exit non-zero on failure (for dist)
 *
 * Skipped entirely when CUCI_SKIP_FFMPEG_FETCH=1 (legacy: CUCI2_SKIP_FFMPEG_FETCH).
 *
 * Sources (latest release of each channel):
 *   win32-x64   gyan.dev "release essentials" zip (ffmpeg + ffprobe, libass)
 *   linux-x64   johnvansickle.com static build (ffmpeg + ffprobe)
 *   linux-arm64 johnvansickle.com static build (arm64)
 *   darwin-x64  evermeet.cx (ffmpeg and ffprobe separately)
 *   darwin-arm64 evermeet.cx (universal)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'vendor', 'ffmpeg');
const cacheDir = path.join(root, 'vendor', '.cache');
const exe = process.platform === 'win32' ? '.exe' : '';

const force = process.argv.includes('--force');
const strict = process.argv.includes('--strict');

function log(...a) {
  console.log('[fetch-ffmpeg]', ...a);
}

if (process.env.CUCI_SKIP_FFMPEG_FETCH === '1' || process.env.CUCI2_SKIP_FFMPEG_FETCH === '1') {
  log('skipped (CUCI_SKIP_FFMPEG_FETCH=1)');
  process.exit(0);
}

const targets = [`ffmpeg${exe}`, `ffprobe${exe}`];
const present = () => targets.every((t) => fs.existsSync(path.join(vendorDir, t)));

if (present() && !force) {
  log('already vendored at', path.relative(root, vendorDir));
  process.exit(0);
}

function sources() {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case 'win32-x64':
    case 'win32-arm64':
      return [{ url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', kind: 'zip' }];
    case 'linux-x64':
      return [{ url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz', kind: 'tar.xz' }];
    case 'linux-arm64':
      return [{ url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz', kind: 'tar.xz' }];
    case 'darwin-x64':
    case 'darwin-arm64':
      return [
        { url: 'https://evermeet.cx/ffmpeg/getrelease/zip', kind: 'zip', bin: 'ffmpeg' },
        // evermeet serves ffprobe under the /ffmpeg/ path
        { url: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip', kind: 'zip', bin: 'ffprobe' },
      ];
    default:
      return [];
  }
}

function haveCurl() {
  const r = spawnSync('curl', ['--version'], { stdio: 'ignore', windowsHide: true });
  return !r.error && r.status === 0;
}

async function downloadWithFetch(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

/** Download to a stable cache path, resuming a partial file when possible. */
async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const before = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  log(`downloading ${url}${before ? ` (resuming from ${(before / 1048576).toFixed(1)} MB)` : ''}`);

  if (haveCurl()) {
    const common = ['-L', '--fail', '--retry', '5', '--retry-delay', '3', '--retry-all-errors', '-o', dest];
    let r = spawnSync('curl', ['-C', '-', ...common, url], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0) {
      // A server that does not support ranges, or a stale/corrupt partial: retry fresh.
      log('  resume failed, retrying from scratch');
      fs.rmSync(dest, { force: true });
      r = spawnSync('curl', [...common, url], { stdio: 'ignore', windowsHide: true });
    }
    if (r.status !== 0 || !fs.existsSync(dest)) throw new Error(`curl failed (status ${r.status}) for ${url}`);
  } else {
    await downloadWithFetch(url, dest);
  }

  const mb = (fs.statSync(dest).size / 1048576).toFixed(1);
  log(`  → ${mb} MB`);
}

function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const attempts = [];
  if (archive.endsWith('.zip')) {
    attempts.push(['unzip', ['-o', '-q', archive, '-d', destDir]]);
    if (process.platform === 'win32') {
      const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      if (fs.existsSync(sysTar)) attempts.push([sysTar, ['-xf', archive, '-C', destDir]]);
    } else {
      attempts.push(['tar', ['-xf', archive, '-C', destDir]]);
    }
    attempts.push(['7z', ['x', '-y', `-o${destDir}`, archive]]);
  } else if (archive.endsWith('.tar.xz')) {
    attempts.push(['tar', ['-xJf', archive, '-C', destDir]]);
  } else {
    throw new Error(`unsupported archive: ${archive}`);
  }
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return;
  }
  throw new Error(`no working extractor for ${path.basename(archive)} (tried ${attempts.map((a) => a[0]).join(', ')})`);
}

function findBinary(dir, name) {
  const stack = [dir];
  const wanted = name.toLowerCase();
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === wanted) return p;
    }
  }
  return null;
}

async function main() {
  const list = sources();
  if (!list.length) throw new Error(`no ffmpeg source for ${process.platform}-${process.arch}`);

  fs.mkdirSync(vendorDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuci-fetch-'));

  try {
    let i = 0;
    for (const src of list) {
      i += 1;
      const archive = path.join(cacheDir, `pkg${i}.${src.kind === 'zip' ? 'zip' : 'tar.xz'}`);
      const outDir = path.join(tmp, `x${i}`);
      await download(src.url, archive);
      extract(archive, outDir);

      const names = src.bin ? [src.bin + exe] : targets;
      for (const name of names) {
        const found = findBinary(outDir, name);
        if (!found) {
          log(`warning: ${name} not found in archive`);
          continue;
        }
        const dest = path.join(vendorDir, name);
        fs.copyFileSync(found, dest);
        if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
        log('installed', path.relative(root, dest));
      }
    }

    if (!present()) throw new Error('finished but ffmpeg/ffprobe are still missing');
    log('done');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  log('FAILED:', err.message);
  log('The app will still work if ffmpeg is installed on the system PATH.');
  process.exit(strict ? 1 : 0);
});
