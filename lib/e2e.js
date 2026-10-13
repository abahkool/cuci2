'use strict';

/**
 * Full end-to-end test through the real renderer + real IPC handlers:
 * generate media → load it → add subtitles → make a cut → verify subtitle
 * remapping → export (with burned subtitles) → verify the output.
 *
 *   npx electron lib/e2e.js
 */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { registerIpc } = require('./ipc');
const { MEDIA_PRIVILEGES, registerMediaProtocol } = require('./media-protocol');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function sh(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} failed:\n${r.stderr}`);
  return r.stdout;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged(MEDIA_PRIVILEGES);

// Isolated userData so the test never touches the real settings.json.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cuci2-e2e-userdata-')));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuci2-e2e-'));
const video = path.join(tmp, 'source.mp4');
const srt = path.join(tmp, 'subs.srt');
const out = path.join(tmp, 'result.mp4');

sh(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
fs.writeFileSync(
  srt,
  ['1', '00:00:00,000 --> 00:00:00,800', 'Kept A', '', '2', '00:00:01,200 --> 00:00:01,800', 'Inside the cut', '', '3', '00:00:02,500 --> 00:00:03,500', 'Kept B', ''].join('\n'),
);
console.log('temp dir :', tmp);

let win = null;
const messages = [];

app.whenReady().then(async () => {
  registerIpc({ getWindow: () => win });
  registerMediaProtocol();

  win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    if (d && typeof d === 'object' && 'message' in d) messages.push(`[${d.level}] ${d.message}`);
    else messages.push(`[${args[1]}] ${args[2]}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => messages.push('render-process-gone ' + JSON.stringify(d)));

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await sleep(1500);

  // 0. keyframe snapshots must be disabled by default -------------------
  const thumbSettingInfo = await win.webContents.executeJavaScript(
    `(() => ({ checked: document.getElementById('setLoadThumbs').checked, state: !!window.__cuciApp.state.settings.loadThumbs }))()`,
  );
  console.log('thumb setting:', JSON.stringify(thumbSettingInfo));

  // 1. load the video (snapshots enabled for the filmstrip tests) --------
  const loadInfo = await win.webContents.executeJavaScript(
    `(async () => { await window.__cuciApp.addVideos([${JSON.stringify(video)}]); const c = window.__cuciApp.state.clips[0]; return { name: c.name, durationMs: c.durationMs, fps: Math.round(c.fps*100)/100, size: c.width + 'x' + c.height, hasAudio: c.hasAudio }; })()`,
  );
  console.log('loaded clip:', JSON.stringify(loadInfo));

  // snapshots OFF by default -> no filmstrip images, just the placeholder hint
  await sleep(500);
  const thumbsOff = await win.webContents.executeJavaScript(
    `(() => { const h = document.querySelector('#tlFilm .tl-film-hint'); return { imgs: document.querySelectorAll('#tlFilm img').length, hint: !!h, text: h ? h.textContent : '' }; })()`,
  );
  console.log('thumbs off :', JSON.stringify(thumbsOff));

  // enable the setting -> snapshots load
  await win.webContents.executeJavaScript(`(() => { window.__cuciApp.state.settings.loadThumbs = true; window.__cuciApp.applyThumbSetting(); return true; })()`);

  // wait for thumbnails
  for (let i = 0; i < 40; i++) {
    const ready = await win.webContents.executeJavaScript(`!!(window.__cuciApp.state.clips[0] && window.__cuciApp.state.clips[0].thumbs && window.__cuciApp.state.clips[0].thumbs.files.length)`);
    if (ready) break;
    await sleep(250);
  }
  const thumbInfo = await win.webContents.executeJavaScript(
    `(() => { const t = window.__cuciApp.state.clips[0].thumbs; return { files: t.files.length, stepMs: Math.round(t.stepMs), filmstripImgs: document.querySelectorAll('#tlFilm img').length }; })()`,
  );
  console.log('thumbnails:', JSON.stringify(thumbInfo));

  const videoState = await win.webContents.executeJavaScript(
    `(() => { const v = document.getElementById('video'); return { readyState: v.readyState, duration: Math.round(v.duration*1000), src: (v.currentSrc||'').slice(0,24), notice: !document.getElementById('playerNotice').classList.contains('hidden') }; })()`,
  );
  console.log('video elem:', JSON.stringify(videoState));

  // status bar shows the active clip and lifecycle messages ---------------
  const statusInfo = await win.webContents.executeJavaScript(
    `(() => {
      const bar = document.getElementById('statusbar');
      return {
        exists: !!bar,
        level: bar ? bar.className : '',
        text: document.getElementById('statusText').textContent,
        info: document.getElementById('statusInfo').textContent,
        historyOpens: (() => { bar.click(); const open = !document.getElementById('statusLog').classList.contains('hidden'); document.getElementById('statusbar').click(); return open; })(),
        logRows: document.querySelectorAll('#statusLog .status-log-row').length,
      };
    })()`,
  );
  console.log('status bar :', JSON.stringify(statusInfo));

  // double-click on the filmstrip / ruler sets In then Out, then restarts --
  const dblInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      a.state.inPoint = null; a.state.outPoint = null; a.renderAll();
      const tl = document.getElementById('timeline'); const r = tl.getBoundingClientRect();
      const film = document.getElementById('tlFilm'); const ruler = document.getElementById('tlRuler');
      const X = (ms) => r.left + (ms / a.state.clips[0].durationMs) * r.width;
      const dbl = (el, ms) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: X(ms), clientY: r.top + 80 }));
      dbl(film, 1000); await new Promise(x => setTimeout(x, 60));
      const after1 = { in: a.state.inPoint, out: a.state.outPoint };
      dbl(film, 4000); await new Promise(x => setTimeout(x, 60));
      const after2 = { in: a.state.inPoint, out: a.state.outPoint };
      dbl(ruler, 5000); await new Promise(x => setTimeout(x, 60));
      const after3 = { in: a.state.inPoint, out: a.state.outPoint };
      a.state.inPoint = null; a.state.outPoint = null; a.renderAll();
      return { after1, after2, after3 };
    })()`,
  );
  console.log('dbl-click  :', JSON.stringify(dblInfo));

  // 1b. export guard: no cuts yet -> warns and requires confirmation -----
  const guardInfo = await win.webContents.executeJavaScript(
    `(async () => {
      document.getElementById('btnExport').click();
      await new Promise(r => setTimeout(r, 200));
      const summary = document.getElementById('expSummary').innerText;
      const warned = summary.includes('No cuts applied');
      document.getElementById('expStart').click();
      await new Promise(r => setTimeout(r, 200));
      const armed = document.getElementById('expStart').textContent.includes('Click again');
      const exporting = window.__cuciApp.state.exporting;
      document.getElementById('expClose').click();
      return { warned, armed, exporting };
    })()`,
  );
  console.log('export guard:', JSON.stringify(guardInfo));

  // 2. subtitles + cut --------------------------------------------------
  const editInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const app = window.__cuciApp;
      const clip = app.state.clips[0];
      await app.loadSubtitleFromPath(clip, ${JSON.stringify(srt)});
      app.addCut(1000, 2000);
      const ranges = app.keptRanges(clip);
      const remapped = app.remapAll();
      return {
        cuts: clip.cuts.length,
        ranges: ranges.map(r => [r.start, r.end]),
        total: app.programRanges().total,
        subtitleEvents: clip.subtitle.events.length,
        remapped: remapped.map(e => [Math.round(e.start), Math.round(e.end), e.text]),
        subBlocks: document.querySelectorAll('#tlSubs .tl-sub').length,
        cutBlocks: document.querySelectorAll('#tlCuts .tl-cut').length,
      };
    })()`,
  );
  console.log('after edit :', JSON.stringify(editInfo, null, 2));

  // 2b. seeking: frame stepping + the transport scrubber -----------------
  const seekInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const app = window.__cuciApp;
      app.seekTo(2000);
      await new Promise(r => setTimeout(r, 300));
      document.getElementById('btnNextFrame').click();
      await new Promise(r => setTimeout(r, 300));
      const stepped = app.state.playhead;
      const sr = document.getElementById('seekRange');
      sr.value = '5000';
      sr.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 350));
      const v = document.getElementById('video');
      return { stepped: Math.round(stepped), sliderTime: Math.round(v.currentTime * 1000), tc: document.getElementById('timecode').textContent };
    })()`,
  );
  console.log('seek test  :', JSON.stringify(seekInfo));

  // 3. export with burned subtitles ------------------------------------
  const exportResult = await win.webContents.executeJavaScript(
    `(async () => {
      const app = window.__cuciApp;
      const { ranges, total } = app.programRanges();
      const segments = ranges.map(r => { const c = app.state.clips.find(c => c.id === r.clipId); return { path: c.path, start: r.srcStart, end: r.srcEnd, hasAudio: c.hasAudio }; });
      const req = {
        outputPath: ${JSON.stringify(out)}, container: 'mp4', segments,
        width: 640, height: 360, fps: 30, videoCodec: 'libx264', crf: 28, preset: 'ultrafast', audioBitrate: '128k',
        burnSubtitles: true, subtitleSrt: app.CU.serializeSrt(app.remapAll()),
      };
      return await app.api.exportVideo(req);
    })()`,
  );
  console.log('export     :', JSON.stringify(exportResult));

  // 4. in/out marks: Clear button + double-click removal -----------------
  const marksInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const app = window.__cuciApp;
      app.seekTo(1000);
      document.getElementById('btnSetIn').click();
      app.seekTo(2500);
      document.getElementById('btnSetOut').click();
      const before = { in: app.state.inPoint, out: app.state.outPoint };
      document.getElementById('btnClearMarks').click();
      const afterMarks = { in: app.state.inPoint, out: app.state.outPoint };
      document.getElementById('btnClearCuts').click();
      const afterClear = { cuts: app.state.clips[0].cuts.length };
      app.seekTo(1000);
      document.getElementById('btnSetIn').click();
      document.getElementById('tlMarkerIn').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const afterDblclick = app.state.inPoint;
      return { before, afterMarks, afterClear, afterDblclick };
    })()`,
  );
  console.log('clear/marks:', JSON.stringify(marksInfo));

  // 5. right-click context menu on the timeline -------------------------
  const menuInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      a.state.clips[0].cuts = []; a.state.inPoint = null; a.state.outPoint = null; a.renderAll();
      await new Promise(x => setTimeout(x, 80));
      const tl = document.getElementById('timeline');
      const r = tl.getBoundingClientRect();
      const film = document.getElementById('tlFilm');
      const X = (ms) => r.left + (ms / a.state.clips[0].durationMs) * r.width;
      const rightClick = (ms) => film.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: X(ms), clientY: r.top + 80 }));
      const itemsNow = () => [...document.getElementById('ctxMenu').querySelectorAll('.ctx-item')];

      rightClick(2000);
      await new Promise(x => setTimeout(x, 120));
      const visible = !document.getElementById('ctxMenu').classList.contains('hidden');
      const labels = itemsNow().map(e => e.textContent);
      itemsNow().find(e => e.textContent.startsWith('Set In here')).click();
      await new Promise(x => setTimeout(x, 80));
      const inPoint = a.state.inPoint;
      const hiddenAfterClick = document.getElementById('ctxMenu').classList.contains('hidden');

      rightClick(5000);
      await new Promise(x => setTimeout(x, 120));
      itemsNow().find(e => e.textContent.startsWith('Set Out here')).click();
      await new Promise(x => setTimeout(x, 80));

      rightClick(5000);
      await new Promise(x => setTimeout(x, 120));
      const cutItem = itemsNow().find(e => e.textContent.startsWith('Cut In'));
      const cutDisabled = cutItem.classList.contains('disabled');
      cutItem.click();
      await new Promise(x => setTimeout(x, 120));
      const cuts = a.state.clips[0].cuts.map(c => [Math.round(c.start), Math.round(c.end)]);
      return { visible, labels, inPoint, hiddenAfterClick, cutDisabled, cuts };
    })()`,
  );
  console.log('ctx menu   :', JSON.stringify(menuInfo));

  // 6. cut job: encode share code, decode, re-apply ---------------------
  const jobInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      const clip = a.state.clips[0];
      clip.cuts = [{ id: 'x', start: 1000, end: 2000 }];
      a.state.globalSubOffset = -250;
      a.state.jobDescription = 'Remove intro and sponsor break';
      const job = a.buildJob(true);
      const code = await a.encodeShareCode(job);
      const back = await a.decodeShareCode(code);
      clip.cuts = [];
      a.state.globalSubOffset = 0;
      const res = a.applyJob(back);
      let badThrew = false;
      try { await a.decodeShareCode('not-a-code'); } catch { badThrew = true; }
      return {
        prefix: code.slice(0, 9),
        codeLen: code.length,
        name: back.clips[0].name,
        description: back.description,
        appliedDesc: a.state.jobDescription,
        embeddedSubs: !!(back.clips[0].subtitle && back.clips[0].subtitle.events && back.clips[0].subtitle.events.length),
        cuts: clip.cuts.map(c => [Math.round(c.start), Math.round(c.end)]),
        offset: a.state.globalSubOffset,
        matched: res.matched, missing: res.missing.length, badThrew,
      };
    })()`,
  );
  console.log('cut job    :', JSON.stringify(jobInfo));

  // 7. NSFW scan modal + applying detected ranges as cuts --------------
  const nsfwInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      a.state.clips[0].cuts = []; a.renderAll();
      document.getElementById('btnNsfw').click();
      await new Promise(r => setTimeout(r, 700));
      const modalOpen = !document.getElementById('nsfwModal').classList.contains('hidden');
      const modelInfo = document.getElementById('nsfwModelInfo').textContent;
      const iv = document.getElementById('nsfwInterval');
      iv.value = '1';
      iv.dispatchEvent(new Event('input', { bubbles: true }));
      const estimate = document.getElementById('nsfwEstimate').textContent;
      const before = a.state.clips[0].cuts.length;
      const added = a.applyNsfwSegments([{ start: 1000, end: 3000 }, { start: 4000, end: 6000 }]);
      const cuts = a.state.clips[0].cuts.map(c => [Math.round(c.start), Math.round(c.end)]);
      const cutBlocks = document.querySelectorAll('#tlCuts .tl-cut').length;
      document.getElementById('nsfwClose').click();
      a.state.clips[0].cuts = []; a.renderAll();
      return { modalOpen, hasModelInfo: /vit-base-nsfw/.test(modelInfo), estimate, before, added, cuts, cutBlocks };
    })()`,
  );
  console.log('nsfw       :', JSON.stringify(nsfwInfo));

  let outDur = 0;
  let outStreams = '';
  let outSize = 0;
  if (exportResult.ok && fs.existsSync(out)) {
    outDur = Number(sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out]).trim());
    outStreams = sh(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).trim().replace(/\n/g, '+');
    outSize = fs.statSync(out).size;
  }
  console.log(`output     : ${outDur.toFixed(3)}s, ${outSize} bytes, streams=${outStreams}  (expected ~5.000s video+audio)`);

  const remapOk =
    editInfo.subtitleEvents === 3 &&
    editInfo.remapped.length === 2 &&
    editInfo.remapped[0][2] === 'Kept A' &&
    editInfo.remapped[1][2] === 'Kept B' &&
    Math.round(editInfo.remapped[1][0]) === 1500 &&
    editInfo.total === 5000;
  const exportOk = exportResult.ok && Math.abs(outDur - 5.0) < 0.25 && /video/.test(outStreams) && /audio/.test(outStreams);
  const seekOk = Math.abs(seekInfo.stepped - 2033) <= 15 && Math.abs(seekInfo.sliderTime - 3000) <= 80;
  const marksOk =
    marksInfo.before.in === 1000 &&
    marksInfo.before.out === 2500 &&
    marksInfo.afterMarks.in === null &&
    marksInfo.afterMarks.out === null &&
    marksInfo.afterClear.cuts === 0 &&
    marksInfo.afterDblclick === null;
  const guardOk = guardInfo.warned && guardInfo.armed && guardInfo.exporting === false;
  const nsfwOk =
    nsfwInfo.modalOpen === true &&
    nsfwInfo.hasModelInfo === true &&
    nsfwInfo.estimate.includes('frames to analyze') &&
    nsfwInfo.before === 0 &&
    nsfwInfo.added === 2 &&
    nsfwInfo.cuts.length === 2 &&
    nsfwInfo.cuts[0][0] === 1000 &&
    nsfwInfo.cuts[0][1] === 3000 &&
    nsfwInfo.cuts[1][0] === 4000 &&
    nsfwInfo.cuts[1][1] === 6000 &&
    nsfwInfo.cutBlocks === 2;
  const statusOk =
    statusInfo.exists &&
    statusInfo.info.includes('source.mp4') &&
    statusInfo.historyOpens === true &&
    statusInfo.logRows > 0;
  const thumbSettingOk =
    thumbSettingInfo.checked === false &&
    thumbSettingInfo.state === false &&
    thumbsOff.imgs === 0 &&
    thumbsOff.hint === true &&
    /disabled/i.test(thumbsOff.text);
  const dblOk =
    dblInfo.after1.in === 1000 &&
    dblInfo.after1.out === null &&
    dblInfo.after2.in === 1000 &&
    dblInfo.after2.out === 4000 &&
    dblInfo.after3.in === 5000 &&
    dblInfo.after3.out === null;
  const jobOk =
    jobInfo.prefix === 'CUCI2-1z.' &&
    jobInfo.name === 'source.mp4' &&
    jobInfo.description === 'Remove intro and sponsor break' &&
    jobInfo.appliedDesc === 'Remove intro and sponsor break' &&
    jobInfo.embeddedSubs === true &&
    jobInfo.cuts.length === 1 &&
    jobInfo.cuts[0][0] === 1000 &&
    jobInfo.cuts[0][1] === 2000 &&
    jobInfo.offset === -250 &&
    jobInfo.matched === 1 &&
    jobInfo.missing === 0 &&
    jobInfo.badThrew === true;
  const has = (s) => menuInfo.labels.some((l) => l.startsWith(s));
  const menuOk =
    menuInfo.visible &&
    has('Set In here') &&
    has('Set Out here') &&
    has('Cut In') &&
    has('Clear marks') &&
    has('Clear cuts') &&
    menuInfo.inPoint === 2000 &&
    menuInfo.hiddenAfterClick &&
    menuInfo.cutDisabled === false &&
    menuInfo.cuts.length === 1 &&
    menuInfo.cuts[0][0] === 2000 &&
    menuInfo.cuts[0][1] === 5000;

  const errors = messages.filter((m) => m.startsWith('[3]') || m.startsWith('[2]'));
  if (errors.length) {
    console.log('── renderer warnings/errors ──');
    errors.forEach((m) => console.log('  ' + m));
  }

  console.log('\nsubtitle remap :', remapOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('seek / step    :', seekOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('clear / marks  :', marksOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('context menu   :', menuOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('cut job codec  :', jobOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('status bar     :', statusOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('nsfw detect    :', nsfwOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('thumbs default :', thumbSettingOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('dbl-click mark :', dblOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('export guard   :', guardOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('export pipeline:', exportOk ? 'PASS ✅' : 'FAIL ❌');
  const allOk = remapOk && seekOk && marksOk && menuOk && jobOk && nsfwOk && statusOk && thumbSettingOk && dblOk && guardOk && exportOk;
  console.log('\nE2E:', allOk ? 'PASS ✅' : 'FAIL ❌');
  app.exit(allOk ? 0 : 1);
});
