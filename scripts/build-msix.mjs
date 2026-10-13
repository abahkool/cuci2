#!/usr/bin/env node
/**
 * Build a Microsoft Store (MSIX) package for CUCI².
 *
 *   npm run store:assets                  # regenerate placeholder artwork
 *   npm run store:stage                   # build the app + layout dist/msix (no MSIX tool needed)
 *   npm run store:package                 # stage + pack into dist/CUCI2_<version>_<arch>.msix
 *
 * Options:
 *   --stage-only        stop after laying out dist/msix
 *   --no-ffmpeg         drop the bundled ffmpeg (smaller package; see docs/STORE-SUBMISSION.md)
 *   --skip-build        reuse an existing dist/<arch>-unpacked
 *   --identity <file>   identity JSON (default store/identity.json, falls back to the example)
 *   --arch x64|arm64    target architecture (default x64)
 *   --version x.y.z.b   4-part MSIX version (default: package.json version + .0)
 *   --sign <pfx>        sign the package (needs --cert-pass or SIGNCERT_PASS) — local testing only
 *
 * Microsoft signs Store submissions itself; see docs/STORE-SUBMISSION.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/* ── args ──────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const stageOnly = has('--stage-only');
const skipBuild = has('--skip-build');
const noFfmpeg = has('--no-ffmpeg');
const arch = opt('--arch', 'x64');
const identityFile = path.resolve(root, opt('--identity', 'store/identity.json'));
const signPfx = opt('--sign', '');
const certPass = opt('--cert-pass', process.env.SIGNCERT_PASS || '');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const msixVersion = opt('--version', `${pkg.version}.0`);
if (!/^\d+\.\d+\.\d+\.\d+$/.test(msixVersion)) {
  console.error(`MSIX versions must have 4 parts (got "${msixVersion}")`);
  process.exit(1);
}

/* ── identity ──────────────────────────────────────────────────── */
function loadIdentity() {
  let file = identityFile;
  let fromExample = false;
  if (!fs.existsSync(file)) {
    file = path.join(root, 'store', 'identity.example.json');
    fromExample = true;
  }
  const id = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { id, fromExample, file };
}

const { id: identity, fromExample, file: idFile } = loadIdentity();
if (fromExample) {
  console.warn('\n!! store/identity.json not found — using store/identity.example.json.');
  console.warn('   The package will NOT be submittable until it carries your real');
  console.warn('   Partner Center identity (see docs/STORE-SUBMISSION.md).\n');
}

/* ── helpers ───────────────────────────────────────────────────── */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, cwd: root, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
}

function findSdkTool(name) {
  const roots = ['C:\\Program Files (x86)\\Windows Kits\\10\\bin', 'C:\\Program Files\\Windows Kits\\10\\bin'];
  for (const base of roots) {
    if (!fs.existsSync(base)) continue;
    const versions = fs
      .readdirSync(base)
      .filter((v) => /^10\./.test(v))
      .sort()
      .reverse();
    for (const v of versions) {
      for (const a of [arch, 'x64', 'x86']) {
        const p = path.join(base, v, a, name);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  const which = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  return null;
}

/* ── 1. build the app ──────────────────────────────────────────── */
const unpacked = path.join(root, 'dist', arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`);

if (!skipBuild) {
  console.log('\n== building unpacked app ==');
  // Spawn the CLI through node: .cmd shims cannot be spawned directly on Windows
  // (EINVAL since the CVE-2024-27980 fix).
  const ebPkgPath = path.join(root, 'node_modules', 'electron-builder', 'package.json');
  if (!fs.existsSync(ebPkgPath)) {
    console.error('electron-builder is not installed. Run: npm install');
    process.exit(1);
  }
  const ebPkg = JSON.parse(fs.readFileSync(ebPkgPath, 'utf8'));
  const ebBin = typeof ebPkg.bin === 'string' ? ebPkg.bin : ebPkg.bin['electron-builder'];
  run(process.execPath, [path.join(path.dirname(ebPkgPath), ebBin), '--win', '--dir', `--${arch}`]);
}
if (!fs.existsSync(unpacked)) {
  console.error(`\nUnpacked app not found at ${unpacked}\nRun without --skip-build first.`);
  process.exit(1);
}

/* ── 2. lay out the MSIX staging tree ──────────────────────────── */
const stage = path.join(root, 'dist', 'msix');
console.log(`\n== staging into ${path.relative(root, stage)} ==`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'Assets'), { recursive: true });

fs.cpSync(unpacked, path.join(stage, 'app'), { recursive: true });
fs.cpSync(path.join(root, 'store', 'Assets'), path.join(stage, 'Assets'), { recursive: true });

if (noFfmpeg) {
  const ff = path.join(stage, 'app', 'resources', 'ffmpeg');
  if (fs.existsSync(ff)) {
    fs.rmSync(ff, { recursive: true, force: true });
    console.log('  removed bundled ffmpeg (app will use a system install)');
  }
}

// onnxruntime-node ships native binaries for every OS/arch. Keep only the one
// this package targets — saves ~200 MB. Safe: the loader picks by
// process.platform/process.arch at runtime.
{
  const ortBin = path.join(stage, 'app', 'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin');
  let pruned = 0;
  if (fs.existsSync(ortBin)) {
    for (const ver of fs.readdirSync(ortBin)) {
      const verDir = path.join(ortBin, ver);
      for (const platform of fs.readdirSync(verDir)) {
        const platformDir = path.join(verDir, platform);
        if (platform !== 'win32') {
          pruned += 1;
          fs.rmSync(platformDir, { recursive: true, force: true });
          continue;
        }
        for (const a of fs.readdirSync(platformDir)) {
          if (a !== arch) {
            pruned += 1;
            fs.rmSync(path.join(platformDir, a), { recursive: true, force: true });
          }
        }
      }
    }
  }
  if (pruned) console.log(`  pruned ${pruned} non-${arch} onnxruntime binary set(s)`);
}

const manifest = fs
  .readFileSync(path.join(root, 'store', 'AppxManifest.xml.template'), 'utf8')
  .replaceAll('{{IDENTITY_NAME}}', identity.identityName)
  .replaceAll('{{PUBLISHER}}', identity.publisher)
  .replaceAll('{{VERSION}}', msixVersion)
  .replaceAll('{{ARCH}}', arch)
  .replaceAll('{{DISPLAY_NAME}}', identity.displayName)
  .replaceAll('{{PUBLISHER_DISPLAY_NAME}}', identity.publisherDisplayName)
  .replaceAll('{{DESCRIPTION}}', identity.description)
  .replaceAll('{{SHORT_NAME}}', identity.shortName || identity.displayName);
fs.writeFileSync(path.join(stage, 'AppxManifest.xml'), manifest);
console.log(`  AppxManifest.xml (${identity.identityName} ${msixVersion} ${arch})`);

const sizeMb = (dir) => {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return (total / 1048576).toFixed(0);
};
console.log(`  staged size: ${sizeMb(stage)} MB${noFfmpeg ? '' : ' (includes bundled ffmpeg)'}`);

if (stageOnly) {
  console.log('\nStaging complete. Point the MSIX Packaging Tool at dist/msix, or re-run without --stage-only.');
  process.exit(0);
}

/* ── 3. pack ───────────────────────────────────────────────────── */
const makeappx = findSdkTool('makeappx.exe');
const outMsix = path.join(root, 'dist', `CUCI2_${msixVersion}_${arch}.msix`);

if (!makeappx) {
  console.error(
    [
      '',
      'makeappx.exe was not found, so the .msix could not be packed.',
      '',
      'Install the MSIX packaging tools, then re-run:',
      '  winget install --id Microsoft.Windows SDK   (or add "MSIX Packaging Tools" via the',
      '  Visual Studio Installer / Windows SDK setup)',
      '  — or install the “MSIX Packaging Tool” from the Store and open dist/msix.',
      '',
      `The staging tree is ready at: ${stage}`,
      'See docs/STORE-SUBMISSION.md for the full walkthrough.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

console.log('\n== packing ==');
run(makeappx, ['pack', '/d', stage, '/p', outMsix, '/o']);
console.log(`  ${path.relative(root, outMsix)} (${(fs.statSync(outMsix).size / 1048576).toFixed(0)} MB)`);

/* ── 4. optional local signing ─────────────────────────────────── */
if (signPfx) {
  const signtool = findSdkTool('signtool.exe');
  if (!signtool) {
    console.error('signtool.exe not found — cannot sign.');
    process.exit(3);
  }
  console.log('\n== signing (local testing) ==');
  run(signtool, ['sign', '/fd', 'SHA256', '/f', signPfx, ...(certPass ? ['/p', certPass] : []), outMsix]);
  console.log('  signed');
}

console.log('\nDone. See docs/STORE-SUBMISSION.md for the checklist before uploading.');
