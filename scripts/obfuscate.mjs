#!/usr/bin/env node
/**
 * Stage an obfuscated copy of the app for packaging.
 *
 *   node scripts/obfuscate.mjs [--out .build/app] [--include-main] [--no-js]
 *
 * Copies the runtime files (main.js, preload.js, panel-preload.js, lib/, src/,
 * package.json) into `--out`, obfuscates the renderer scripts in `src/` with
 * javascript-obfuscator, and junctions `node_modules` + `vendor` so
 * electron-builder can resolve production deps and extraResources.
 *
 * `--include-main` also obfuscates the main-process files (lib/**\/*.js). That is
 * opt-in: it is the part that talks to Electron/ffmpeg, so verify the build with
 * `scripts/verify-build.mjs` after using it.
 *
 * Obfuscation is deterrence, not encryption — the app still ships as readable
 * machine code at runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const outDir = path.resolve(root, opt('--out', '.build/app'));
const includeMain = has('--include-main');
const noJs = has('--no-js');

const COPY_FILES = ['package.json', 'main.js', 'preload.js', 'panel-preload.js', 'LICENSE'];
const COPY_DIRS = ['lib', 'src'];
const RENDERER_JS = [];
const MAIN_JS = [];

function rimraf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (filter && !filter(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function link(target, linkPath) {
  if (fs.existsSync(linkPath)) return;
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    console.warn(`  ! could not link ${path.basename(linkPath)} (${err.message}); copying instead`);
    fs.cpSync(target, linkPath, { recursive: true });
  }
}

function collectJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJs(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const t0 = Date.now();
console.log('[obfuscate] source :', path.relative(root, root) || '.');
console.log('[obfuscate] output :', path.relative(root, outDir));

/* ── 1. clean + copy ─────────────────────────────────────────── */
rimraf(outDir);
fs.mkdirSync(outDir, { recursive: true });

for (const file of COPY_FILES) {
  const src = path.join(root, file);
  if (!fs.existsSync(src)) continue;
  let body = fs.readFileSync(src);
  if (file === 'package.json') {
    // electron-builder reads `build` from the project root only; a copy inside
    // the app directory makes it complain.
    const pkg = JSON.parse(body.toString('utf8'));
    delete pkg.build;
    delete pkg.devDependencies;
    delete pkg.scripts;
    body = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(outDir, file), body);
}
for (const dir of COPY_DIRS) {
  const src = path.join(root, dir);
  if (fs.existsSync(src)) copyDir(src, path.join(outDir, dir));
}

/* ── 2. obfuscate ────────────────────────────────────────────── */
let totalBefore = 0;
let totalAfter = 0;
if (!noJs) {
  const JavaScriptObfuscator = require('javascript-obfuscator');
  const rendererFiles = collectJs(path.join(outDir, 'src'));
  const mainFiles = includeMain ? collectJs(path.join(outDir, 'lib')) : [];
  const targets = [...rendererFiles, ...mainFiles];
  console.log(`[obfuscate] obfuscating ${targets.length} script(s)${includeMain ? ' (renderer + main)' : ' (renderer only)'}...`);

  for (const file of targets) {
    const code = fs.readFileSync(file, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(code, {
      target: file.includes(`${path.sep}lib${path.sep}`) ? 'node' : 'browser',
      compact: true,
      simplify: true,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false, // window.CUCI / module.exports must stay
      renameProperties: false,
      stringArray: true,
      stringArrayThreshold: 0.75,
      stringArrayEncoding: ['base64'],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      splitStrings: false,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      numbersToExpressions: false,
      transformObjectKeys: false,
      selfDefending: false,
      debugProtection: false,
      disableConsoleOutput: false,
      unicodeEscapeSequence: false,
    });
    const out = result.getObfuscatedCode();
    fs.writeFileSync(file, out, 'utf8');
    totalBefore += Buffer.byteLength(code);
    totalAfter += Buffer.byteLength(out);
    console.log(`  ${path.relative(outDir, file).replace(/\\/g, '/')}  ${(code.length / 1024).toFixed(1)}KB -> ${(out.length / 1024).toFixed(1)}KB`);
  }
} else {
  console.log('[obfuscate] --no-js: copying scripts verbatim');
}

/* ── 3. runtime deps + bundled ffmpeg ────────────────────────── */
link(path.join(root, 'node_modules'), path.join(outDir, 'node_modules'));
if (fs.existsSync(path.join(root, 'vendor'))) link(path.join(root, 'vendor'), path.join(outDir, 'vendor'));
console.log('  linked node_modules/ + vendor/');

/* ── 4. syntax check every script we touched ─────────────────── */
const bad = [];
for (const file of [...collectJs(path.join(outDir, 'src')), ...collectJs(path.join(outDir, 'lib'))]) {
  try {
    // `new Function` compiles classic scripts; node --check would reject the
    // browser-only globals, so parse instead of execute.
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    bad.push(`${path.relative(outDir, file)}: ${err.message}`);
  }
}
if (bad.length) {
  console.error('\n[obfuscate] FAILED — obfuscated scripts do not parse:');
  bad.forEach((b) => console.error('  ' + b));
  process.exit(1);
}

console.log(
  `\n[obfuscate] done in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    (totalBefore ? ` (scripts ${(totalBefore / 1024).toFixed(0)}KB -> ${(totalAfter / 1024).toFixed(0)}KB)` : ''),
);
console.log(`[obfuscate] app dir: ${outDir}`);
