'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  openVideos: () => ipcRenderer.invoke('dialog:openVideos'),
  openSubtitles: () => ipcRenderer.invoke('dialog:openSubtitles'),
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),

  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),

  probe: (p) => ipcRenderer.invoke('media:probe', p),
  thumbs: (p, opts) => ipcRenderer.invoke('media:thumbs', p, opts),
  proxy: (p) => ipcRenderer.invoke('media:proxy', p),

  readText: (p, opts) => ipcRenderer.invoke('fs:readText', p, opts),
  writeText: (p, c) => ipcRenderer.invoke('fs:writeText', p, c),

  exportVideo: (req) => ipcRenderer.invoke('export:start', req),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),

  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),

  mediaUrl: (p) => 'media://local/' + encodeURIComponent(p),

  onExportProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },

  onThumbsProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('thumbs:progress', handler);
    return () => ipcRenderer.removeListener('thumbs:progress', handler);
  },

  nsfwStatus: () => ipcRenderer.invoke('nsfw:status'),
  nsfwScan: (req) => ipcRenderer.invoke('nsfw:scan', req),
  nsfwCancel: () => ipcRenderer.invoke('nsfw:cancel'),
  onNsfwProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('nsfw:progress', handler);
    return () => ipcRenderer.removeListener('nsfw:progress', handler);
  },

  onProxyLog: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('proxy:log', handler);
    return () => ipcRenderer.removeListener('proxy:log', handler);
  },

  /* native application menu */
  setMenuState: (ui) => ipcRenderer.send('menu:state', ui),
  onMenuCommand: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('menu:command', handler);
    return () => ipcRenderer.removeListener('menu:command', handler);
  },

  /* detachable panel windows (side panel / control center) */
  panelOpen: (opts) => ipcRenderer.invoke('panel:open', opts),
  panelClose: (name) => ipcRenderer.invoke('panel:close', name),
  sendPanelState: (payload) => ipcRenderer.send('panel:state', payload),
  onPanelReady: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('panel:ready', handler);
    return () => ipcRenderer.removeListener('panel:ready', handler);
  },
  onPanelClosed: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('panel:closed', handler);
    return () => ipcRenderer.removeListener('panel:closed', handler);
  },
  onPanelCommand: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('panel:cmd', handler);
    return () => ipcRenderer.removeListener('panel:cmd', handler);
  },
});
