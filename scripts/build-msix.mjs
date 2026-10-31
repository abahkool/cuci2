#!/usr/bin/env node
/**
 * Build a Microsoft Store (MSIX) package for CUCI.
 *
 *   npm run store:assets                  # regenerate placeholder artwork
 *   npm run store:stage                   # build the app + layout dist/msix (no MSIX tool needed)
 *   npm run store:package                 # stage + pack into dist/CUCI_<version>_<arch>.msix
 *   npm run store:appx                    # same, but emits the legacy .appx container
 *
 * Options:
 *   --stage-only        stop after laying out dist/msix
 *   --appx              emit CUCI_<version>_<arch>.appx instead of .msix
 *   --no-ffmpeg         drop the bundled ffmpeg (smaller package; see docs/STORE-SUBMISSION.md)
 *   --skip-build        reuse an existing dist/<arch>-unpacked
 *   --app-dir <dir>     build this app directory (used for the obfuscated stage)
 *   --identity <file>   identity JSON (default store/identity.json, falls back to the example)
 *   --allow-example-identity  pack anyway with placeholder identity (local testing only —
 *                       Partner Center rejects such a package)
 *   --arch x64|arm64    target architecture (default x64)
 *   --version x.y.z.b   4-part MSIX version (default: package.json version + .0)
 *   --sign <pfx>        sign the package (needs --cert-pass or SIGNCERT_PASS) — local testing only
 *   --no-download       never fetch the Windows SDK build tools from NuGet
 *
 * makeappx.exe comes from the Windows SDK when installed; otherwise the SDK
 * BuildTools package is downloaded once into vendor/msix-tools/ (Microsoft
 * signed, same tool). Microsoft re-signs Store submissions itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureSdkTool } from './msix-tools.mjs';

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
const appx = has('--appx');
const noDownload = has('--no-download');
const appDirArg = opt('--app-dir', '');
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
const allowExampleIdentity = has('--allow-example-identity');

/*
 * Fail fast: Partner Center validates the manifest against the reserved product,
 * so a placeholder identity costs a full build plus a 200+ MB upload and then:
 *   "The PublisherDisplayName element in the app manifest is X, which doesn't
 *    match your publisher display name: Y."
 * (and the all-zero publisher GUID is rejected for the same reason).
 */
const PLACEHOLDER_PUBLISHER = /^CN=0{8}-0{4}-0{4}-0{4}-0{12}$/i;
const GUID_PUBLISHER = /^CN=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identityProblems(id) {
  const out = [];
  const v = (k) => String(id[k] ?? '').trim();
  if (!v('identityName')) out.push('identityName is empty — copy Package/Identity/Name from Partner Center');
  else if (!/^[A-Za-z0-9._-]+$/.test(v('identityName'))) {
    out.push(`identityName "${v('identityName')}" has illegal characters (A-Z a-z 0-9 . _ - only)`);
  }
  if (!v('publisher')) out.push('publisher is empty — copy Package/Identity/Publisher (CN=<GUID>) from Partner Center');
  else if (PLACEHOLDER_PUBLISHER.test(v('publisher'))) out.push('publisher is still the placeholder all-zero GUID');
  else if (!GUID_PUBLISHER.test(v('publisher'))) out.push(`publisher "${v('publisher')}" must look like CN=1A2B3C4D-1111-2222-3333-444455556666`);
  if (!v('publisherDisplayName')) {
    out.push('publisherDisplayName is empty — it must equal the Publisher display name of your Partner Center account');
  }
  if (!v('displayName')) out.push('displayName is empty');
  if (v('shortName') && v('shortName').length > 40) out.push('shortName must be ≤ 40 characters (tile limit)');
  return out;
}

const problems = identityProblems(identity);
const identitySubmittable = !fromExample && problems.length === 0;

if (!identitySubmittable) {
  const lines = ['', '== package identity is NOT submittable =='];
  if (fromExample) lines.push(`  using the example file: ${path.relative(root, idFile)}`);
  for (const p of problems) lines.push(`  - ${p}`);
  if (allowExampleIdentity) {
    lines.push('', '  --allow-example-identity given: continuing anyway (local testing only).', '');
    console.warn(lines.join('\n'));
  } else {
    lines.push(
      '',
      '  Unlike any other build artifact, an MSIX is validated field-by-field against',
      '  your reserved product, so a placeholder identity is rejected at submission:',
      '    "The PublisherDisplayName element ... doesn\'t match your publisher display name."',
      '',
      '  Fix: cp store/identity.example.json store/identity.json and fill it in from',
      '  Partner Center → your app → Product identity (plus the account\'s Publisher',
      '  display name). See docs/STORE-SUBMISSION.md §2 and §11 (submission errors).',
      '',
      '  For a throwaway test package: re-run with --allow-example-identity',
      '',
    );
    console.error(lines.join('\n'));
    process.exit(5);
  }
}

console.log('\n== identity ==');
console.log(`  Name        ${identity.identityName}`);
console.log(`  Publisher   ${identity.publisher}`);
console.log(`  Display     ${identity.publisherDisplayName}  (must match your Partner Center account)`);

/* ── helpers ───────────────────────────────────────────────────── */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, cwd: root, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
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
  const ebArgs = [path.join(path.dirname(ebPkgPath), ebBin), '--win', '--dir', `--${arch}`];
  if (appDirArg) ebArgs.push(`--config.directories.app=${path.resolve(root, appDirArg)}`);
  run(process.execPath, ebArgs);
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
const ext = appx ? 'appx' : 'msix';
const outPkg = path.join(root, 'dist', `CUCI_${msixVersion}_${arch}.${ext}`);

console.log(`\n== locating makeappx (${ext}) ==`);
const makeappx = await ensureSdkTool('makeappx.exe', { root, arch, allowDownload: !noDownload });
if (!makeappx) {
  console.error(
    [
      '',
      'makeappx.exe is not installed and could not be provisioned (offline?).',
      '',
      'Either install the MSIX packaging tools:',
      '  winget install --id Microsoft.Windows SDK   (or add "MSIX Packaging Tools" via the',
      '  Visual Studio Installer / Windows SDK setup)',
      'or allow the one-off NuGet download (do not pass --no-download).',
      '',
      `The staging tree is ready at: ${stage}`,
      'See docs/STORE-SUBMISSION.md for the full walkthrough.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}
console.log('  ' + makeappx);

console.log(`\n== packing .${ext} ==`);
run(makeappx, ['pack', '/d', stage, '/p', outPkg, '/o']);
const pkgMb = (fs.statSync(outPkg).size / 1048576).toFixed(0);
console.log(`  ${path.relative(root, outPkg)} (${pkgMb} MB)`);

// Round-trip check: makeappx must be able to unpack what it just produced.
if (!noDownload) {
  const verifyDir = path.join(root, 'dist', '.msix-verify');
  fs.rmSync(verifyDir, { recursive: true, force: true });
  try {
    run(makeappx, ['unpack', '/p', outPkg, '/d', verifyDir]);
    const manifest = path.join(verifyDir, 'AppxManifest.xml');
    console.log(`  package verified (unpacked, manifest ${fs.existsSync(manifest) ? 'present' : 'MISSING'})`);
  } catch (err) {
    console.error(`  ! package verification failed: ${err.message}`);
    process.exit(4);
  } finally {
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }
}

/* ── 4. optional local signing ─────────────────────────────────── */
if (signPfx) {
  const signtool = await ensureSdkTool('signtool.exe', { root, arch, allowDownload: !noDownload });
  if (!signtool) {
    console.error('signtool.exe not found — cannot sign.');
    process.exit(3);
  }
  console.log('\n== signing (local testing) ==');
  run(signtool, ['sign', '/fd', 'SHA256', '/f', signPfx, ...(certPass ? ['/p', certPass] : []), outPkg]);
  console.log('  signed');
}

console.log('\nDone. See docs/STORE-SUBMISSION.md for the checklist before uploading.');
