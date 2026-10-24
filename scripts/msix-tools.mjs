#!/usr/bin/env node
/**
 * Locate (or provision) the Windows SDK tools used to pack MSIX/APPX files.
 *
 * Search order for makeappx.exe / signtool.exe:
 *   1. vendor/msix-tools/<version>/<arch>/   (provisioned by this module)
 *   2. C:\Program Files (x86)\Windows Kits\10\bin\<ver>\<arch>\
 *   3. PATH
 *   4. Download `Microsoft.Windows.SDK.BuildTools` from NuGet (~22 MB) and
 *      extract the tools into vendor/msix-tools/ — this is the same Microsoft
 *      signed makeappx the Windows SDK ships, so no hand-rolled package writer.
 *
 * `allowDownload: false` (CLI `--no-download`) keeps builds fully offline.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const NUGET = 'https://www.nuget.org/api/v2/package/Microsoft.Windows.SDK.BuildTools';
const VERSIONS = [process.env.MSIX_TOOLS_VERSION, '10.0.26100.1742', '10.0.22621.756', '10.0.22000.832'].filter(Boolean);

/* ── zip helpers (no dependencies) ─────────────────────────────── */
function readZipEntries(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, size, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  const local = entry.localOff;
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression ${entry.method}`);
}

/** Extract every entry whose name starts with `prefix` into `destDir`. */
export function extractZip(buf, prefix, destDir) {
  let written = 0;
  for (const entry of readZipEntries(buf)) {
    if (!entry.name.startsWith(prefix) || entry.name.endsWith('/')) continue;
    const rel = entry.name.slice(prefix.length);
    if (!rel || rel.includes('..')) continue;
    const out = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, extractEntry(buf, entry));
    written += 1;
  }
  return written;
}

/* ── SDK lookup ────────────────────────────────────────────────── */
const SDK_ROOTS = ['C:\\Program Files (x86)\\Windows Kits\\10\\bin', 'C:\\Program Files\\Windows Kits\\10\\bin'];

export function sdkTool(name, arch = 'x64') {
  for (const base of SDK_ROOTS) {
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

export function vendoredTool(root, name, arch = 'x64') {
  const dir = path.join(root, 'vendor', 'msix-tools');
  if (!fs.existsSync(dir)) return null;
  for (const version of fs.readdirSync(dir)) {
    const p = path.join(dir, version, arch, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function download(version) {
  const url = `${NUGET}/${version}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Return a path to `name` (makeappx.exe / signtool.exe), provisioning the SDK
 * build tools into vendor/msix-tools/ when they are not installed.
 */
export async function ensureSdkTool(name, { root, arch = 'x64', allowDownload = true, log = console.log } = {}) {
  const local = vendoredTool(root, name, arch);
  if (local) return local;
  const sdk = sdkTool(name, arch);
  if (sdk) return sdk;
  if (!allowDownload) return null;

  const cacheDir = path.join(root, 'vendor', 'msix-tools', '_cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  let buf = null;
  let version = '';
  for (const v of VERSIONS) {
    const cached = path.join(cacheDir, `${v}.nupkg`);
    if (fs.existsSync(cached)) {
      buf = fs.readFileSync(cached);
      version = v;
      break;
    }
    log(`  downloading Windows SDK build tools ${v} from NuGet (one-off, ~22 MB)...`);
    try {
      buf = await download(v);
      fs.writeFileSync(cached, buf);
      version = v;
      break;
    } catch (err) {
      log(`  ! ${v} unavailable (${err.message})`);
    }
  }
  if (!buf) return null;

  const dest = path.join(root, 'vendor', 'msix-tools', version, arch);
  let written = 0;
  // The package layout is bin/<sdk version>/<arch>/...
  for (const entry of readZipEntries(buf)) {
    const m = /^bin\/([^/]+)\/([^/]+)\//.exec(entry.name);
    if (!m || m[2] !== arch) continue;
    written += extractZip(buf, `bin/${m[1]}/${arch}/`, dest);
    break;
  }
  if (!written) {
    log('  ! unexpected NuGet layout — could not extract the tools');
    return null;
  }
  log(`  tools extracted to ${path.relative(root, dest)}`);
  const found = path.join(dest, name);
  return fs.existsSync(found) ? found : null;
}
