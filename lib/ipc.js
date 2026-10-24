'use strict';

/**
 * All IPC handlers for CUCI, isolated from the Electron app bootstrap so the
 * smoke test can exercise the very same code paths.
 */

const { app, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseRate, buildFilterGraph, buildEncoderArgs } = require('./exporter');
const { formatFor, FORMATS } = require('./formats');
const { resolve: resolveTools, invalidate: invalidateTools, ffmpegPath, ffprobePath, bundledLocation } = require('./ffmpeg-locate');
const nsfw = require('./nsfw');
const panels = require('./panels');

const settings = {
  ffmpegPath: '',
  ffprobePath: '',
  loadThumbs: false,
  preferBundled: false,
  nsfwThreshold: 0.3,
  nsfwIntervalMs: 2000,
  nsfwMinDurationMs: 5000,
  theme: 'system',
  language: 'auto',
  panels: {},
};
let nsfwCancelled = false;
let settingsFile = '';
let currentJob = null;
let getWindow = () => null;
let registered = false;

// Every ffmpeg/ffprobe child we spawn, so they can all be cleaned up on quit.
const activeChildren = new Set();
function trackChild(child) {
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
}

/* ------------------------------------------------------------------ *
 *  Settings
 * ------------------------------------------------------------------ */
function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
  } catch {
    /* first run */
  }
  // Migrate values that still equal a previous default to the new default,
  // so existing installs pick up changed defaults unless they were customised.
  let migrated = false;
  if (settings.nsfwThreshold === 0.75) {
    settings.nsfwThreshold = 0.3;
    migrated = true;
  }
  if (settings.nsfwMinDurationMs === 2000) {
    settings.nsfwMinDurationMs = 5000;
    migrated = true;
  }
  if (migrated) persistSettings();
}

function persistSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 *  Binary resolution + process helper
 *
 *  Priority: custom path (settings) -> env -> system PATH -> bundled.
 *  See lib/ffmpeg-locate.js.
 * ------------------------------------------------------------------ */
function ffmpegBin() {
  return ffmpegPath(settings);
}

function ffprobeBin() {
  return ffprobePath(settings);
}

/** Summary of the resolved tools, for the renderer's Settings panel. */
function toolInfo() {
  const t = resolveTools(settings);
  const pack = (r, kind) => {
    const info = { ok: r.ok, path: r.path, source: r.source, version: r.version, libass: !!r.libass, binary: kind };
    if (!r.ok) info.error = r.warnings[r.warnings.length - 1] || `${kind} not found`;
    return info;
  };
  return {
    ffmpeg: pack(t.ffmpeg, 'ffmpeg'),
    ffprobe: pack(t.ffprobe, 'ffprobe'),
    bundled: {
      ffmpeg: bundledLocation('ffmpeg'),
      ffprobe: bundledLocation('ffprobe'),
      present: fs.existsSync(bundledLocation('ffmpeg')) && fs.existsSync(bundledLocation('ffprobe')),
    },
  };
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, ...opts });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let err = '';
    if (child.stdout)
      child.stdout.on('data', (d) => {
        out += d;
        if (opts.onStdout) opts.onStdout(String(d));
      });
    if (child.stderr)
      child.stderr.on('data', (d) => {
        err += d;
        if (opts.onStderr) opts.onStderr(String(d));
      });
    trackChild(child);
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else {
        const tail = err.split('\n').filter(Boolean).slice(-8).join('\n');
        reject(new Error(`${path.basename(bin)} exited with code ${code}\n${tail}`));
      }
    });
  });
}

const VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'mov', 'webm', 'avi', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'ogv', 'vob'];
const SUB_EXT = ['srt', 'vtt', 'ass', 'ssa', 'sub'];

/* ------------------------------------------------------------------ *
 *  Export pipeline
 * ------------------------------------------------------------------ */

function runTool(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, ...opts });
    } catch {
      return resolve();
    }
    proc.on('error', () => resolve());
    proc.on('close', () => resolve());
    setTimeout(resolve, 10000);
  });
}

/*
 * Kill a process and everything it spawned.
 *
 * On Windows `ffmpeg` is frequently a package-manager shim (Chocolatey,
 * Scoop, winget) which launches the real ffmpeg.exe as a child. `child.kill()`
 * only terminates the shim and orphans the encoder, so we use the native
 * `taskkill /T /F`, which terminates the target plus its whole tree.
 *
 * Only the standard `tasklist` / `taskkill` utilities are used. No scripted
 * process enumeration or script interpreters are involved, so nothing here
 * looks like suspicious execution to endpoint protection.
 */
async function killTree(child) {
  if (!child) return;
  const pid = child.pid;
  const gone = () => child.exitCode !== null || child.signalCode;
  const waitClose = new Promise((resolve) => {
    if (gone()) return resolve();
    child.once('close', resolve);
    setTimeout(resolve, 8000);
  });

  if (process.platform === 'win32' && pid) {
    await runTool('taskkill', ['/pid', String(pid), '/T', '/F']);
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  await waitClose;
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

/** PIDs of currently running ffmpeg.exe processes (benign tasklist query). */
function listFfmpegPids() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(new Set());
    const proc = spawn('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
    let out = '';
    if (proc.stdout) proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(new Set()));
    proc.on('close', () => {
      const pids = new Set();
      for (const line of out.split('\n')) {
        const m = /^"ffmpeg\.exe","(\d+)"/i.exec(line.trim());
        if (m) pids.add(Number(m[1]));
      }
      resolve(pids);
    });
  });
}

/**
 * Safety net: terminate any ffmpeg.exe that appeared after `preexisting` was
 * captured (i.e. one of ours) but survived the tree kill — covers shims that
 * re-parent their child. Pre-existing ffmpeg processes belong to other apps
 * and are never touched.
 */
async function killNewFfmpeg(preexisting) {
  if (process.platform !== 'win32') return;
  const now = await listFfmpegPids();
  const targets = [...now].filter((pid) => !(preexisting && preexisting.has(pid)));
  await Promise.all(targets.map((pid) => runTool('taskkill', ['/pid', String(pid), '/F'])));
}

async function doExport(event, req, job) {
  if (!req || !Array.isArray(req.segments) || req.segments.length === 0) {
    throw new Error('Nothing to export — no kept segments.');
  }
  if (!req.outputPath) throw new Error('No output path chosen.');

  let srtPath = null;
  if (req.burnSubtitles && req.subtitleSrt) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cuci2-sub-'));
    srtPath = path.join(dir, 'synced.srt');
    await fsp.writeFile(srtPath, req.subtitleSrt, 'utf8');
    job.srtDir = dir;
  }

  const uniquePaths = [];
  const pathIndex = new Map();
  for (const seg of req.segments) {
    if (!pathIndex.has(seg.path)) {
      pathIndex.set(seg.path, uniquePaths.length);
      uniquePaths.push(seg.path);
    }
  }

  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];
  for (const p of uniquePaths) args.push('-i', p);
  if (req.segments.some((s) => !s.hasAudio)) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  const { graph, vlabel, alabel } = buildFilterGraph({ ...req, subtitleSrtPath: srtPath }, uniquePaths, pathIndex);
  args.push('-filter_complex', graph);
  args.push('-map', vlabel, '-map', alabel);
  // Container/format: refuse anything outside the offer, then mux explicitly.
  if (req.container != null && !Object.prototype.hasOwnProperty.call(FORMATS, req.container)) {
    throw new Error(`Unsupported output format: ${req.container}`);
  }
  const fmt = formatFor(req.container);
  args.push(...buildEncoderArgs(req));
  if (fmt.faststart) args.push('-movflags', '+faststart');
  args.push('-f', fmt.muxer);
  args.push('-progress', 'pipe:1', '-nostats', req.outputPath);

  const totalSec = Math.max(0.001, req.segments.reduce((a, s) => a + (s.end - s.start), 0) / 1000);

  // Remember which ffmpeg processes already existed, so the cancel fallback
  // only ever reaps the ones this export spawned.
  job.preexisting = await listFfmpegPids();

  try {
    await new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { windowsHide: true });
    trackChild(child);
    job.child = child;

    let errTail = [];
    let lastEmit = 0;

    const handleProgress = (text) => {
      const fields = {};
      for (const line of text.split(/\r?\n/)) {
        const m = /^([a-z_]+)=(.*)$/.exec(line);
        if (m) fields[m[1]] = m[2];
      }
      let sec = null;
      if (fields.out_time_us != null) sec = Number(fields.out_time_us) / 1e6;
      else if (fields.out_time_ms != null) sec = Number(fields.out_time_ms) / 1e6;
      if (sec != null && Number.isFinite(sec)) {
        const now = Date.now();
        if (now - lastEmit > 80 || fields.progress === 'end') {
          lastEmit = now;
          if (!event.sender.isDestroyed()) {
            event.sender.send('export:progress', {
              percent: Math.max(0, Math.min(100, (sec / totalSec) * 100)),
              timeSec: sec,
              totalSec,
              speed: fields.speed || '',
              fps: fields.fps || '',
            });
          }
        }
      }
    };

    if (child.stdout) child.stdout.on('data', (d) => handleProgress(d.toString()));
    if (child.stderr)
      child.stderr.on('data', (d) => {
        for (const l of String(d).split('\n')) if (l.trim()) errTail.push(l.trim());
        if (errTail.length > 40) errTail = errTail.slice(-40);
      });

    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      if (child.__cancelled || job.cancelled) return reject(new Error('CANCELLED'));
      reject(new Error(`ffmpeg failed (code ${code})\n${errTail.slice(-8).join('\n')}`));
    });
    });
  } catch (err) {
    // Remove the half-written output file so a cancel/failure leaves no residue.
    await fsp.rm(req.outputPath, { force: true }).catch(() => {});
    throw err;
  }

  return { outputPath: req.outputPath, srtDir: job.srtDir };
}

/* ------------------------------------------------------------------ *
 *  Registration
 * ------------------------------------------------------------------ */
function registerIpc(opts = {}) {
  if (registered) return;
  registered = true;
  if (opts.getWindow) getWindow = opts.getWindow;
  loadSettings();

  // Detachable side panel / control center windows (see lib/panels.js).
  panels.init({
    getMainWindow: () => getWindow(),
    getBounds: (name) => (settings.panels && settings.panels[name]) || null,
    saveBounds: (name, bounds) => {
      settings.panels = settings.panels || {};
      settings.panels[name] = bounds;
      persistSettings();
    },
  });

  ipcMain.handle('app:info', async () => {
    const tools = toolInfo();
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      bundled: tools.bundled,
      settings: { ...settings },
    };
  });

  ipcMain.handle('settings:set', async (_e, patch) => {
    if (patch && typeof patch === 'object') {
      if ('ffmpegPath' in patch) settings.ffmpegPath = String(patch.ffmpegPath || '');
      if ('ffprobePath' in patch) settings.ffprobePath = String(patch.ffprobePath || '');
      if ('loadThumbs' in patch) settings.loadThumbs = !!patch.loadThumbs;
      if ('preferBundled' in patch) settings.preferBundled = !!patch.preferBundled;
      if ('nsfwThreshold' in patch) settings.nsfwThreshold = Math.min(0.99, Math.max(0.3, Number(patch.nsfwThreshold) || 0.3));
      if ('nsfwIntervalMs' in patch) settings.nsfwIntervalMs = Math.min(60000, Math.max(250, Number(patch.nsfwIntervalMs) || 2000));
      if ('nsfwMinDurationMs' in patch) settings.nsfwMinDurationMs = Math.max(0, Number(patch.nsfwMinDurationMs) || 0);
      if ('theme' in patch) settings.theme = ['system', 'dark', 'light'].includes(patch.theme) ? patch.theme : 'system';
      if ('language' in patch) settings.language = typeof patch.language === 'string' && patch.language ? patch.language.slice(0, 12) : 'auto';
      persistSettings();
      invalidateTools();
    }
    return { ...settings };
  });

  ipcMain.handle('dialog:openVideos', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Add video files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('dialog:openSubtitles', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Add subtitle files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Subtitles', extensions: SUB_EXT }, { name: 'All files', extensions: ['*'] }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('dialog:saveFile', async (_e, opts = {}) => {
    const res = await dialog.showSaveDialog(getWindow(), {
      title: opts.title || 'Save file',
      defaultPath: opts.defaultPath || undefined,
      filters: opts.filters || [{ name: 'All files', extensions: ['*'] }],
    });
    return res.canceled ? null : res.filePath;
  });

  ipcMain.handle('dialog:openFile', async (_e, opts = {}) => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: opts.title || 'Open file',
      properties: ['openFile'],
      filters: opts.filters || [{ name: 'All files', extensions: ['*'] }],
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  ipcMain.handle('clipboard:write', async (_e, text) => {
    clipboard.writeText(String(text));
    return true;
  });

  ipcMain.handle('clipboard:read', async () => clipboard.readText());

  ipcMain.handle('shell:showItem', async (_e, p) => {
    try {
      shell.showItemInFolder(p);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:readText', async (_e, p, opts = {}) => {
    const maxBytes = Number(opts && opts.maxBytes) || 0;
    if (maxBytes > 0) {
      const st = await fsp.stat(p);
      if (st.size > maxBytes) {
        throw new Error(
          `File is too large (${(st.size / 1048576).toFixed(1)} MB, limit ${(maxBytes / 1048576).toFixed(1)} MB).`,
        );
      }
    }
    return fsp.readFile(p, 'utf8');
  });

  ipcMain.handle('fs:writeText', async (_e, p, content) => {
    await fsp.writeFile(p, content, 'utf8');
    return true;
  });

  ipcMain.handle('media:probe', async (_e, filePath) => {
    const { out } = await run(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
    const data = JSON.parse(out);
    const v = (data.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const a = (data.streams || []).find((s) => s.codec_type === 'audio');
    const fps = parseRate(v?.avg_frame_rate) || parseRate(v?.r_frame_rate) || 25;
    let durationMs = Math.round(parseFloat(data.format?.duration || '0') * 1000);
    if (!durationMs && v?.duration) durationMs = Math.round(parseFloat(v.duration) * 1000);
    if (!durationMs) {
      try {
        const r = await run(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath]);
        durationMs = Math.round(parseFloat(r.out.trim()) * 1000) || 0;
      } catch {
        /* ignore */
      }
    }
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      /* ignore */
    }
    return {
      path: filePath,
      name: path.basename(filePath),
      size,
      durationMs,
      fps,
      width: v?.width || 0,
      height: v?.height || 0,
      hasVideo: !!v,
      hasAudio: !!a,
      videoCodec: v?.codec_name || '',
      audioCodec: a?.codec_name || '',
      rotation: Number(v?.tags?.rotate || 0) || 0,
    };
  });

  ipcMain.handle('media:thumbs', async (event, filePath, opts = {}) => {
    const durationMs = Math.max(1, Number(opts.durationMs) || 1000);
    const height = Math.max(32, Math.min(160, Number(opts.height) || 64));
    const maxCount = Math.max(8, Math.min(200, Number(opts.maxCount) || 160));
    const stepSec = Math.max(0.25, durationMs / 1000 / maxCount);
    const count = Math.max(1, Math.min(maxCount, Math.ceil(durationMs / 1000 / stepSec)));

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cuci2-thumb-'));
    let lastFrame = 0;
    try {
      await run(
        ffmpegBin(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          filePath,
          '-vf',
          `fps=${(1 / stepSec).toFixed(6)},scale=-2:${height}`,
          '-frames:v',
          String(count),
          '-q:v',
          '6',
          '-progress',
          'pipe:1',
          '-nostats',
          path.join(dir, 't%04d.jpg'),
        ],
        {
          onStdout: (text) => {
            const m = /frame=(\d+)/.exec(text);
            if (!m) return;
            const frame = Number(m[1]);
            if (frame === lastFrame) return;
            lastFrame = frame;
            if (!event.sender.isDestroyed()) {
              event.sender.send('thumbs:progress', { path: filePath, percent: Math.min(99, (frame / count) * 100), frame, count });
            }
          },
        },
      );
    } catch {
      /* thumbnails are best-effort */
    }
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    } catch {
      /* ignore */
    }
    return { dir, files, stepMs: stepSec * 1000 };
  });

  ipcMain.handle('media:proxy', async (event, filePath) => {
    // reported by the renderer via status; no progress parsing needed here
    const dir = path.join(os.tmpdir(), 'cuci2-proxy');
    await fsp.mkdir(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
    const out = path.join(dir, hash + '.mp4');
    if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
    await run(
      ffmpegBin(),
      [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', filePath,
        '-vf', 'scale=trunc(iw/4)*2:480:force_original_aspect_ratio=decrease',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', out,
      ],
      {
        onStderr: (d) => {
          if (!event.sender.isDestroyed()) event.sender.send('proxy:log', d);
        },
      },
    );
    return out;
  });

  /* ---------------- NSFW scene detection ---------------- */
  ipcMain.handle('nsfw:status', async () => nsfw.modelStatus(app.getPath('userData')));

  ipcMain.handle('nsfw:scan', async (event, req = {}) => {
    nsfwCancelled = false;
    try {
      const result = await nsfw.scanVideo({
        ffmpegPath: ffmpegBin(),
        videoPath: req.videoPath,
        durationMs: Math.max(0, Number(req.durationMs) || 0),
        intervalMs: Number(req.intervalMs) || settings.nsfwIntervalMs,
        threshold: req.threshold != null ? Number(req.threshold) : settings.nsfwThreshold,
        minDurationMs: req.minDurationMs != null ? Number(req.minDurationMs) : settings.nsfwMinDurationMs,
        padMs: req.padMs != null ? Number(req.padMs) : 500,
        userData: app.getPath('userData'),
        onProgress: (p) => {
          if (!event.sender.isDestroyed()) event.sender.send('nsfw:progress', p);
        },
        isCancelled: () => nsfwCancelled,
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('nsfw:cancel', async () => {
    nsfwCancelled = true;
    return true;
  });

  ipcMain.handle('export:start', async (event, req) => {
    if (currentJob) return { ok: false, error: 'An export is already running.' };
    const job = { cancelled: false, child: null, srtDir: null };
    currentJob = job;
    try {
      const result = await doExport(event, req, job);
      return { ok: true, outputPath: result.outputPath, srtPath: result.srtDir ? path.join(result.srtDir, 'synced.srt') : null };
    } catch (err) {
      const msg = String(err.message || err);
      if (msg === 'CANCELLED') return { ok: false, cancelled: true };
      return { ok: false, error: msg };
    } finally {
      if (job.srtDir) await fsp.rm(job.srtDir, { recursive: true, force: true }).catch(() => {});
      if (currentJob === job) currentJob = null;
    }
  });

  ipcMain.handle('export:cancel', async () => {
    const job = currentJob;
    if (!job || !job.child) return false;
    if (job.cancelled) return true;
    job.cancelled = true;
    job.child.__cancelled = true;
    await killTree(job.child);
    // Also stop any concurrent helper jobs (thumbnails / proxy) so that no
    // ffmpeg keeps running after the user hits Cancel.
    await Promise.all([...activeChildren].map((c) => killTree(c)));
    // Last resort: reap any of our ffmpeg processes that survived a tree kill.
    await killNewFfmpeg(job.preexisting);
    return true;
  });
}

function killCurrentJob() {
  const job = currentJob;
  if (job && job.child) {
    job.cancelled = true;
    job.child.__cancelled = true;
    killTree(job.child);
  }
  // Clean up any probe / thumbnail / proxy helper still running.
  for (const c of [...activeChildren]) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true });
  }
  activeChildren.clear();
}

module.exports = { registerIpc, killCurrentJob, ffmpegBin, ffprobeBin, settings, activeChildren, panels };
