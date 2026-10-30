'use strict';

/**
 * Headless smoke test: boots the real renderer (HTML/CSS/JS + preload) in a
 * hidden Electron window, captures console errors and probes the DOM.
 *
 *   npx electron lib/smoke.js
 */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const { registerIpc } = require('./ipc');
const { MEDIA_PRIVILEGES, registerMediaProtocol } = require('./media-protocol');

protocol.registerSchemesAsPrivileged(MEDIA_PRIVILEGES);

const messages = [];
const errors = [];

function recordConsole(args) {
  const d = args[1];
  if (d && typeof d === 'object' && 'message' in d) messages.push({ level: d.level, msg: `${d.message} (${d.sourceId}:${d.lineNumber})` });
  else messages.push({ level: args[1], msg: `${args[2]} (${args[4]}:${args[3]})` });
}

let win = null;
app.whenReady().then(async () => {
  registerIpc({ getWindow: () => win });
  registerMediaProtocol();

  win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (...args) => recordConsole(args));
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone ' + JSON.stringify(d)));
  win.webContents.on('preload-error', (_e, p, err) => errors.push('preload-error ' + p + ': ' + err.message));
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 2600));

  let probe;
  try {
    probe = await win.webContents.executeJavaScript(`(() => {
      const ids = ['ffStatus','clipCount','deleteCount','timeline','tlRuler','timelineScroll','sidebar','btnPinSidebar','btnPinTransport','btnDetachSidebar','btnDetachTransport','btnRevealSidebar','btnRevealTransport','revealBar'];
      const out = {};
      for (const id of ids) { const el = document.getElementById(id); out[id] = el ? (el.textContent || el.style.width || 'present') : 'MISSING'; }
      out.hasCUCI = typeof window.CUCI === 'object' && typeof window.CUCI.parseSubtitles === 'function';
      out.hasApi = typeof window.api === 'object' && typeof window.api.probe === 'function';
      out.emptyVisible = !document.getElementById('emptyState').classList.contains('hidden');
      return out;
    })()`);
  } catch (err) {
    probe = 'executeJavaScript failed: ' + err.message;
  }
  console.log('── DOM PROBE ─────────────────────────────');
  console.log(JSON.stringify(probe, null, 2));

  // workspace layout: pin = visible, unpin = auto-hide + temporary peek
  let layoutProbe;
  try {
    layoutProbe = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const byId = (id) => document.getElementById(id);
      const box = (id) => byId(id).getBoundingClientRect();
      const pressed = (id) => byId(id).getAttribute('aria-pressed') === 'true';
      const hover = () => byId('playerWrap').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      const out = {};
      out.defaultPinned = pressed('btnPinSidebar') && pressed('btnPinTransport');

      const before = Math.round(byId('playerWrap').getBoundingClientRect().width);
      byId('btnPinSidebar').click();
      await wait(120);
      out.sidebarHidden = Math.round(box('sidebar').width) === 0;
      out.playerGrew = Math.round(byId('playerWrap').getBoundingClientRect().width) > before + 100;
      out.revealOffered = !byId('btnRevealSidebar').classList.contains('hidden');
      hover();
      await wait(40);
      out.handlesVisible = byId('revealBar').classList.contains('visible');

      // the chevron opens a temporary peek, it does not pin
      byId('btnRevealSidebar').click();
      await wait(220);
      out.peekShown = Math.round(box('sidebar').width) > 100;
      // an overlay drawer, not a pinned pane
      out.peekNotPinned = !pressed('btnPinSidebar') && getComputedStyle(byId('sidebar')).position === 'fixed';
      // leaving the peek closes it again
      hover();
      await wait(520);
      out.peekClosed = Math.round(box('sidebar').width) === 0;

      // pinning from inside the peek keeps it
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
      byId('btnRevealTransport').click();
      await wait(260);
      out.controlsPeek = Math.round(box('transportBar').height) > 20 && Math.round(box('timelineWrap').height) > 20;
      out.controlsPeekNotPinned = !pressed('btnPinTransport');
      hover();
      await wait(560);
      out.controlsPeekClosed = Math.round(box('transportBar').height) === 0 && Math.round(box('timelineWrap').height) === 0;
      byId('btnRevealTransport').click();
      await wait(260);
      byId('btnPinTransport').click();
      await wait(160);
      out.controlsPinnedBack = pressed('btnPinTransport') && Math.round(box('transportBar').height) > 20 && Math.round(box('timelineWrap').height) > 20;

      localStorage.removeItem('cuci.layout');
      return out;
    })()`);
  } catch (err) {
    layoutProbe = { error: err.message };
  }
  console.log('── LAYOUT PROBE ──────────────────────────');
  console.log(JSON.stringify(layoutProbe, null, 2));

  // 2. detached panel windows: main renderer <-> panel window round trip
  let panelProbe;
  try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const panelWinFor = (name) =>
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('panel=' + name));

    const before = BrowserWindow.getAllWindows().length;
    await win.webContents.executeJavaScript(`document.getElementById('btnDetachSidebar').click()`);
    for (let i = 0; i < 40 && !panelWinFor('sidebar'); i++) await wait(100);
    const panelWin = panelWinFor('sidebar');
    const opened = !!panelWin && BrowserWindow.getAllWindows().length === before + 1;

    let panelDom = null;
    if (opened) {
      for (let i = 0; i < 40; i++) {
        panelDom = await panelWin.webContents.executeJavaScript(`(() => ({
          host: document.body.dataset.panel || '',
          visible: !document.getElementById('panelSidebar').hidden && document.getElementById('panelTransport').hidden,
          hasClipList: !!document.getElementById('clipList'),
          title: document.title,
        }))()`);
        if (panelDom.host === 'sidebar') break;
        await wait(100);
      }
    }
    const mainHidden = await win.webContents.executeJavaScript(
      `Math.round(document.getElementById('sidebar').getBoundingClientRect().width) === 0`,
    );

    if (panelWin) panelWin.close();
    for (let i = 0; i < 40 && panelWinFor('sidebar'); i++) await wait(100);
    await wait(300);
    const redocked = await win.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('sidebar').getBoundingClientRect();
      return r.width > 100 && r.height > 100 && !document.getElementById('btnDetachSidebar').getAttribute('aria-pressed').includes('true');
    })()`);
    const closed = !panelWinFor('sidebar') && BrowserWindow.getAllWindows().length === before;
    await win.webContents.executeJavaScript(`localStorage.removeItem('cuci.layout')`);
    panelProbe = { opened, panelDom, mainHidden, closed, redocked };
  } catch (err) {
    panelProbe = { error: err.message };
  }
  console.log('── PANEL WINDOW PROBE ────────────────────');
  console.log(JSON.stringify(panelProbe, null, 2));
  console.log('── CONSOLE ───────────────────────────────');
  if (!messages.length) console.log('  (none)');
  messages.forEach((m) => console.log(`  [${m.level}] ${m.msg}`));
  console.log('── ERRORS ────────────────────────────────');
  if (!errors.length) console.log('  (none)');
  errors.forEach((m) => console.log('  ' + m));

  const level3 = messages.filter((m) => m.level === 3 || m.level === 'error');
  const ok =
    !errors.length &&
    !level3.length &&
    probe &&
    probe.hasCUCI &&
    probe.hasApi &&
    probe.ffStatus !== 'MISSING' &&
    layoutProbe &&
    layoutProbe.defaultPinned &&
    layoutProbe.sidebarHidden &&
    layoutProbe.playerGrew &&
    layoutProbe.revealOffered &&
    layoutProbe.handlesVisible &&
    layoutProbe.peekShown &&
    layoutProbe.peekNotPinned &&
    layoutProbe.peekClosed &&
    layoutProbe.pinnedBack &&
    layoutProbe.controlsHidden &&
    layoutProbe.timelineFollowsHide &&
    layoutProbe.controlsPeek &&
    layoutProbe.controlsPeekNotPinned &&
    layoutProbe.controlsPeekClosed &&
    layoutProbe.controlsPinnedBack &&
    panelProbe &&
    panelProbe.opened &&
    panelProbe.panelDom &&
    panelProbe.panelDom.host === 'sidebar' &&
    panelProbe.panelDom.visible &&
    panelProbe.mainHidden &&
    panelProbe.closed &&
    panelProbe.redocked;
  console.log('\nSMOKE:', ok ? 'PASS ✅' : 'FAIL ❌');
  app.exit(ok ? 0 : 1);
});
