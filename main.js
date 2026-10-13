'use strict';

const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const { registerIpc, killCurrentJob } = require('./lib/ipc');
const { MEDIA_PRIVILEGES, registerMediaProtocol } = require('./lib/media-protocol');

const isDev = process.argv.includes('--dev');

// Register the seekable media:// scheme before the app is ready.
protocol.registerSchemesAsPrivileged(MEDIA_PRIVILEGES);

// On Windows, taskbar grouping / notifications key off the AppUserModelID.
// Packaged (MSIX / Store) builds get it from the package identity, so only set
// it for unpackaged builds or it would mismatch the Store identity.
if (process.platform === 'win32' && !process.windowsStore) {
  app.setAppUserModelId('com.cuci2.app');
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0b0d12',
    title: 'CUCI2 — Video Cut & Merge',
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

app.whenReady().then(() => {
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
