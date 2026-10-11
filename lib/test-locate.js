'use strict';

/**
 * Verifies the ffmpeg/ffprobe resolution chain in lib/ffmpeg-locate.js:
 *   custom -> env -> system -> bundled, with graceful fall-through.
 *
 *   node lib/test-locate.js
 *
 * The bundled checks are skipped when vendor/ffmpeg/ is absent (fresh clone),
 * so this passes with just a system ffmpeg too.
 */

const assert = require('node:assert');
const locate = require('./ffmpeg-locate');

function show(tag, r) {
  console.log(`${tag.padEnd(22)}: ${r.source.padEnd(8)} ${r.version || ''} ${r.path || ''}`.trimEnd());
}

// 1. default resolution must find *something* runnable
const def = locate.resolve({});
show('default ffmpeg', def.ffmpeg);
show('default ffprobe', def.ffprobe);
assert.ok(def.ffmpeg.ok, 'ffmpeg should resolve from custom/env/system/bundled');
assert.ok(def.ffprobe.ok, 'ffprobe should resolve from custom/env/system/bundled');

// 2. a bad custom path must not win — it should fall through
locate.invalidate();
const bad = locate.resolve({ ffmpegPath: 'C:/definitely/not/here/ffmpeg.exe' });
show('bad custom path', bad.ffmpeg);
assert.ok(bad.ffmpeg.ok, 'should fall through a non-runnable custom path');
assert.notStrictEqual(bad.ffmpeg.source, 'custom', 'bad custom path must not be selected');

// 3. bundled-specific checks (only when the binaries were fetched)
const bundledFfmpeg = locate.bundledBin('ffmpeg');
if (bundledFfmpeg) {
  locate.invalidate();
  const prefer = locate.resolve({ preferBundled: true });
  show('preferBundled', prefer.ffmpeg);
  assert.strictEqual(prefer.ffmpeg.source, 'bundled', 'preferBundled should select the bundled binary');
  assert.strictEqual(prefer.ffmpeg.path, bundledFfmpeg);
  assert.ok(prefer.ffmpeg.libass, 'bundled ffmpeg must have libass (subtitle burn)');

  locate.invalidate();
  const explicit = locate.resolve({ ffmpegPath: bundledFfmpeg });
  assert.strictEqual(explicit.ffmpeg.source, 'custom', 'an explicit path wins over bundled');
} else {
  console.log('bundled ffmpeg        : not present — run `npm run fetch:ffmpeg` (skipping bundled checks)');
}

console.log('\nLOCATE TEST: PASS ✅');
