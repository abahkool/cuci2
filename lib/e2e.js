'use strict';

/**
 * Full end-to-end test through the real renderer + real IPC handlers:
 * generate media → load it → add subtitles → make a delete → verify subtitle
 * remapping → export (with burned subtitles) → verify the output.
 *
 *   npx electron lib/e2e.js
 */

const { app, BrowserWindow, protocol, Menu, ipcMain } = require('electron');
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
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cuci-e2e-userdata-')));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuci-e2e-'));
const video = path.join(tmp, 'source.mp4');
const srt = path.join(tmp, 'subs.srt');
const srt2 = path.join(tmp, 'subs2.srt');
const out = path.join(tmp, 'result.mp4');

sh(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
fs.writeFileSync(
  srt,
  ['1', '00:00:00,000 --> 00:00:00,800', 'Kept A', '', '2', '00:00:01,200 --> 00:00:01,800', 'Inside the delete', '', '3', '00:00:02,500 --> 00:00:03,500', 'Kept B', ''].join('\n'),
);
fs.writeFileSync(
  srt2,
  ['1', '00:00:00,000 --> 00:00:00,500', 'Halo', '', '2', '00:00:02,000 --> 00:00:02,500', 'Dunia', ''].join('\n'),
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

  // 0a. first-run product tour + rating prompt --------------------------
  const tourInfo = await win.webContents.executeJavaScript(`(() => {
    const a = window.__cuciApp;
    const root = document.getElementById('tourRoot');
    const spot = document.getElementById('tourSpot');
    const welcome = {
      visible: !root.classList.contains('hidden'),
      welcomeClass: root.classList.contains('welcome'),
      spotHidden: spot.classList.contains('hidden'),
      index: a.tourStep().index,
      total: a.tourStep().total,
      title: document.getElementById('tourTitle').textContent,
      next: document.getElementById('tourNext').textContent,
      skip: document.getElementById('tourSkip').textContent,
      backHidden: document.getElementById('tourBack').classList.contains('hidden'),
    };
    document.getElementById('tourNext').click();
    const target = document.querySelector('#btnAddVideo').getBoundingClientRect();
    const ring = spot.getBoundingClientRect();
    const first = {
      index: a.tourStep().index,
      welcomeClass: root.classList.contains('welcome'),
      spotHidden: spot.classList.contains('hidden'),
      title: document.getElementById('tourTitle').textContent,
      ringDx: Math.round(ring.left - target.left),
      ringDw: Math.round(ring.width - target.width),
    };
    document.getElementById('tourBack').click();
    const back = a.tourStep().index;
    document.getElementById('tourSkip').click();
    const skippedFlag = root.classList.contains('hidden') ? localStorage.getItem('cuci.tour') : 'still-open';
    document.getElementById('btnGuide').click();
    document.getElementById('guideTour').click();
    const reopened = !root.classList.contains('hidden');
    const guideHidden = document.getElementById('guideModal').classList.contains('hidden');
    a.endTour(true);
    return { welcome, first, back, skippedFlag, reopened, guideHidden };
  })()`);
  const tourOk =
    tourInfo.welcome.visible === true &&
    tourInfo.welcome.welcomeClass === true &&
    tourInfo.welcome.spotHidden === true &&
    tourInfo.welcome.total === 6 &&
    tourInfo.welcome.index === 0 &&
    tourInfo.welcome.title.length > 3 &&
    tourInfo.welcome.next === 'Next' &&
    tourInfo.welcome.skip.length > 3 &&
    tourInfo.welcome.backHidden === true &&
    tourInfo.first.index === 1 &&
    tourInfo.first.welcomeClass === false &&
    tourInfo.first.spotHidden === false &&
    tourInfo.first.ringDx === -6 &&
    tourInfo.first.ringDw === 12 &&
    tourInfo.back === 0 &&
    tourInfo.skippedFlag === '1' &&
    tourInfo.reopened === true &&
    tourInfo.guideHidden === true;
  console.log('welcome card  :', JSON.stringify(tourInfo.welcome), 'skip:', tourInfo.skippedFlag, 'reopen:', tourInfo.reopened);

  // the Store launch is stubbed so the test never opens a real Store page
  ipcMain.removeHandler('store:open');
  ipcMain.handle('store:open', async () => ({ ok: true, url: 'ms-windows-store://stub' }));

  const rateInfo = await win.webContents.executeJavaScript(`(async () => {
    const a = window.__cuciApp;
    const modal = document.getElementById('rateModal');
    const isOpen = () => !modal.classList.contains('hidden');
    a.openRating();
    const open = isOpen();
    const stars = document.querySelectorAll('.rate-stars span').length;
    const cta = document.getElementById('rateGo').textContent;
    const store = typeof a.api.openStoreListing === 'function';
    modal.click();
    const afterBackdrop = isOpen();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const afterEscape = isOpen();
    document.getElementById('rateGo').click();
    await new Promise((r) => setTimeout(r, 300));
    const afterRate = isOpen();
    const status = document.getElementById('rateStatus').textContent;
    const ratedAfterRate = localStorage.getItem('cuci.rated');
    document.getElementById('rateClose').click();
    const afterClose = isOpen();
    a.openRating();
    document.getElementById('rateLater').click();
    const afterLater = isOpen();
    a.openRating();
    document.getElementById('rateDone').click();
    const afterDone = isOpen();
    return {
      open, stars, cta, store, afterBackdrop, afterEscape, afterRate, status, ratedAfterRate,
      afterClose, afterLater, afterDone,
      ratedFlag: localStorage.getItem('cuci.rated'),
      launches: localStorage.getItem('cuci.launches'),
    };
  })()`, true);
  const rateOk =
    rateInfo.open === true &&
    rateInfo.stars === 5 &&
    rateInfo.cta.length > 3 &&
    rateInfo.store === true &&
    rateInfo.afterBackdrop === true &&
    rateInfo.afterEscape === true &&
    rateInfo.afterRate === true &&
    rateInfo.status.length > 5 &&
    rateInfo.ratedAfterRate === null &&
    rateInfo.afterClose === false &&
    rateInfo.afterLater === false &&
    rateInfo.afterDone === false &&
    rateInfo.ratedFlag === '1' &&
    rateInfo.launches === '1';
  console.log('rating prompt :', JSON.stringify(rateInfo));

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

  // the subtitle text list stays collapsed until a track is loaded
  const subEventsEmpty = await win.webContents.executeJavaScript(
    `(() => { const l = document.getElementById('subEventList'); const b = document.getElementById('btnToggleSubEvents'); return { hidden: l.classList.contains('hidden'), aria: b.getAttribute('aria-expanded'), title: b.title }; })()`,
  );
  console.log('sub text   :', JSON.stringify(subEventsEmpty));

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

  // 1c. appearance: theme + language + RTL --------------------------------
  const appearanceInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const $ = (id) => document.getElementById(id);
      const out = {};
      $('btnSettings').click();
      await wait(200);
      out.themes = [...$('setTheme').options].map((o) => o.value);
      out.languages = [...$('setLanguage').options].map((o) => o.value);
      $('setTheme').value = 'light';
      $('setTheme').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(150);
      out.light = document.documentElement.dataset.theme === 'light';
      $('setTheme').value = 'dark';
      $('setTheme').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(150);
      out.dark = document.documentElement.dataset.theme === 'dark';
      $('setLanguage').value = 'ms';
      $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);
      out.malayExport = $('btnExport').textContent;
      out.malayPinTitle = document.querySelector('.pane-title').textContent;
      $('setLanguage').value = 'ar';
      $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);
      out.arabicRtl = document.documentElement.dir === 'rtl' && document.documentElement.lang === 'ar';
      $('setLanguage').value = 'zh';
      $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);
      out.chineseExport = $('btnExport').textContent;
      $('setLanguage').value = 'en';
      $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);
      out.backToEnglish = $('btnExport').textContent === 'Export' && document.documentElement.dir === 'ltr';
      // settings apply immediately — there is no Save button
      out.noSaveButton = !document.getElementById('setSave');
      const pb = $('setPreferBundled');
      const pbBefore = pb.checked;
      pb.checked = !pbBefore;
      pb.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(700);
      out.autoApplied = (await window.__cuciApp.api.getInfo()).settings.preferBundled === pb.checked;
      pb.checked = pbBefore;
      pb.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(400);
      // user guide (button + F1), translated with the current language
      $('btnGuide').click();
      await wait(200);
      out.guideOpen = !document.getElementById('guideModal').classList.contains('hidden');
      out.guideSections = document.querySelectorAll('#guideModal .guide-section').length;
      out.guideShortcuts = document.querySelectorAll('#guideModal .guide-keys tr').length;
      out.guideTitleEn = document.querySelector('#guideModal h2').textContent;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true }));
      await wait(150);
      out.guideF1Closed = document.getElementById('guideModal').classList.contains('hidden');
      $('btnGuide').click();
      await wait(150);
      $('setLanguage').value = 'ms';
      $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      out.guideTitleMs = document.querySelector('#guideModal h2').textContent;
      $('setLanguage').value = 'en';
      $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      document.getElementById('guideClose2').click();
      await wait(150);
      out.guideClosed = document.getElementById('guideModal').classList.contains('hidden');
      $('expClose');
      $('setClose').click();
      await wait(150);
      return out;
    })()`,
  );
  console.log('appearance :', JSON.stringify(appearanceInfo));

  // 1d. native application menu ----------------------------------------
  await sleep(500);
  const appMenu = Menu.getApplicationMenu();
  const topLabels = appMenu ? appMenu.items.map((i) => i.label) : [];
  const fileMenu = appMenu ? appMenu.items.find((i) => i.label === 'File') : null;
  const viewMenu = appMenu ? appMenu.items.find((i) => i.label === 'View') : null;
  const helpMenu = appMenu ? appMenu.items.find((i) => i.label === 'Help') : null;
  const fileItems = fileMenu ? fileMenu.submenu.items.map((i) => i.label) : [];
  const viewItems = viewMenu ? viewMenu.submenu.items.map((i) => i.label) : [];
  const themeMenu = viewMenu && viewMenu.submenu.items.find((i) => i.label === 'Appearance');
  const themeSub = themeMenu ? themeMenu.submenu.items.find((i) => i.label === 'Theme') : null;
  const themeDarkChecked = themeSub ? themeSub.submenu.items.some((i) => i.type === 'radio' && i.checked && /Dark/i.test(i.label)) : false;
  const guideItem = helpMenu ? helpMenu.submenu.items.find((i) => i.accelerator === 'F1') : null;
  if (guideItem) guideItem.click();
  await sleep(500);
  const menuGuideOpened = await win.webContents.executeJavaScript(
    `!document.getElementById('guideModal').classList.contains('hidden')`,
  );
  await win.webContents.executeJavaScript(`document.getElementById('guideClose2').click()`);
  await sleep(150);
  // a menu action reaches the renderer (View > Preview)
  const modeItem = viewMenu ? viewMenu.submenu.items.find((i) => i.label === 'Preview') : null;
  if (modeItem) modeItem.click();
  await sleep(900);
  const menuPreview = await win.webContents.executeJavaScript(`window.__cuciApp.state.playMode`);
  if (viewMenu) viewMenu.submenu.items.find((i) => i.label === 'Source').click();
  await sleep(600);
  const menuSource = await win.webContents.executeJavaScript(`window.__cuciApp.state.playMode`);
  const menuInfo = {
    topLabels,
    hasFile: !!fileMenu,
    hasEdit: !!appMenu.items.find((i) => i.label === 'Edit'),
    hasView: !!viewMenu,
    hasHelp: !!helpMenu,
    fileItems,
    hasExportAccel: !!(fileMenu && fileMenu.submenu.items.some((i) => i.accelerator === 'CmdOrCtrl+E')),
    themeDarkChecked,
    guideItem: !!guideItem,
    menuGuideOpened,
    menuPreview,
    menuSource,
    noDefaultReload: !topLabels.includes('Window'),
  };
  console.log('menu       :', JSON.stringify(menuInfo));

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

  // 1b. export guard: no deletes yet -> warns and requires confirmation -----
  const guardInfo = await win.webContents.executeJavaScript(
    `(async () => {
      document.getElementById('btnExport').click();
      await new Promise(r => setTimeout(r, 200));
      const summary = document.getElementById('expSummary').innerText;
      const warned = summary.includes('No deletions set');
      document.getElementById('expStart').click();
      await new Promise(r => setTimeout(r, 200));
      const armed = document.getElementById('expStart').textContent.includes('Click again');
      const exporting = window.__cuciApp.state.exporting;
      document.getElementById('expClose').click();
      return { warned, armed, exporting };
    })()`,
  );
  console.log('export guard:', JSON.stringify(guardInfo));

  // 1c. export formats: picking a container drives codecs + extension -----
  const formatInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const $ = (id) => document.getElementById(id);
      const out = {};
      $('btnExport').click();
      await wait(250);
      out.formats = [...$('expContainer').options].map((o) => o.value);
      $('expContainer').value = 'webm';
      $('expContainer').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(150);
      out.webmCodecs = [...$('expVcodec').options].map((o) => o.value);
      out.webmPath = $('expPath').value;
      out.webmSummary = $('expSummary').innerText;
      $('expContainer').value = 'avi';
      $('expContainer').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(150);
      out.aviCodecs = [...$('expVcodec').options].map((o) => o.value);
      out.aviPath = $('expPath').value;
      $('expContainer').value = 'mp4';
      $('expContainer').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(150);
      $('expClose').click();
      await wait(150);
      return out;
    })()`,
  );
  console.log('formats    :', JSON.stringify(formatInfo));

  // 2. subtitles + delete --------------------------------------------------
  const editInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const app = window.__cuciApp;
      const clip = app.state.clips[0];
      await app.loadSubtitleFromPath(clip, ${JSON.stringify(srt)});
      app.addDelete(1000, 2000);
      const ranges = app.keptRanges(clip);
      const remapped = app.remapAll();
      return {
        deletes: clip.deletes.length,
        ranges: ranges.map(r => [r.start, r.end]),
        total: app.programRanges().total,
        subtitleEvents: clip.subtitles[0].events.length,
        remapped: remapped.map(e => [Math.round(e.start), Math.round(e.end), e.text]),
        subBlocks: document.querySelectorAll('#tlSubs .tl-sub').length,
        deleteBlocks: document.querySelectorAll('#tlDeletes .tl-delete').length,
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

  // 2b2. Result preview: a seek must move playback, not restart at 0:00 --
  const resultSeekInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const $ = (id) => document.getElementById(id);
      const app = window.__cuciApp;
      const out = {};
      $('modeResult').click();      // result mode (may start playing)
      await wait(600);
      $('btnStop').click();         // pause + result position 0
      await wait(300);
      out.total = app.programRanges().total;

      // scrub to 3s of the 4s result, then press play
      const sr = $('seekRange');
      sr.value = String(Math.round((3000 / out.total) * 10000));
      sr.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(500);
      out.seek = Math.round(app.state.resultTime);
      $('btnPlay').click();
      await wait(400);
      out.play = Math.round(app.state.resultTime);
      out.videoT = Math.round($('video').currentTime * 1000);
      $('btnStop').click();
      await wait(300);

      // a timeline click maps the source time (3s) to output time (2s)
      const tl = $('timeline');
      const r = tl.getBoundingClientRect();
      const x = r.left + (3000 / app.state.clips[0].durationMs) * r.width;
      const opt = { bubbles: true, cancelable: true, clientX: x, clientY: r.top + 10, pointerId: 5, button: 0 };
      $('tlRuler').dispatchEvent(new PointerEvent('pointerdown', opt));
      window.dispatchEvent(new PointerEvent('pointerup', opt));
      await wait(500);
      out.timeline = Math.round(app.state.resultTime);
      out.timelinePlayhead = Math.round(app.state.playhead);
      $('modeSource').click();      // back to source mode for the rest of the suite
      await wait(500);
      return out;
    })()`,
  );
  console.log('result seek:', JSON.stringify(resultSeekInfo));

  // 2c. player / timeline splitter ---------------------------------------
  const splitInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const h = document.getElementById('playerSplitter');
      const r = h.getBoundingClientRect();
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const tl = () => Math.round(document.getElementById('timelineWrap').getBoundingClientRect().height);
      const before = tl();
      const y = r.top + 4;
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 20, clientY: y, pointerId: 1, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 20, clientY: y - 60, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 20, clientY: y - 60, pointerId: 1 }));
      await wait(150);
      const grown = tl();
      h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await wait(150);
      return { before, grown, reset: tl() };
    })()`,
  );
  console.log('splitter   :', JSON.stringify(splitInfo));

  // 2d. workspace layout: pin (auto-hide) + temporary peek ---------------
  const layoutInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const byId = (id) => document.getElementById(id);
      const box = (id) => byId(id).getBoundingClientRect();
      const player = () => document.querySelector('.player-wrap').getBoundingClientRect();
      const pressed = (id) => byId(id).getAttribute('aria-pressed') === 'true';
      const hover = () => byId('playerWrap').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      const out = {};
      const playerBefore = Math.round(player().width);
      out.defaultPinned = pressed('btnPinSidebar') && pressed('btnPinTransport');
      out.sidebarDocked = Math.round(box('sidebar').width) > 100;

      byId('btnPinSidebar').click();
      await wait(120);
      out.sidebarHidden = Math.round(box('sidebar').width) === 0;
      out.playerGrew = Math.round(player().width) > playerBefore + 100;
      out.revealOffered = !byId('btnRevealSidebar').classList.contains('hidden');

      hover();
      await wait(40);
      out.handlesVisible = byId('revealBar').classList.contains('visible');
      byId('btnRevealSidebar').click();
      await wait(220);
      out.peekShown = Math.round(box('sidebar').width) > 100;
      out.peekNotPinned = !pressed('btnPinSidebar') && getComputedStyle(byId('sidebar')).position === 'fixed';
      hover();
      await wait(520);
      out.peekClosed = Math.round(box('sidebar').width) === 0;

      hover();
      await wait(40);
      byId('btnRevealSidebar').click();
      await wait(220);
      byId('btnPinSidebar').click();
      await wait(160);
      out.pinnedBack = pressed('btnPinSidebar') && Math.round(box('sidebar').width) > 100;

      // the timeline rides with the control center
      byId('btnPinTransport').click();
      await wait(140);
      out.controlsHidden = Math.round(box('transportBar').height) === 0;
      out.timelineFollowsHide = Math.round(box('timelineWrap').height) === 0;
      hover();
      await wait(40);
      out.controlsHandle = !byId('btnRevealTransport').classList.contains('hidden');
      byId('btnRevealTransport').click();
      await wait(240);
      out.controlsPeek = Math.round(box('transportBar').height) > 20 && Math.round(box('timelineWrap').height) > 20;
      out.controlsPeekNotPinned = !pressed('btnPinTransport');
      hover();
      await wait(560);
      out.controlsPeekClosed = Math.round(box('transportBar').height) === 0 && Math.round(box('timelineWrap').height) === 0;
      byId('btnRevealTransport').click();
      await wait(240);
      byId('btnPinTransport').click();
      await wait(160);
      out.controlsPinnedBack = pressed('btnPinTransport') && Math.round(box('transportBar').height) > 20 && Math.round(box('timelineWrap').height) > 20;
      localStorage.removeItem('cuci.layout');
      return out;
    })()`,
  );
  console.log('layout     :', JSON.stringify(layoutInfo));

  // 2e. detached panels are real OS windows -------------------------------
  const panelInfo = {};
  try {
    const findPanel = (name) =>
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('panel=' + name));
    const waitForPanel = async (name) => {
      for (let i = 0; i < 60; i++) {
        const w = findPanel(name);
        if (w) return w;
        await sleep(100);
      }
      return null;
    };
    const waitForPanelGone = async (name) => {
      for (let i = 0; i < 60 && findPanel(name); i++) await sleep(100);
      return !findPanel(name);
    };
    const clickMain = (id) => win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`);
    const windowsBefore = BrowserWindow.getAllWindows().length;

    // ---- control center window
    await clickMain('btnDetachTransport');
    const tWin = await waitForPanel('transport');
    panelInfo.transportOpened = !!tWin && BrowserWindow.getAllWindows().length === windowsBefore + 1;
    panelInfo.transportMainHidden = await win.webContents.executeJavaScript(
      `getComputedStyle(document.getElementById('transportBar')).display === 'none'`,
    );
    panelInfo.timelineHiddenInMain = await win.webContents.executeJavaScript(
      `getComputedStyle(document.getElementById('timelineWrap')).display === 'none'`,
    );
    if (tWin) {
      for (let i = 0; i < 60; i++) {
        const ok = await tWin.webContents.executeJavaScript(
          `document.body.dataset.panel === 'transport' && !!document.getElementById('btnNextSec')`,
        );
        if (ok) break;
        await sleep(100);
      }
      await sleep(500);
      panelInfo.transportHost = await tWin.webContents.executeJavaScript(`document.body.dataset.panel`);
      panelInfo.transportVisible = await tWin.webContents.executeJavaScript(`!document.getElementById('panelTransport').hidden`);
      panelInfo.transportTheme = await tWin.webContents.executeJavaScript(`document.documentElement.dataset.theme`);
      // the detached window follows the main theme, not the OS colour scheme
      await win.webContents.executeJavaScript(`(() => {
        const s = document.getElementById('setTheme');
        s.value = 'light';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(500);
      panelInfo.transportThemeLight = await tWin.webContents.executeJavaScript(`document.documentElement.dataset.theme`);
      panelInfo.panelLightBg = await tWin.webContents.executeJavaScript(
        `getComputedStyle(document.body).backgroundColor`,
      );
      await win.webContents.executeJavaScript(`(() => {
        const s = document.getElementById('setTheme');
        s.value = 'dark';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(400);
      panelInfo.transportThemeBack = await tWin.webContents.executeJavaScript(`document.documentElement.dataset.theme`);

      // the timeline lives in this window too
      panelInfo.panelTimeline = await tWin.webContents.executeJavaScript(`(() => ({
        ticks: document.querySelectorAll('#ptlRuler .tl-tick').length,
        deletes: document.querySelectorAll('#ptlDeletes .tl-delete').length,
        subs: document.querySelectorAll('#ptlSubs .tl-sub').length,
        width: Math.round(document.getElementById('ptlTimeline').getBoundingClientRect().width),
      }))()`);
      const mainDeletes = await win.webContents.executeJavaScript(`window.__cuciApp.state.clips[0].deletes.length`);
      panelInfo.panelTimelineDeletes = panelInfo.panelTimeline.deletes === mainDeletes;

      // drag a range on the panel timeline -> the main window gets a selection
      const geom = await tWin.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('ptlTimeline');
        const r = root.getBoundingClientRect();
        const dur = window.__tlDur || 0;
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      })()`);
      const durMs = await win.webContents.executeJavaScript(`window.__cuciApp.state.clips[0].durationMs`);
      const xAt = (ms) => geom.left + (ms / durMs) * geom.width;
      const y = geom.top + Math.round(geom.height * 0.6);
      await tWin.webContents.executeJavaScript(`(() => {
        const scroll = document.getElementById('ptlScroll');
        const opt = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: ${y}, button: 0, pointerId: 7, pointerType: 'mouse' });
        scroll.dispatchEvent(new PointerEvent('pointerdown', opt(${Math.round(xAt(2000))})));
        scroll.dispatchEvent(new PointerEvent('pointermove', opt(${Math.round(xAt(3000))})));
        scroll.dispatchEvent(new PointerEvent('pointermove', opt(${Math.round(xAt(4000))})));
        scroll.dispatchEvent(new PointerEvent('pointerup', opt(${Math.round(xAt(4000))})));
        return true;
      })()`);
      await sleep(500);
      const sel = await win.webContents.executeJavaScript(`window.__cuciApp.state.selection`);
      panelInfo.panelTimelineSelect = !!sel && Math.abs(sel.start - 2000) < 120 && Math.abs(sel.end - 4000) < 120;

      // double-click marks In in the main window
      await tWin.webContents.executeJavaScript(`(() => {
        const scroll = document.getElementById('ptlScroll');
        scroll.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: ${Math.round(xAt(5000))}, clientY: ${y} }));
        return true;
      })()`);
      await sleep(500);
      const markedIn = await win.webContents.executeJavaScript(`window.__cuciApp.state.inPoint`);
      panelInfo.panelTimelineMark = markedIn != null && Math.abs(markedIn - 5000) < 150;
      await win.webContents.executeJavaScript(
        `(() => { const a = window.__cuciApp; a.state.inPoint = null; a.state.outPoint = null; a.state.selection = null; a.renderAll(); })()`,
      );
      const mainBefore = await win.webContents.executeJavaScript(
        `(() => ({ ph: Math.round(window.__cuciApp.state.playhead), tc: document.getElementById('timecode').textContent }))()`,
      );
      panelInfo.transportInSync =
        (await tWin.webContents.executeJavaScript(`document.getElementById('timecode').textContent`)) === mainBefore.tc;

      await tWin.webContents.executeJavaScript(`document.getElementById('btnNextSec').click()`);
      await sleep(800);
      const mainAfter = await win.webContents.executeJavaScript(
        `(() => ({ ph: Math.round(window.__cuciApp.state.playhead), tc: document.getElementById('timecode').textContent }))()`,
      );
      panelInfo.transportSeekBy = mainAfter.ph - mainBefore.ph;
      panelInfo.transportEcho =
        (await tWin.webContents.executeJavaScript(`document.getElementById('timecode').textContent`)) === mainAfter.tc;

      await tWin.webContents.executeJavaScript(`document.getElementById('btnSetIn').click()`);
      await sleep(500);
      const inPoint = await win.webContents.executeJavaScript(`window.__cuciApp.state.inPoint`);
      panelInfo.transportSetIn = inPoint != null && Math.abs(inPoint - mainAfter.ph) <= 40;
      await win.webContents.executeJavaScript(
        `(() => { const a = window.__cuciApp; a.state.inPoint = null; a.state.outPoint = null; a.renderAll(); })()`,
      );

      await tWin.webContents.executeJavaScript(`document.getElementById('btnDock').click()`);
      panelInfo.transportClosed = await waitForPanelGone('transport');
      await sleep(500);
      const docked = await win.webContents.executeJavaScript(`(() => ({
        visible: document.getElementById('transportBar').getBoundingClientRect().height > 20,
        pressed: document.getElementById('btnDetachTransport').getAttribute('aria-pressed') === 'false',
      }))()`);
      panelInfo.transportRedocked = docked.visible && docked.pressed;
      panelInfo.timelineRedocked = await win.webContents.executeJavaScript(`(() => {
        const tl = document.getElementById('timelineWrap');
        return getComputedStyle(tl).display !== 'none' && tl.getBoundingClientRect().height > 20;
      })()`);
    }

    // ---- side panel window
    await clickMain('btnDetachSidebar');
    const sWin = await waitForPanel('sidebar');
    panelInfo.sidebarOpened = !!sWin && BrowserWindow.getAllWindows().length === windowsBefore + 1;
    if (sWin) {
      for (let i = 0; i < 60; i++) {
        const ok = await sWin.webContents.executeJavaScript(
          `document.body.dataset.panel === 'sidebar' && !!document.getElementById('clipList')`,
        );
        if (ok) break;
        await sleep(100);
      }
      await sleep(500);
      const snap = await sWin.webContents.executeJavaScript(`(() => ({
        host: document.body.dataset.panel,
        visible: !document.getElementById('panelSidebar').hidden && document.getElementById('panelTransport').hidden,
        clipNames: [...document.querySelectorAll('#clipList .clip-name')].map((e) => e.textContent.trim()),
        deleteRows: document.querySelectorAll('#deleteList .delete-item').length,
        trackRows: document.querySelectorAll('#subTrackList .sub-track').length,
        eventRows: document.querySelectorAll('#subEventList .sub-event').length,
      }))()`);
      const mainSnap = await win.webContents.executeJavaScript(`(() => ({
        deletes: window.__cuciApp.state.clips[0].deletes.length,
        tracks: (window.__cuciApp.state.clips[0].subtitles || []).length,
        firstEvent: (window.__cuciApp.state.clips[0].subtitles[0] || { events: [{ start: 0 }] }).events[0].start,
      }))()`);
      panelInfo.sidebarHost = snap.host;
      panelInfo.sidebarVisible = snap.visible;
      panelInfo.sidebarClipShown = snap.clipNames.some((n) => n.includes('source.mp4'));
      panelInfo.sidebarCounts = snap.deleteRows === mainSnap.deletes && snap.trackRows === mainSnap.tracks && snap.eventRows > 0;

      await sWin.webContents.executeJavaScript(`document.querySelector('#subEventList .sub-event').click()`);
      await sleep(600);
      const ph = await win.webContents.executeJavaScript(`window.__cuciApp.state.playhead`);
      panelInfo.sidebarSeek = Math.abs(ph - mainSnap.firstEvent) <= 40;

      sWin.close();
      panelInfo.sidebarClosed = await waitForPanelGone('sidebar');
      await sleep(500);
      panelInfo.sidebarRedocked = await win.webContents.executeJavaScript(
        `document.getElementById('sidebar').getBoundingClientRect().width > 100`,
      );
    }
    await win.webContents.executeJavaScript(`localStorage.removeItem('cuci.layout')`);
  } catch (err) {
    panelInfo.error = err && err.message ? err.message : String(err);
  }
  console.log('panels     :', JSON.stringify(panelInfo));

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
      document.getElementById('btnClearDeletes').click();
      const afterClear = { deletes: app.state.clips[0].deletes.length };
      app.seekTo(1000);
      document.getElementById('btnSetIn').click();
      document.getElementById('tlMarkerIn').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const afterDblclick = app.state.inPoint;
      return { before, afterMarks, afterClear, afterDblclick };
    })()`,
  );
  console.log('clear/marks:', JSON.stringify(marksInfo));

  // 5. right-click context menu on the timeline -------------------------
  const ctxMenuInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      a.state.clips[0].deletes = []; a.state.inPoint = null; a.state.outPoint = null; a.renderAll();
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
      const deleteItem = itemsNow().find(e => e.textContent.startsWith('Delete In'));
      const deleteDisabled = deleteItem.classList.contains('disabled');
      deleteItem.click();
      await new Promise(x => setTimeout(x, 120));
      const deletes = a.state.clips[0].deletes.map(c => [Math.round(c.start), Math.round(c.end)]);
      return { visible, labels, inPoint, hiddenAfterClick, deleteDisabled, deletes };
    })()`,
  );
  console.log('ctx menu   :', JSON.stringify(ctxMenuInfo));

  // 6. delete job: encode share code, decode, re-apply ---------------------
  const jobInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      const clip = a.state.clips[0];
      clip.deletes = [{ id: 'x', start: 1000, end: 2000 }];
      a.state.globalSubOffset = -250;
      a.state.jobDescription = 'Remove intro and sponsor break';
      const job = a.buildJob(true);
      const code = await a.encodeShareCode(job);
      const back = await a.decodeShareCode(code);
      clip.deletes = [];
      a.state.globalSubOffset = 0;
      const res = a.applyJob(back);
      let badThrew = false;
      try { await a.decodeShareCode('not-a-code'); } catch { badThrew = true; }
      return {
        prefix: code.slice(0, 8),
        codeLen: code.length,
        name: back.clips[0].name,
        description: back.description,
        appliedDesc: a.state.jobDescription,
        embeddedSubs: !!(back.clips[0].subtitles[0] && back.clips[0].subtitles[0].events && back.clips[0].subtitles[0].events.length),
        deletes: clip.deletes.map(c => [Math.round(c.start), Math.round(c.end)]),
        offset: a.state.globalSubOffset,
        matched: res.matched, missing: res.missing.length, badThrew,
      };
    })()`,
  );
  console.log('delete job    :', JSON.stringify(jobInfo));

  // 6b. job modal tabs (Export / Import) -------------------------------
  const jobUi = await win.webContents.executeJavaScript(
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const hidden = (id) => document.getElementById(id).classList.contains('hidden');
      document.getElementById('btnJob').click();
      await wait(300);
      const exportVisible = !hidden('jobPanelExport');
      const importHidden = hidden('jobPanelImport');
      document.getElementById('jobTabImport').click();
      await wait(120);
      const importVisible = !hidden('jobPanelImport');
      const exportHidden = hidden('jobPanelExport');
      const importActive = document.getElementById('jobTabImport').classList.contains('active');
      document.getElementById('jobTabExport').click();
      await wait(100);
      const backToExport = !hidden('jobPanelExport');
      document.getElementById('jobClose').click();
      return { exportVisible, importHidden, importVisible, exportHidden, importActive, backToExport };
    })()`,
  );
  console.log('job tabs   :', JSON.stringify(jobUi));

  // 6b2. social sharers (Telegram / WhatsApp / r/cuci) -----------------
  const shareUrls = [];
  ipcMain.removeHandler('share:open');
  ipcMain.handle('share:open', async (_e, url) => {
    shareUrls.push(String(url));
    return { ok: true, url: String(url) };
  });
  const shareUi = await win.webContents.executeJavaScript(
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const click = async (id) => { document.getElementById(id).click(); await wait(350); };
      document.getElementById('btnJob').click();
      await wait(300);
      const hasRefresh = !!document.getElementById('jobRefresh');
      const titles = ['jobShareWa', 'jobShareTg', 'jobShareRd'].map(
        (id) => (document.getElementById(id).getAttribute('title') || '').trim(),
      );
      const codeLen = document.getElementById('jobCode').value.length;
      await click('jobShareTg');
      const clip = await window.__cuciApp.api.clipboardRead();
      await click('jobShareWa');
      await click('jobShareRd');
      document.getElementById('jobClose').click();
      return { hasRefresh, titles, codeLen, clip: String(clip || '') };
    })()`,
  );
  console.log('share buttons :', JSON.stringify({ titles: shareUi.titles, codeLen: shareUi.codeLen, urls: shareUrls.length }));
  const dec = (u) => { try { return decodeURIComponent(u); } catch { return u; } };
  const shareOk =
    shareUi.hasRefresh === false &&
    shareUi.titles.length === 3 &&
    shareUi.titles.every((s) => s.length > 5) &&
    shareUi.codeLen > 50 &&
    shareUi.clip.startsWith('CUCI-') &&
    shareUrls.length === 3 &&
    shareUrls[0].startsWith('https://t.me/share/url') &&
    dec(shareUrls[0]).includes('CUCI-') &&
    dec(shareUrls[0]).includes('apps.microsoft.com') &&
    shareUrls[1].startsWith('https://wa.me/?text=') &&
    dec(shareUrls[1]).includes('CUCI-') &&
    dec(shareUrls[1]).includes('apps.microsoft.com') &&
    shareUrls[2].startsWith('https://www.reddit.com/r/cuci/submit') &&
    dec(shareUrls[2]).includes('CUCI-') &&
    dec(shareUrls[2]).includes('selftext=true');

  // 6c. hostile share code must not execute or inject markup -----------
  const xss = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const NL = String.fromCharCode(10);
      const evil = '<img src=x onerror="window.__pwned=1">';
      const svg = '<svg onload="window.__pwned=2"></svg>';
      const job = a.buildJob(false);
      job.description = evil + ' ' + 'A'.repeat(400);
      job.clips[0].deletes = [];
      job.clips[0].subtitles = [{
        name: evil,
        format: 'srt',
        events: [
          [0, 1000, 'hello ' + evil],
          [1000, 2000, ['ok', '', '99', '00:00:01,000 --> 00:00:02,000', 'INJECTED' + svg].join(NL)],
        ],
      }];
      // Build a PLAIN share code by hand so the payload reaches the decoder exactly
      // as an attacker would send it (bypassing our own encoder's sanitiser).
      const raw = new TextEncoder().encode(JSON.stringify(job));
      let bin = '';
      for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
      const code = 'CUCI-1p.' + btoa(bin).split('+').join('-').split('/').join('_').split('=').join('');

      document.getElementById('btnJob').click();
      await wait(250);
      document.getElementById('jobTabImport').click();
      document.getElementById('jobPaste').value = code;
      document.getElementById('jobImport').click();
      await wait(500);
      // Importing now opens a confirmation summarising the sanitized job.
      const confirmVisible = !document.getElementById('confirmModal').classList.contains('hidden');
      const confirmText = document.getElementById('confirmRows').textContent;
      const confirmInjected = document.querySelectorAll('#confirmRows img, #confirmRows svg, #confirmRows script').length;
      const confirmEscaped = document.getElementById('confirmRows').innerHTML.includes('&lt;img');
      document.getElementById('confirmOk').click();
      await wait(900);

      const clip = a.state.clips[0];
      const srt = a.CU.serializeSrt(a.remapAll());
      const reparsed = a.CU.parseSubtitles(srt);
      const out = {
        pwned: window.__pwned || 0,
        injectedMarkup: document.querySelectorAll('img[onerror], svg[onload]').length,
        descLen: a.state.jobDescription.length,
        subtitleEvents: clip.subtitles[0] ? clip.subtitles[0].events.length : -1,
        srtEvents: reparsed.events.length,
        bodyHasArrow: !reparsed.events.some((e) => e.text.includes('-->')),
        statusHasImgTag: document.getElementById('jobStatus').innerHTML.includes('<img'),
        confirmVisible,
        confirmText,
        confirmInjected,
        confirmEscaped,
      };
      document.getElementById('jobClose').click();
      return out;
    })()`,
  );
  console.log('xss import :', JSON.stringify(xss));

  // 8. multiple subtitle tracks ------------------------------------------
  const multiSub = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const clip = a.state.clips[0];
      const before = clip.subtitles.length;
      await a.loadSubtitleFromPath(clip, ${JSON.stringify(srt2)});
      await wait(200);
      const tracks = clip.subtitles.length;
      const rows = document.querySelectorAll('#subTrackList .sub-track').length;
      const remappedBefore = a.remapAllTracks().length;
      const row = document.querySelectorAll('#subTrackList .sub-track')[tracks - 1];
      const toggle = row.querySelector('.sub-track-toggle');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(150);
      const remappedAfter = a.remapAllTracks().length;

      // re-enable and check the export wiring picks up both tracks
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(150);

      // subtitle text list auto-opens once a track is loaded, and stays collapsible
      const evList = document.getElementById('subEventList');
      const evToggle = document.getElementById('btnToggleSubEvents');
      const evOpenByDefault = !evList.classList.contains('hidden') && evToggle.getAttribute('aria-expanded') === 'true';
      evToggle.click();
      await wait(120);
      const evCollapsed = evList.classList.contains('hidden') && evToggle.getAttribute('aria-expanded') === 'false';
      evToggle.click();
      await wait(120);
      const evReopened = !evList.classList.contains('hidden');
      document.getElementById('btnExport').click();
      await wait(300);
      const burnOpts = document.querySelectorAll('#expBurnTrack option').length;
      const setupTracks = a.currentSetup().tracks.length;
      document.getElementById('expClose').click();
      return { before, tracks, rows, remappedBefore, remappedAfter, burnOpts, setupTracks, evOpenByDefault, evCollapsed, evReopened };
    })()`,
  );
  console.log('multi sub  :', JSON.stringify(multiSub));


  // 7. NSFW scan modal + applying detected ranges as deletes --------------
  const nsfwInfo = await win.webContents.executeJavaScript(
    `(async () => {
      const a = window.__cuciApp;
      a.state.clips[0].deletes = []; a.renderAll();
      document.getElementById('btnNsfw').click();
      await new Promise(r => setTimeout(r, 700));
      const modalOpen = !document.getElementById('nsfwModal').classList.contains('hidden');
      const modelInfo = document.getElementById('nsfwModelInfo').textContent;
      const iv = document.getElementById('nsfwInterval');
      iv.value = '1';
      iv.dispatchEvent(new Event('input', { bubbles: true }));
      const estimate = document.getElementById('nsfwEstimate').textContent;
      const before = a.state.clips[0].deletes.length;
      const added = a.applyNsfwSegments([{ start: 1000, end: 3000 }, { start: 4000, end: 6000 }]);
      const deletes = a.state.clips[0].deletes.map(c => [Math.round(c.start), Math.round(c.end)]);
      const deleteBlocks = document.querySelectorAll('#tlDeletes .tl-delete').length;
      document.getElementById('nsfwClose').click();
      a.state.clips[0].deletes = []; a.renderAll();
      return { modalOpen, hasModelInfo: /vit-base-nsfw/.test(modelInfo), estimate, before, added, deletes, deleteBlocks };
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
  const splitOk = splitInfo.grown > splitInfo.before + 40 && Math.abs(splitInfo.reset - 260) <= 2;
  const resultSeekOk =
    Math.abs(resultSeekInfo.seek - 3000) < 120 &&
    resultSeekInfo.play >= 2900 &&
    resultSeekInfo.play < 3600 &&
    resultSeekInfo.videoT >= 3900 &&
    Math.abs(resultSeekInfo.timeline - 2000) < 120 &&
    Math.abs(resultSeekInfo.timelinePlayhead - 3000) < 120;
  const layoutOk =
    layoutInfo.defaultPinned &&
    layoutInfo.sidebarDocked &&
    layoutInfo.sidebarHidden &&
    layoutInfo.playerGrew &&
    layoutInfo.revealOffered &&
    layoutInfo.handlesVisible &&
    layoutInfo.peekShown &&
    layoutInfo.peekNotPinned &&
    layoutInfo.peekClosed &&
    layoutInfo.pinnedBack &&
    layoutInfo.controlsHidden &&
    layoutInfo.timelineFollowsHide &&
    layoutInfo.controlsHandle &&
    layoutInfo.controlsPeek &&
    layoutInfo.controlsPeekNotPinned &&
    layoutInfo.controlsPeekClosed &&
    layoutInfo.controlsPinnedBack;
  const panelsOk =
    panelInfo.transportOpened &&
    panelInfo.transportMainHidden &&
    panelInfo.timelineHiddenInMain &&
    panelInfo.panelTimeline &&
    panelInfo.panelTimeline.ticks > 0 &&
    panelInfo.panelTimeline.width > 200 &&
    panelInfo.panelTimelineDeletes &&
    panelInfo.panelTimelineSelect &&
    panelInfo.panelTimelineMark &&
    panelInfo.timelineRedocked &&
    panelInfo.transportHost === 'transport' &&
    panelInfo.transportVisible &&
    panelInfo.transportTheme === 'dark' &&
    panelInfo.transportThemeLight === 'light' &&
    panelInfo.transportThemeBack === 'dark' &&
    panelInfo.transportInSync &&
    Math.abs(panelInfo.transportSeekBy - 1000) <= 60 &&
    panelInfo.transportEcho &&
    panelInfo.transportSetIn &&
    panelInfo.transportClosed &&
    panelInfo.transportRedocked &&
    panelInfo.sidebarOpened &&
    panelInfo.sidebarHost === 'sidebar' &&
    panelInfo.sidebarVisible &&
    panelInfo.sidebarClipShown &&
    panelInfo.sidebarCounts &&
    panelInfo.sidebarSeek &&
    panelInfo.sidebarClosed &&
    panelInfo.sidebarRedocked;
  const marksOk =
    marksInfo.before.in === 1000 &&
    marksInfo.before.out === 2500 &&
    marksInfo.afterMarks.in === null &&
    marksInfo.afterMarks.out === null &&
    marksInfo.afterClear.deletes === 0 &&
    marksInfo.afterDblclick === null;
  const guardOk = guardInfo.warned && guardInfo.armed && guardInfo.exporting === false;
  const appearanceOk =
    ['system', 'dark', 'light'].every((m) => appearanceInfo.themes.includes(m)) &&
    ['auto', 'en', 'ms', 'ar', 'zh', 'ja'].every((l) => appearanceInfo.languages.includes(l)) &&
    appearanceInfo.light &&
    appearanceInfo.dark &&
    appearanceInfo.malayExport === 'Eksport' &&
    appearanceInfo.malayPinTitle === 'Panel Sisi' &&
    appearanceInfo.arabicRtl &&
    appearanceInfo.chineseExport === '导出' &&
    appearanceInfo.backToEnglish &&
    appearanceInfo.noSaveButton === true &&
    appearanceInfo.autoApplied === true &&
    appearanceInfo.guideOpen &&
    appearanceInfo.guideSections >= 8 &&
    appearanceInfo.guideShortcuts >= 12 &&
    appearanceInfo.guideTitleEn === 'User guide' &&
    appearanceInfo.guideF1Closed &&
    appearanceInfo.guideTitleMs === 'Panduan Pengguna' &&
    appearanceInfo.guideClosed;
  const menuOk =
    menuInfo.hasFile &&
    menuInfo.hasEdit &&
    menuInfo.hasView &&
    menuInfo.hasHelp &&
    menuInfo.fileItems.some((l) => /Export/.test(l)) &&
    menuInfo.hasExportAccel &&
    menuInfo.themeDarkChecked &&
    menuInfo.guideItem &&
    menuInfo.menuGuideOpened &&
    menuInfo.menuPreview === 'result' &&
    menuInfo.menuSource === 'source' &&
    menuInfo.noDefaultReload;
  const formatOk =
    ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts'].every((f) => formatInfo.formats.includes(f)) &&
    formatInfo.webmCodecs.join(',') === 'libvpx-vp9' &&
    /\.webm$/.test(formatInfo.webmPath) &&
    /WebM/.test(formatInfo.webmSummary) &&
    /VP9/.test(formatInfo.webmSummary) &&
    formatInfo.aviCodecs.join(',') === 'mpeg4' &&
    /\.avi$/.test(formatInfo.aviPath);
  const nsfwOk =
    nsfwInfo.modalOpen === true &&
    nsfwInfo.hasModelInfo === true &&
    nsfwInfo.estimate.includes('frames to analyze') &&
    nsfwInfo.before === 0 &&
    nsfwInfo.added === 2 &&
    nsfwInfo.deletes.length === 2 &&
    nsfwInfo.deletes[0][0] === 1000 &&
    nsfwInfo.deletes[0][1] === 3000 &&
    nsfwInfo.deletes[1][0] === 4000 &&
    nsfwInfo.deletes[1][1] === 6000 &&
    nsfwInfo.deleteBlocks === 2;
  const xssOk =
    !xss.pwned &&
    xss.injectedMarkup === 0 &&
    xss.descLen <= 200 &&
    xss.subtitleEvents === 2 &&
    xss.srtEvents === 2 &&
    xss.bodyHasArrow === true &&
    xss.statusHasImgTag === false &&
    xss.confirmVisible === true &&
    xss.confirmInjected === 0 &&
    xss.confirmEscaped === true &&
    /onerror/i.test(xss.confirmText);
  const multiSubOk =
    subEventsEmpty.hidden === true &&
    subEventsEmpty.aria === 'false' &&
    multiSub.before === 1 &&
    multiSub.tracks === 2 &&
    multiSub.rows === 2 &&
    multiSub.remappedBefore === 2 &&
    multiSub.remappedAfter === 1 &&
    multiSub.burnOpts === 2 &&
    multiSub.setupTracks === 2 &&
    multiSub.evOpenByDefault === true &&
    multiSub.evCollapsed === true &&
    multiSub.evReopened === true;
  const jobTabsOk =
    jobUi.exportVisible &&
    jobUi.importHidden &&
    jobUi.importVisible &&
    jobUi.exportHidden &&
    jobUi.importActive &&
    jobUi.backToExport;
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
    jobInfo.prefix === 'CUCI-1z.' &&
    jobInfo.name === 'source.mp4' &&
    jobInfo.description === 'Remove intro and sponsor break' &&
    jobInfo.appliedDesc === 'Remove intro and sponsor break' &&
    jobInfo.embeddedSubs === true &&
    jobInfo.deletes.length === 1 &&
    jobInfo.deletes[0][0] === 1000 &&
    jobInfo.deletes[0][1] === 2000 &&
    jobInfo.offset === -250 &&
    jobInfo.matched === 1 &&
    jobInfo.missing === 0 &&
    jobInfo.badThrew === true;
  const has = (s) => ctxMenuInfo.labels.some((l) => l.startsWith(s));
  const ctxMenuOk =
    ctxMenuInfo.visible &&
    has('Set In here') &&
    has('Set Out here') &&
    has('Delete In') &&
    has('Clear marks') &&
    has('Clear deletions') &&
    ctxMenuInfo.inPoint === 2000 &&
    ctxMenuInfo.hiddenAfterClick &&
    ctxMenuInfo.deleteDisabled === false &&
    ctxMenuInfo.deletes.length === 1 &&
    ctxMenuInfo.deletes[0][0] === 2000 &&
    ctxMenuInfo.deletes[0][1] === 5000;

  const errors = messages.filter((m) => m.startsWith('[3]') || m.startsWith('[2]'));
  if (errors.length) {
    console.log('── renderer warnings/errors ──');
    errors.forEach((m) => console.log('  ' + m));
  }

  console.log('product tour   :', tourOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('rating prompt  :', rateOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('\nsubtitle remap :', remapOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('seek / step    :', seekOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('result seek    :', resultSeekOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('splitter       :', splitOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('panel layout   :', layoutOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('panel windows  :', panelsOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('clear / marks  :', marksOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('context menu   :', ctxMenuOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('delete job codec  :', jobOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('job tabs       :', jobTabsOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('share buttons  :', shareOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('job xss guard  :', xssOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('multi subtitle :', multiSubOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('status bar     :', statusOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('nsfw detect    :', nsfwOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('thumbs default :', thumbSettingOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('dbl-click mark :', dblOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('export guard   :', guardOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('export formats :', formatOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('appearance     :', appearanceOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('app menu       :', menuOk ? 'PASS ✅' : 'FAIL ❌');
  console.log('export pipeline:', exportOk ? 'PASS ✅' : 'FAIL ❌');
  const allOk =
    tourOk && rateOk && remapOk && seekOk && resultSeekOk && splitOk && layoutOk && panelsOk && marksOk && ctxMenuOk && jobOk && jobTabsOk && shareOk && xssOk && multiSubOk && nsfwOk && statusOk && thumbSettingOk && dblOk && guardOk && formatOk && appearanceOk && menuOk && exportOk;
  console.log('\nE2E:', allOk ? 'PASS ✅' : 'FAIL ❌');
  app.exit(allOk ? 0 : 1);
});
