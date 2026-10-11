'use strict';

/**
 * Locate the ffmpeg / ffprobe executables.
 *
 * Priority (highest first):
 *   1. explicit path from Settings          -> source "custom"
 *   2. FFMPEG_PATH / FFPROBE_PATH env vars  -> source "env"
 *   3. a system install on PATH             -> source "system"
 *   4. a bundled binary                     -> source "bundled"
 *
 * The bundled copy is therefore only used when the user has no ffmpeg of their
 * own. A "Prefer bundled" setting swaps the order of 3 and 4.
 *
 * Bundled binaries are looked up in, in order:
 *   - <resources>/ffmpeg/            (packaged app, via electron-builder extraResources)
 *   - <appRoot>/vendor/ffmpeg/       (dev checkout, see scripts/fetch-ffmpeg.mjs)
 *   - the `ffmpeg-static` / `ffprobe-static` npm packages
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

let cache = null; // { key, value }

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Run `bin -version`; returns the version string or null if it is not runnable. */
function probeVersion(bin) {
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.error || r.status !== 0) return null;
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const version = (out.match(/version\s+(\S+)/i) || [])[1] || 'unknown';
    return { version, banner: out.split('\n')[0].trim(), full: out };
  } catch {
    return null;
  }
}

function hasLibass(banner) {
  return /--enable-libass/.test(banner || '');
}

/** Candidate directories that may contain bundled binaries. */
function bundledDirs() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'ffmpeg'));
  dirs.push(path.join(__dirname, '..', 'vendor', 'ffmpeg'));
  return dirs;
}

function bundledFromDir(kind) {
  const name = kind + EXE;
  for (const dir of bundledDirs()) {
    const p = path.join(dir, name);
    if (isFile(p)) return p;
  }
  return null;
}

function bundledFromPackage(kind) {
  try {
    if (kind === 'ffmpeg') {
      const p = require('ffmpeg-static');
      if (typeof p === 'string' && isFile(p)) return p;
    } else {
      const p = require('ffprobe-static');
      const bin = p && (p.path || p);
      if (typeof bin === 'string' && isFile(bin)) return bin;
    }
  } catch {
    /* package not installed */
  }
  return null;
}

function bundledBin(kind) {
  return bundledFromDir(kind) || bundledFromPackage(kind);
}

function siblingProbe(ffmpegPath) {
  if (!ffmpegPath || !path.isAbsolute(ffmpegPath)) return null;
  const cand = path.join(path.dirname(ffmpegPath), 'ffprobe' + EXE);
  return isFile(cand) ? cand : null;
}

function candidates(kind, settings, resolvedFfmpegPath) {
  const list = [];
  const custom = String((kind === 'ffmpeg' ? settings.ffmpegPath : settings.ffprobePath) || '').trim();
  if (custom) list.push({ bin: custom, source: 'custom' });

  const envVal = process.env[kind === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (envVal) list.push({ bin: envVal, source: 'env' });

  // If we already know where ffmpeg lives, its ffprobe sibling is a strong hint.
  if (kind === 'ffprobe') {
    const sib = siblingProbe(resolvedFfmpegPath);
    if (sib) list.push({ bin: sib, source: 'sibling' });
  }

  const system = { bin: kind, source: 'system' };
  const bundled = bundledBin(kind);

  if (settings.preferBundled) {
    if (bundled) list.push({ bin: bundled, source: 'bundled' });
    list.push(system);
  } else {
    list.push(system);
    if (bundled) list.push({ bin: bundled, source: 'bundled' });
  }
  return list;
}

function resolveOne(kind, settings, resolvedFfmpegPath) {
  const warnings = [];
  for (const cand of candidates(kind, settings, resolvedFfmpegPath)) {
    const v = probeVersion(cand.bin);
    if (v) {
      return {
        ok: true,
        path: cand.bin,
        source: cand.source,
        version: v.version,
        banner: v.banner,
        libass: hasLibass(v.full),
        warnings,
      };
    }
    warnings.push(`${kind}: ${cand.source} candidate is not runnable (${cand.bin})`);
  }
  return { ok: false, path: '', source: 'missing', version: '', banner: '', libass: false, warnings };
}

/**
 * Resolve both tools. Cached until `invalidate()` is called (settings change).
 * @param {object} settings  { ffmpegPath, ffprobePath, preferBundled }
 */
function resolve(settings = {}) {
  const key = JSON.stringify({
    a: settings.ffmpegPath || '',
    b: settings.ffprobePath || '',
    c: !!settings.preferBundled,
    env: [process.env.FFMPEG_PATH || '', process.env.FFPROBE_PATH || ''],
    resources: process.resourcesPath || '',
  });
  if (cache && cache.key === key) return cache.value;

  const ffmpeg = resolveOne('ffmpeg', settings, null);
  const ffprobe = resolveOne('ffprobe', settings, ffmpeg.path);
  const value = { ffmpeg, ffprobe, warnings: [...ffmpeg.warnings, ...ffprobe.warnings] };
  cache = { key, value };
  return value;
}

function invalidate() {
  cache = null;
}

/** Convenience accessors used across the IPC layer. */
function ffmpegPath(settings) {
  const r = resolve(settings);
  return r.ffmpeg.ok ? r.ffmpeg.path : 'ffmpeg';
}

function ffprobePath(settings) {
  const r = resolve(settings);
  return r.ffprobe.ok ? r.ffprobe.path : 'ffprobe';
}

/** Where the bundled binary would be, whether or not it exists yet. */
function bundledLocation(kind) {
  const dir = bundledDirs()[0] || path.join(__dirname, '..', 'vendor', 'ffmpeg');
  return path.join(dir, kind + EXE);
}

module.exports = { resolve, invalidate, ffmpegPath, ffprobePath, bundledBin, bundledLocation, probeVersion };
