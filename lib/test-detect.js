'use strict';

/**
 * Content-detection tests (NSFW + violence).
 *
 *   node lib/test-detect.js
 *
 * Pure helpers (tensor normalisation, softmax, range grouping) always run.
 * The live scan checks only run for detectors whose ONNX model is available
 * locally, so a fresh clone passes with just the unit tests.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const detect = require('./content-detect');

const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

/* ── detector registry ─────────────────────────────────────────── */
{
  assert.deepStrictEqual(detect.DETECTOR_KEYS.sort(), ['nsfw', 'violence']);
  assert.strictEqual(detect.DETECTORS.nsfw.positiveIndex, 1, 'nsfw is index 1 of [sfw, nsfw]');
  assert.strictEqual(detect.DETECTORS.violence.positiveIndex, 0, 'violence is index 0 of [violence, non-violence]');
  assert.strictEqual(detect.DETECTORS.violence.size, 224);
  assert.strictEqual(detect.DETECTORS.nsfw.size, 384);
  console.log('registry      : PASS ✅');
}

/* ── frameToTensor ─────────────────────────────────────────────── */
{
  const size = 2;
  const rgb = Buffer.from([0, 0, 0, 255, 255, 255, 128, 128, 128, 255, 0, 0]);
  const t = detect.frameToTensor(rgb, size, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  assert.strictEqual(t.length, 3 * size * size, 'tensor should be CHW float32');
  assert.ok(near(t[0], -1), 'black -> -1');
  assert.ok(near(t[1], 1), 'white -> 1');
  assert.ok(near(t[2], (128 / 255 - 0.5) / 0.5, 1e-3), 'mid -> ~0');
  const area = size * size;
  assert.ok(near(t[3], 1), 'red R -> 1');
  assert.ok(near(t[area + 3], -1), 'red G -> -1');
  assert.ok(near(t[2 * area + 3], -1), 'red B -> -1');
  console.log('frameToTensor : PASS ✅');
}

/* ── softmax ───────────────────────────────────────────────────── */
{
  const a = detect.softmax([0, 0]);
  assert.ok(near(a[0], 0.5) && near(a[1], 0.5), 'uniform logits -> uniform probs');
  const b = detect.softmax([1, 0]);
  assert.ok(near(b[0], 0.7310586, 1e-5) && near(b[1], 0.2689414, 1e-5));
  assert.ok(near(detect.softmax([5, 5]).reduce((x, y) => x + y, 0), 1), 'sums to 1');
  console.log('softmax       : PASS ✅');
}

/* ── groupDetections ───────────────────────────────────────────── */
{
  const samples = [
    { timeMs: 0, score: 0.9 },
    { timeMs: 1000, score: 0.8 },
    { timeMs: 2000, score: 0.1 },
    { timeMs: 3000, score: 0.95 },
    { timeMs: 4000, score: 0.2 },
  ];

  const g = detect.groupDetections(samples, 1000, 5000, { threshold: 0.75, minDurationMs: 0, padMs: 0 });
  assert.strictEqual(g.length, 2, 'two separate runs');
  assert.deepStrictEqual([g[0].start, g[0].end], [0, 2000], 'consecutive positives merge');
  assert.strictEqual(g[0].frames, 2);
  assert.ok(near(g[0].maxScore, 0.9));
  assert.deepStrictEqual([g[1].start, g[1].end], [3000, 4000], 'single positive sample');

  const min = detect.groupDetections(samples, 1000, 5000, { threshold: 0.75, minDurationMs: 1500 });
  assert.strictEqual(min.length, 1);

  const padded = detect.groupDetections(samples, 1000, 5000, { threshold: 0.75, minDurationMs: 0, padMs: 500 });
  assert.deepStrictEqual([padded[0].start, padded[0].end], [0, 2500]);

  const none = detect.groupDetections(samples, 1000, 5000, { threshold: 0.99, minDurationMs: 0, padMs: 0 });
  assert.strictEqual(none.length, 0);

  const last = detect.groupDetections([{ timeMs: 4900, score: 0.99 }], 1000, 5000, { threshold: 0.75, minDurationMs: 0, padMs: 0 });
  assert.strictEqual(last[0].end, 5000, 'end clamped to duration');
  console.log('groupDetections: PASS ✅');
}

/* ── optional live scans ───────────────────────────────────────── */
const userData = path.join(os.tmpdir(), 'cuci2-detect-test');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuci2-detect-'));
const clip = path.join(tmp, 'clip.mp4');
const gen = spawnSync(
  'ffmpeg',
  ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=6', '-pix_fmt', 'yuv420p', clip],
  { windowsHide: true },
);
assert.strictEqual(gen.status, 0, 'ffmpeg should generate a test clip');

(async () => {
  for (const key of detect.DETECTOR_KEYS) {
    const st = detect.modelStatus(key, userData);
    if (!st.installed) {
      console.log(`live ${key.padEnd(9)}: SKIPPED (no model — scan once or set ${key === 'nsfw' ? 'CUCI2_NSFW_MODEL_DIR' : 'CUCI2_VIOLENCE_MODEL_DIR'})`);
      continue;
    }
    const res = await detect.scanVideo(key, {
      ffmpegPath: 'ffmpeg',
      videoPath: clip,
      durationMs: 6000,
      intervalMs: 2000,
      threshold: detect.DETECTORS[key].defaultThreshold,
      padMs: 0,
      userData,
    });
    console.log(
      `live ${key.padEnd(9)}: scanned=${res.scannedFrames}/${res.expectedFrames} positives=${res.positives} segments=${res.segments.length} input=${res.model.size}`,
    );
    assert.ok(res.scannedFrames >= 2, `${key}: should classify at least 2 frames`);
    assert.strictEqual(res.detector, key);
    assert.strictEqual(res.model.size, detect.DETECTORS[key].size);
    assert.ok(Array.isArray(res.segments));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nDETECT TEST: PASS ✅');
})().catch((err) => {
  console.error('live scan     : FAIL ❌', err.message);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
