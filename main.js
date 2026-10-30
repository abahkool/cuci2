'use strict';

const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerIpc, killCurrentJob } = require('./lib/ipc');
const { MEDIA_PRIVILEGES, registerMediaProtocol } = require('./lib/media-protocol');

const isDev = process.argv.includes('--dev');

// Register the seekable media:// scheme before the app is ready.
protocol.registerSchemesAsPrivileged(MEDIA_PRIVILEGES);

// On Windows, taskbar grouping / notifications key off the AppUserModelID.
// Packaged (MSIX / Store) builds get it from the package identity, so only set
// it for unpackaged builds or it would mismatch the Store identity.
if (process.platform === 'win32' && !process.windowsStore) {
  app.setAppUserModelId('com.cuci.app');
}

let mainWindow = null;

/** Window/taskbar icon: the real .ico when present (dev runs), else Electron's. */
function appIcon() {
  const ico = path.join(__dirname, 'build', 'icon.ico');
  return fs.existsSync(ico) ? ico : undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0b0d12',
    title: 'CUCI — Delete Unnecessary Video Scenes',
    icon: appIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.webContents.on('console-message', (...args) => {
      const d = args[1];
      if (d && typeof d === 'object' && 'message' in d) console.log(`[renderer:${d.level}] ${d.message} (${d.sourceId}:${d.lineNumber})`);
      else console.log(`[renderer:${args[1]}] ${args[2]} (${args[4]}:${args[3]})`);
    });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * CUCI2 → CUCI rename: keep the existing settings/, models/ and window state by
 * moving the old userData folder before anything reads it.
 */
function migrateUserData() {
  try {
    const appData = app.getPath('appData');
    const oldDir = path.join(appData, 'CUCI2');
    const newDir = path.join(appData, 'CUCI');
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
  } catch {
    /* the app simply starts with fresh settings */
  }
}

app.whenReady().then(() => {
  migrateUserData();
  registerIpc({ getWindow: () => mainWindow });
  registerMediaProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killCurrentJob();
  if (process.platform !== 'darwin') app.quit();
});
