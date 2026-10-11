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
      const ids = ['ffStatus','clipCount','cutCount','timeline','tlRuler','timelineScroll'];
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
    probe.ffStatus !== 'MISSING';
  console.log('\nSMOKE:', ok ? 'PASS ✅' : 'FAIL ❌');
  app.exit(ok ? 0 : 1);
});
