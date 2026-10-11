'use strict';

/**
 * Verifies that cancelling an export:
 *   1. actually terminates the ffmpeg process (tree),
 *   2. deletes the half-written output file,
 *   3. removes the temporary subtitle directory,
 *   4. resolves the export promise with { cancelled: true }.
 *
 *   npx electron lib/test-cancel.js
 */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { registerIpc } = require('./ipc');
const { MEDIA_PRIVILEGES, registerMediaProtocol } = require('./media-protocol');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged(MEDIA_PRIVILEGES);

function sh(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
}

function ffmpegCount() {
  if (process.platform !== 'win32') {
    const r = sh('pgrep', ['-c', 'ffmpeg']);
    return Number((r.stdout || '0').trim()) || 0;
  }
  const r = sh('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/FO', 'CSV', '/NH']);
  return (r.stdout || '')
    .split('\n')
    .filter((l) => /"ffmpeg\.exe"/i.test(l)).length;
}

function subTmpDirs() {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cuci2-sub-'));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuci2-cancel-'));
const video = path.join(tmp, 'src.mp4');
const out = path.join(tmp, 'out.mp4');

sh(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
fs.rmSync(out, { force: true });

// Baseline so we never touch other apps' ffmpeg processes.
const baseline = ffmpegCount();

let win = null;
app.whenReady().then(async () => {
  registerIpc({ getWindow: () => win });
  registerMediaProtocol();

  win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await sleep(800);

  // A deliberately slow export: upscale a tiny 3s clip to 4K with veryslow.
  const req = {
    outputPath: out,
    container: 'mp4',
    segments: [{ path: video, start: 0, end: 3000, hasAudio: true }],
    width: 3840,
    height: 2160,
    fps: 30,
    videoCodec: 'libx264',
    crf: 16,
    preset: 'veryslow',
    audioBitrate: '192k',
    burnSubtitles: true,
    subtitleSrt: '1\n00:00:00,000 --> 00:00:01,500\ncancel me\n',
  };

  await win.webContents.executeJavaScript(
    `window.__cancelResult = 'pending'; window.api.exportVideo(${JSON.stringify(req)}).then(r => { window.__cancelResult = r; }).catch(e => { window.__cancelResult = { threw: String(e) }; }); true`,
  );

  // Wait until ffmpeg is actually running and has created the output.
  let sawRunning = false;
  let sawPartial = false;
  for (let i = 0; i < 40; i++) {
    if (ffmpegCount() > 0) sawRunning = true;
    if (fs.existsSync(out)) sawPartial = true;
    if (sawRunning && sawPartial) break;
    await sleep(150);
  }
  const subBefore = subTmpDirs().length;
  const duringCount = ffmpegCount();
  console.log(`running ffmpeg : ${sawRunning} (baseline=${baseline}, during=${duringCount}, ours=${duringCount - baseline})`);
  console.log(`partial output : ${sawPartial} (${fs.existsSync(out) ? fs.statSync(out).size + ' bytes' : 'missing'})`);
  console.log(`temp sub dirs  : ${subBefore}`);

  // Cancel and wait for the renderer promise to settle.
  await win.webContents.executeJavaScript('window.api.cancelExport()');

  let result = 'pending';
  for (let i = 0; i < 60; i++) {
    result = await win.webContents.executeJavaScript('window.__cancelResult');
    if (result !== 'pending') break;
    await sleep(150);
  }
  console.log('export result  :', JSON.stringify(result));

  // Check immediately, then again after a delay, to catch late/orphaned processes.
  await sleep(600);
  const remainingNow = ffmpegCount();
  await sleep(2500);
  const remainingLater = ffmpegCount();
  const outExists = fs.existsSync(out);
  const subAfter = subTmpDirs().length;
  console.log(`ffmpeg after   : ${remainingNow} (immediately) -> ${remainingLater} (after 3s)`);
  console.log(`output exists  : ${outExists}`);
  console.log(`temp sub dirs  : ${subAfter} (was ${subBefore})`);

  const ok =
    sawRunning &&
    sawPartial &&
    duringCount > baseline &&
    result &&
    result.cancelled === true &&
    remainingNow <= baseline &&
    remainingLater <= baseline &&
    !outExists &&
    subAfter <= subBefore;

  console.log('\nCANCEL TEST:', ok ? 'PASS ✅' : 'FAIL ❌');
  app.exit(ok ? 0 : 1);
});
