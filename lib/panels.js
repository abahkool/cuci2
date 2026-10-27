'use strict';

/**
 * Detachable panels — real OS windows.
 *
 * The side panel and the control center can be popped out into their own
 * BrowserWindows so the user can drag them onto another monitor. Each panel is
 * a thin view over the main renderer:
 *
 *   main renderer --panel:state--> main process --panel:state--> panel window
 *   panel window --panel:cmd--> main process --panel:cmd--> main renderer
 *
 * The main renderer stays the single source of truth (state, ffmpeg, export);
 * panel windows only render a snapshot and forward user intents. Bounds are
 * remembered in settings.json so windows reopen where they were left.
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');

const PANEL_LABELS = { sidebar: 'Side panel', transport: 'Control center' };

let registered = false;
let getMainWindow = () => null;
let getBounds = () => null;
let saveBounds = () => {};
let preloadPath = '';
let panelFile = '';
let mainHook = null;

/** @type {Map<string, BrowserWindow>} */
const windows = new Map();

function isPanelName(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(PANEL_LABELS, name);
}

function nameForSender(sender) {
  if (!sender) return null;
  for (const [name, win] of windows) {
    if (!win.isDestroyed() && win.webContents.id === sender.id) return name;
  }
  return null;
}

function mainContents() {
  const win = getMainWindow();
  return win && !win.isDestroyed() ? win.webContents : null;
}

function sanitizeBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const { x, y, width, height } = b;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (width < 240 || height < 140) return null;
  const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  // Refuse bounds that no longer touch a display (monitor unplugged).
  try {
    const area = screen.getAllDisplays().some((d) => {
      const w = d.workArea;
      return (
        rect.x < w.x + w.width && rect.x + rect.width > w.x && rect.y < w.y + w.height && rect.y + rect.height > w.y
      );
    });
    if (!area) return null;
  } catch {
    /* screen not ready — accept as-is */
  }
  return rect;
}

function defaultBounds(name) {
  const main = getMainWindow();
  const b = main && !main.isDestroyed() ? main.getBounds() : { x: 80, y: 80, width: 1400, height: 900 };
  if (name === 'sidebar') {
    return { width: 380, height: Math.max(360, Math.min(780, b.height - 80)), x: b.x + b.width - 420, y: b.y + 70 };
  }
  // The control center window contains the timeline as well (they share a pane).
  const width = Math.max(720, Math.min(1080, b.width - 60));
  const height = Math.min(620, Math.max(420, b.height - 160));
  return { width, height, x: Math.round(b.x + (b.width - width) / 2), y: Math.max(b.y + 40, b.y + b.height - height - 60) };
}

function notifyMain(channel, payload) {
  const wc = mainContents();
  if (wc) wc.send(channel, payload);
}

const THEME_BG = { light: '#f4f6fa', dark: '#0b0d12' };

function normalizeTheme(theme) {
  return theme === 'light' ? 'light' : 'dark';
}

function openPanel(name, opts) {
  if (!isPanelName(name)) return { ok: false, error: 'Unknown panel' };
  const theme = normalizeTheme(opts && opts.theme);
  const existing = windows.get(name);
  if (existing && !existing.isDestroyed()) {
    // Reused window: the next state snapshot carries the resolved theme, the
    // window background is refreshed here so a light main theme never flashes dark.
    try {
      existing.setBackgroundColor(THEME_BG[theme]);
    } catch {
      /* ignore */
    }
    existing.focus();
    return { ok: true, reused: true };
  }
  if (!preloadPath || !panelFile) return { ok: false, error: 'Panel support is not initialised' };

  const main = getMainWindow();
  const bounds = sanitizeBounds(getBounds(name)) || defaultBounds(name);
  // The control center window also hosts the timeline: keep it tall enough even
  // if an older profile remembered a slimmer window.
  if (name === 'transport' && bounds.height < 420) bounds.height = 420;
  let win;
  try {
    win = new BrowserWindow({
      ...bounds,
      title: `CUCI — ${PANEL_LABELS[name]}`,
      backgroundColor: THEME_BG[theme],
      show: false,
      minWidth: 280,
      minHeight: 320,
      autoHideMenuBar: true,
      fullscreenable: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Could not open the panel window' };
  }
  windows.set(name, win);
  if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);

  const remember = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
    saveBounds(name, win.getBounds());
  };
  let saveTimer = null;
  const scheduleRemember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(remember, 500);
  };
  win.on('move', scheduleRemember);
  win.on('resize', scheduleRemember);
  win.on('close', remember);

  win.once('ready-to-show', () => {
    // Appear over the main window but do not steal keyboard focus from it.
    if (win.isDestroyed()) return;
    if (!main || main.isDestroyed() || main.isVisible()) win.showInactive();
  });
  win.on('closed', () => {
    clearTimeout(saveTimer);
    windows.delete(name);
    notifyMain('panel:closed', { panel: name });
  });

  win.webContents.on('preload-error', (_e, p, err) => console.error('[panel] preload error', p, err && err.message));
  win.loadFile(panelFile, { query: { panel: name, theme } });
  return { ok: true };
}

function closePanel(name) {
  if (!isPanelName(name)) return { ok: false, error: 'Unknown panel' };
  const win = windows.get(name);
  if (!win || win.isDestroyed()) return { ok: true, alreadyClosed: true };
  win.close();
  return { ok: true };
}

function closeAllPanels() {
  for (const [, win] of windows) {
    if (!win.isDestroyed()) win.close();
  }
  windows.clear();
}

function isOpen(name) {
  const win = windows.get(name);
  return !!win && !win.isDestroyed();
}

/**
 * @param {object} opts
 * @param {() => import('electron').BrowserWindow | null} opts.getMainWindow
 * @param {(name: string) => object | null} opts.getBounds
 * @param {(name: string, bounds: object) => void} opts.saveBounds
 */
function init(opts = {}) {
  if (registered) return;
  registered = true;
  if (opts.getMainWindow) getMainWindow = opts.getMainWindow;
  if (opts.getBounds) getBounds = opts.getBounds;
  if (opts.saveBounds) saveBounds = opts.saveBounds;
  preloadPath = opts.preloadPath || path.join(__dirname, '..', 'panel-preload.js');
  panelFile = opts.panelFile || path.join(__dirname, '..', 'src', 'panel.html');

  // Panels are separate top-level windows: closing the main window must not
  // leave them behind (and must not keep the app alive).
  const hookMain = () => {
    const main = getMainWindow();
    if (!main || main === mainHook) return;
    mainHook = main;
    main.once('closed', closeAllPanels);
  };
  hookMain();

  ipcMain.handle('panel:open', (e, opts2) => {
    hookMain();
    const main = mainContents();
    if (main && e.sender.id !== main.id) return { ok: false, error: 'Only the main window can open panels' };
    return openPanel(opts2 && opts2.name, opts2);
  });
  ipcMain.handle('panel:close', (_e, name) => closePanel(name));
  ipcMain.handle('panel:info', (e) => ({ name: nameForSender(e.sender), labels: PANEL_LABELS }));

  // A fresh panel asks for the current state.
  ipcMain.on('panel:ready', (e) => {
    const name = nameForSender(e.sender);
    if (name) notifyMain('panel:ready', { panel: name });
  });

  // The panel's own "Dock" button asks to be closed.
  ipcMain.on('panel:close-self', (e) => {
    const name = nameForSender(e.sender);
    if (name) closePanel(name);
  });

  // Main renderer -> panels (state snapshots).
  ipcMain.on('panel:state', (e, payload) => {
    const main = mainContents();
    if (main && e.sender.id !== main.id) return; // panels cannot spoof state
    if (!payload || typeof payload !== 'object' || !isPanelName(payload.panel)) return;
    const win = windows.get(payload.panel);
    if (win && !win.isDestroyed()) win.webContents.send('panel:state', payload);
  });

  // Panels -> main renderer (user intents).
  ipcMain.on('panel:cmd', (e, msg) => {
    const name = nameForSender(e.sender);
    if (!name || !msg || typeof msg !== 'object' || typeof msg.action !== 'string') return;
    const main = mainContents();
    if (!main) return;
    main.send('panel:cmd', { ...msg, panel: name });
  });
}

function destroy() {
  closeAllPanels();
  registered = false;
  mainHook = null;
}

module.exports = { init, destroy, openPanel, closePanel, closeAllPanels, isOpen, PANEL_LABELS };
