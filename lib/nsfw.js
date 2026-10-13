'use strict';

/**
 * NSFW scene detection.
 *
 * Uses an ONNX image classifier (AdamCodd/vit-base-nsfw-detector — a ViT-base
 * binary sfw/nsfw model, the closest ONNX equivalent to
 * Falconsai/nsfw_image_detection, which only ships PyTorch weights) executed
 * with onnxruntime-node.
 *
 * Frames are sampled straight out of ffmpeg as raw RGB24 at the model's input
 * size, so there is no image-decoding dependency (no sharp, no canvas).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const MODEL = {
  repo: 'AdamCodd/vit-base-nsfw-detector',
  file: 'onnx/model_quantized.onnx',
  bytes: 88_500_985, // approx; refined by a HEAD request at download time
  size: 384,
  mean: [0.5, 0.5, 0.5],
  std: [0.5, 0.5, 0.5],
  labels: ['sfw', 'nsfw'],
  nsfwIndex: 1,
};

const round3 = (v) => Math.round(Number(v) * 1000) / 1000;

let sessionCache = null; // { path, session }

/* ------------------------------------------------------------------ *
 *  Model file location / download
 * ------------------------------------------------------------------ */
function modelDir(userData) {
  return process.env.CUCI2_NSFW_MODEL_DIR || path.join(userData || os.tmpdir(), 'models', 'nsfw');
}

function modelPath(userData) {
  return path.join(modelDir(userData), path.basename(MODEL.file));
}

function vendoredPath() {
  return path.join(__dirname, '..', 'vendor', 'nsfw', path.basename(MODEL.file));
}

function isUsable(file) {
  try {
    return fs.statSync(file).size > 1_000_000;
  } catch {
    return false;
  }
}

function modelUrl(repo = MODEL.repo, file = MODEL.file) {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

/** Where the model would live, whether or not it is present yet. */
function modelStatus(userData) {
  const dest = modelPath(userData);
  const vendored = vendoredPath();
  const installed = isUsable(dest);
  const local = installed ? dest : isUsable(vendored) ? vendored : null;
  return {
    installed: !!local,
    path: local || dest,
    downloadPath: dest,
    vendored: isUsable(vendored),
    repo: MODEL.repo,
    file: MODEL.file,
    approxBytes: MODEL.bytes,
    inputSize: MODEL.size,
    labels: MODEL.labels,
    url: modelUrl(),
  };
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

/** Ensure the ONNX model is on disk; download it (resumable) when needed. */
async function ensureModel(userData, onProgress) {
  const dest = modelPath(userData);
  if (isUsable(dest)) return dest;
  if (isUsable(vendoredPath())) return vendoredPath();

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const url = modelUrl();
  const total = (await headSize(url)) || MODEL.bytes;
  const part = dest + '.part';

  try {
    await downloadWithCurl(url, part, onProgress, total);
  } catch (err) {
    if (err.message === 'curl-unavailable') {
      await downloadWithFetch(url, part, onProgress, total);
    } else {
      // resume failed / server quirk — retry once from scratch
      fs.rmSync(part, { force: true });
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
async function getSession(modelFile) {
  if (sessionCache && sessionCache.path === modelFile) return sessionCache.session;
  const ort = require('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelFile, {
    intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
  });
  sessionCache = { path: modelFile, session };
  return session;
}

function disposeSession() {
  sessionCache = null;
}

/** raw RGB24 (size*size*3) -> normalised NCHW float32 tensor data. */
function frameToTensor(rgb, size = MODEL.size, mean = MODEL.mean, std = MODEL.std) {
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

/** Classify one raw RGB24 frame with an already-loaded session. */
async function classifyFrame(session, rgb) {
  const ort = require('onnxruntime-node');
  const data = frameToTensor(rgb);
  const tensor = new ort.Tensor('float32', data, [1, 3, MODEL.size, MODEL.size]);
  const output = await session.run({ [session.inputNames[0]]: tensor });
  const logits = output[session.outputNames[0]].data;
  const probs = softmax(Array.from(logits, Number));
  return { score: probs[MODEL.nsfwIndex], sfw: probs[0], nsfw: probs[MODEL.nsfwIndex] };
}

/**
 * Group per-frame scores into cut ranges.
 * A sample at index i covers [i*interval, i*interval + interval).
 */
function groupDetections(samples, intervalMs, durationMs, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.3;
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
 * @param {object} opts
 * @param {string} opts.ffmpegPath
 * @param {string} opts.videoPath
 * @param {number} opts.durationMs
 * @param {number} opts.intervalMs    sample spacing
 * @param {number} opts.threshold     0..1 nsfw probability
 * @param {number} [opts.minDurationMs]
 * @param {number} [opts.padMs]
 * @param {string} [opts.userData]
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.isCancelled]
 */
async function scanVideo(opts) {
  const {
    ffmpegPath,
    videoPath,
    durationMs,
    intervalMs = 2000,
    threshold = 0.3,
    minDurationMs = 0,
    padMs = 500,
    userData,
    onProgress,
    isCancelled,
  } = opts;

  const size = MODEL.size;
  const frameSize = size * size * 3;
  const intervalSec = Math.max(0.05, intervalMs / 1000);
  const expected = Math.max(1, Math.round(durationMs / intervalMs));

  onProgress && onProgress({ phase: 'model', message: 'Preparing NSFW model…' });
  const modelFile = await ensureModel(userData, (loaded, total) => {
    onProgress &&
      onProgress({
        phase: 'download',
        loaded,
        total,
        percent: total ? Math.min(99, (loaded / total) * 100) : 0,
        message: `Downloading NSFW model… ${(loaded / 1048576).toFixed(1)} MB`,
      });
  });

  onProgress && onProgress({ phase: 'loading', message: 'Loading model…' });
  const session = await getSession(modelFile);

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
        const { score } = await classifyFrame(session, frame);
        samples.push({ timeMs: index * intervalMs, score });
        index += 1;
        onProgress &&
          onProgress({
            phase: 'scan',
            index,
            expected,
            percent: Math.min(99, (index / expected) * 100),
            score,
            flag: score >= threshold,
            message: `Scanning… ${index}/${expected}${score >= threshold ? ' · flagged' : ''}`,
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
    model: { repo: MODEL.repo, file: MODEL.file, size },
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
  MODEL,
  modelStatus,
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
