'use strict';

/**
 * Content scanning (NSFW / violence).
 *
 * Generic engine shared by every detector: fetch and cache an ONNX image
 * classifier, sample the video with ffmpeg, classify each frame and turn
 * consecutive flagged samples into cut ranges.
 *
 * Frames are pulled straight out of ffmpeg as raw RGB24 at the model's input
 * size, so there is no image-decoding dependency (no sharp / canvas).
 *
 * Model notes
 * -----------
 * - nsfw     : AdamCodd/vit-base-nsfw-detector (binary sfw/nsfw). Chosen because
 *              Falconsai/nsfw_image_detection only publishes PyTorch weights.
 * - violence : onnx-community/vit-base-violence-detection-ONNX, the ONNX
 *              conversion of jaranohaal/vit-base-violence-detection (binary
 *              violent / non-violent). Its config ships no `id2label`, so the
 *              index order was determined empirically by running clearly
 *              non-violent frames: index 1 scores as "non-violence", hence
 *              index 0 is "violence".
 *
 * There is currently no ONNX gore detector on the Hub.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DETECTORS = {
  nsfw: {
    key: 'nsfw',
    label: 'NSFW',
    repo: 'AdamCodd/vit-base-nsfw-detector',
    file: 'onnx/model_quantized.onnx',
    bytes: 88_500_985,
    size: 384,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    labels: ['sfw', 'nsfw'],
    positiveIndex: 1,
    defaultThreshold: 0.3,
    defaultMinDurationMs: 5000,
    note: 'ONNX equivalent of Falconsai/nsfw_image_detection',
  },
  violence: {
    key: 'violence',
    label: 'Violence',
    repo: 'onnx-community/vit-base-violence-detection-ONNX',
    file: 'onnx/model_quantized.onnx',
    bytes: 86_803_109,
    size: 224,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    labels: ['violence', 'non-violence'],
    positiveIndex: 0,
    defaultThreshold: 0.5,
    defaultMinDurationMs: 5000,
    note: 'ONNX conversion of jaranohaal/vit-base-violence-detection',
  },
};

const DETECTOR_KEYS = Object.keys(DETECTORS);
const round3 = (v) => Math.round(Number(v) * 1000) / 1000;

const sessionCache = new Map(); // key -> { path, session }

function getDetector(key) {
  const d = DETECTORS[key];
  if (!d) throw new Error(`unknown detector: ${key}`);
  return d;
}

/* ------------------------------------------------------------------ *
 *  Model file location / download
 * ------------------------------------------------------------------ */
function envVar(det) {
  return `CUCI2_${det.key.toUpperCase()}_MODEL_DIR`;
}

function modelDir(key, userData) {
  const det = getDetector(key);
  return process.env[envVar(det)] || path.join(userData || os.tmpdir(), 'models', det.key);
}

function modelPath(key, userData) {
  return path.join(modelDir(key, userData), path.basename(getDetector(key).file));
}

function vendoredPath(key) {
  return path.join(__dirname, '..', 'vendor', key, path.basename(getDetector(key).file));
}

function isUsable(file) {
  try {
    return fs.statSync(file).size > 1_000_000;
  } catch {
    return false;
  }
}

function modelUrl(det) {
  return `https://huggingface.co/${det.repo}/resolve/main/${det.file}`;
}

/** Where a detector's model lives, whether or not it is present yet. */
function modelStatus(key, userData) {
  const det = getDetector(key);
  const dest = modelPath(key, userData);
  const vendored = vendoredPath(key);
  const local = isUsable(dest) ? dest : isUsable(vendored) ? vendored : null;
  return {
    key,
    label: det.label,
    installed: !!local,
    path: local || dest,
    downloadPath: dest,
    vendored: isUsable(vendored),
    repo: det.repo,
    file: det.file,
    approxBytes: det.bytes,
    inputSize: det.size,
    labels: det.labels,
    positiveLabel: det.labels[det.positiveIndex],
    positiveIndex: det.positiveIndex,
    defaultThreshold: det.defaultThreshold,
    defaultMinDurationMs: det.defaultMinDurationMs,
    note: det.note,
    url: modelUrl(det),
  };
}

function statusAll(userData) {
  return DETECTOR_KEYS.map((k) => modelStatus(k, userData));
}

async function headSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const len = Number(res.headers.get('content-length') || 0);
    return Number.isFinite(len) ? len : 0;
  } catch {
    return 0;
  }
}

function downloadWithCurl(url, part, onProgress, total) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-L', '--fail', '--retry', '5', '--retry-delay', '2', '-C', '-', '-o', part, url], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const timer = setInterval(() => {
      try {
        onProgress && onProgress(fs.statSync(part).size, total);
      } catch {
        /* file not created yet */
      }
    }, 350);
    child.on('error', () => {
      clearInterval(timer);
      reject(new Error('curl-unavailable'));
    });
    child.on('close', (code) => {
      clearInterval(timer);
      code === 0 ? resolve() : reject(new Error(`curl exited with ${code}`));
    });
  });
}

async function downloadWithFetch(url, part, onProgress, total) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0) || total;
  const out = fs.createWriteStream(part);
  let written = 0;
  for await (const chunk of res.body) {
    written += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    onProgress && onProgress(written, len);
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
}

/** Ensure a detector's ONNX model is on disk; download it (resumable) if needed. */
async function ensureModel(key, userData, onProgress) {
  const dest = modelPath(key, userData);
  if (isUsable(dest)) return dest;
  if (isUsable(vendoredPath(key))) return vendoredPath(key);

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const det = getDetector(key);
  const url = modelUrl(det);
  const total = (await headSize(url)) || det.bytes;
  const part = dest + '.part';

  try {
    await downloadWithCurl(url, part, onProgress, total);
  } catch (err) {
    if (err.message === 'curl-unavailable') {
      await downloadWithFetch(url, part, onProgress, total);
    } else {
      fs.rmSync(part, { force: true }); // resume failed — retry once from scratch
      try {
        await downloadWithCurl(url, part, onProgress, total);
      } catch (err2) {
        if (err2.message === 'curl-unavailable') await downloadWithFetch(url, part, onProgress, total);
        else throw err2;
      }
    }
  }

  if (!isUsable(part)) throw new Error('model download did not complete');
  fs.renameSync(part, dest);
  return dest;
}

/* ------------------------------------------------------------------ *
 *  Inference
 * ------------------------------------------------------------------ */
async function getSession(key, modelFile) {
  const cached = sessionCache.get(key);
  if (cached && cached.path === modelFile) return cached.session;
  const ort = require('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelFile, {
    intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
  });
  sessionCache.set(key, { path: modelFile, session });
  return session;
}

function disposeSession(key) {
  if (key) sessionCache.delete(key);
  else sessionCache.clear();
}

/** raw RGB24 (size*size*3) -> normalised NCHW float32 tensor data. */
function frameToTensor(rgb, size = 384, mean = [0.5, 0.5, 0.5], std = [0.5, 0.5, 0.5]) {
  const area = size * size;
  const out = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    const p = i * 3;
    out[i] = (rgb[p] / 255 - mean[0]) / std[0];
    out[area + i] = (rgb[p + 1] / 255 - mean[1]) / std[1];
    out[2 * area + i] = (rgb[p + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((v) => v / sum);
}

/**
 * Classify one raw RGB24 frame with an already-loaded session.
 * @returns {{ score:number, probabilities:number[] }} score is P(flagged class)
 */
async function classifyFrame(session, rgb, size, positiveIndex = 1) {
  const ort = require('onnxruntime-node');
  const tensor = new ort.Tensor('float32', frameToTensor(rgb, size), [1, 3, size, size]);
  const output = await session.run({ [session.inputNames[0]]: tensor });
  const probabilities = softmax(Array.from(output[session.outputNames[0]].data, Number));
  return { score: probabilities[positiveIndex], probabilities };
}

/**
 * Group per-frame scores into ranges.
 * A sample at index i covers [i*interval, i*interval + interval).
 */
function groupDetections(samples, intervalMs, durationMs, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.5;
  const minDurationMs = opts.minDurationMs || 0;
  const padMs = opts.padMs || 0;

  const raw = [];
  let current = null;
  for (const s of samples) {
    if (s.score >= threshold) {
      const start = Math.max(0, s.timeMs - padMs);
      const end = Math.min(durationMs, s.timeMs + intervalMs + padMs);
      if (!current) {
        current = { start, end, maxScore: s.score, frames: 1 };
      } else {
        current.end = Math.max(current.end, end);
        current.maxScore = Math.max(current.maxScore, s.score);
        current.frames += 1;
      }
    } else if (current) {
      raw.push(current);
      current = null;
    }
  }
  if (current) raw.push(current);

  return raw
    .filter((seg) => seg.end - seg.start >= minDurationMs)
    .map((seg) => ({ start: round3(seg.start), end: round3(seg.end), maxScore: Math.round(seg.maxScore * 1000) / 1000, frames: seg.frames }));
}

/**
 * Sample the video with ffmpeg and classify each frame.
 *
 * @param {string} key  detector key ('nsfw' | 'violence')
 * @param {object} opts { ffmpegPath, videoPath, durationMs, intervalMs, threshold,
 *                        minDurationMs, padMs, userData, onProgress, isCancelled }
 */
async function scanVideo(key, opts) {
  const det = getDetector(key);
  const {
    ffmpegPath,
    videoPath,
    durationMs,
    intervalMs = 2000,
    threshold = det.defaultThreshold,
    minDurationMs = det.defaultMinDurationMs,
    padMs = 500,
    userData,
    onProgress,
    isCancelled,
  } = opts;

  const size = det.size;
  const frameSize = size * size * 3;
  const intervalSec = Math.max(0.05, intervalMs / 1000);
  const expected = Math.max(1, Math.round(durationMs / intervalMs));

  onProgress && onProgress({ detector: key, phase: 'model', message: `Preparing ${det.label} model…` });
  const modelFile = await ensureModel(key, userData, (loaded, total) => {
    onProgress &&
      onProgress({
        detector: key,
        phase: 'download',
        loaded,
        total,
        percent: total ? Math.min(99, (loaded / total) * 100) : 0,
        message: `Downloading ${det.label} model… ${(loaded / 1048576).toFixed(1)} MB`,
      });
  });

  onProgress && onProgress({ detector: key, phase: 'loading', message: 'Loading model…' });
  const session = await getSession(key, modelFile);

  const filter = [
    `fps=${(1 / intervalSec).toFixed(6)}`,
    `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
    `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2`,
    'format=rgb24',
  ].join(',');

  const child = spawn(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', videoPath, '-an', '-vf', filter, '-f', 'rawvideo', '-'],
    { windowsHide: true },
  );

  const samples = [];
  let buffer = Buffer.alloc(0);
  let index = 0;
  let stderr = '';

  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const cancelled = () => (isCancelled ? isCancelled() : false);

  try {
    for await (const chunk of child.stdout) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= frameSize) {
        const frame = buffer.subarray(0, frameSize);
        buffer = buffer.subarray(frameSize);
        const { score } = await classifyFrame(session, frame, size, det.positiveIndex);
        samples.push({ timeMs: index * intervalMs, score });
        index += 1;
        onProgress &&
          onProgress({
            detector: key,
            phase: 'scan',
            index,
            expected,
            percent: Math.min(99, (index / expected) * 100),
            score,
            flag: score >= threshold,
            message: `Scanning… ${index}/${expected}${score >= threshold ? ` · ${det.labels[det.positiveIndex]}` : ''}`,
          });
        if (cancelled()) break;
      }
      if (cancelled()) break;
    }
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  const segments = groupDetections(samples, intervalMs, durationMs, { threshold, minDurationMs, padMs });
  return {
    detector: key,
    label: det.label,
    model: { repo: det.repo, file: det.file, size },
    positiveLabel: det.labels[det.positiveIndex],
    intervalMs,
    threshold,
    scannedFrames: samples.length,
    expectedFrames: expected,
    positives: samples.filter((s) => s.score >= threshold).length,
    cancelled: cancelled(),
    segments,
    stderr: stderr.split('\n').filter(Boolean).slice(-3).join('\n'),
  };
}

module.exports = {
  DETECTORS,
  DETECTOR_KEYS,
  modelStatus,
  statusAll,
  ensureModel,
  disposeSession,
  frameToTensor,
  softmax,
  classifyFrame,
  groupDetections,
  scanVideo,
  modelPath,
  modelDir,
};
