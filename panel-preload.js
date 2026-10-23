'use strict';

/**
 * Preload for detached panel windows (src/panel.html). Intentionally tiny: a
 * panel may only receive state snapshots, report one intent at a time, and ask
 * to be closed. Everything else (ffmpeg, dialogs, export) stays in the main
 * window — see lib/panels.js for the relay.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelAPI', {
  /** Which panel this window hosts: { name: 'sidebar' | 'transport' }. */
  info: () => ipcRenderer.invoke('panel:info'),

  /** Tell the main window we are loaded and ready for a first snapshot. */
  ready: () => ipcRenderer.send('panel:ready'),

  /** Receive state snapshots pushed by the main renderer. */
  onState: (cb) => {
    const handler = (_e, data) => {
      if (typeof cb === 'function') cb(data);
    };
    ipcRenderer.on('panel:state', handler);
    return () => ipcRenderer.removeListener('panel:state', handler);
  },

  /** Forward a user intent ("click", "seek", "clip", …) to the main window. */
  send: (action, data) => {
    if (typeof action !== 'string') return;
    ipcRenderer.send('panel:cmd', { action, ...(data && typeof data === 'object' ? data : {}) });
  },

  /** Dock this panel back into the main window. */
  close: () => ipcRenderer.send('panel:close-self'),
});
