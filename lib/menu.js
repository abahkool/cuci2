'use strict';

/**
 * Native application menu for CUCI.
 *
 * Replaces Electron's default menu (File/Edit/View/Window/Help with Reload and
 * DevTools) with a product menu: File, Edit, View (panels, appearance,
 * language), Help. Items send `menu:command` actions to the renderer, which
 * executes them through the same functions the buttons use; the renderer sends
 * `menu:state` back so checkboxes/radios stay in sync.
 *
 * The menu is translated with the same dictionaries as the UI
 * (lib/i18n-main.js) and rebuilt when the language or state changes.
 *
 * Accelerators are only set for actions that are safe while typing in a text
 * field (Ctrl+O/S/E, F1, F11). Undo/redo, delete and mark actions keep their
 * context-aware in-app shortcuts instead.
 */

const { app, Menu, dialog, shell } = require('electron');
const i18n = require('./i18n-main');

let getWindow = () => null;
const state = {
  snap: true,
  mode: 'source',
  pinned: { sidebar: true, transport: true },
  detached: { sidebar: false, transport: false },
  theme: 'system',
  language: 'auto',
};
let buildTimer = null;

const t = (key) => i18n.t(key);

function mainWindow() {
  const win = getWindow();
  return win && !win.isDestroyed() ? win : null;
}

function send(action) {
  const win = mainWindow();
  if (win) win.webContents.send('menu:command', action);
}

const item = (label, action, extra = {}) => ({ label, click: () => send(action), ...extra });

function about() {
  const win = mainWindow();
  const detail = [
    `Version ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    'MIT License',
    '',
    t('tagline'),
  ].join('\n');
  const opts = {
    type: 'info',
    title: 'CUCI',
    message: `CUCI — ${t('tagline')}`,
    detail,
    buttons: [t('close')],
    noLink: true,
  };
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

function template() {
  const langNow = i18n.current();
  const themeRadios = [
    ['system', 'themeSystem'],
    ['dark', 'themeDark'],
    ['light', 'themeLight'],
  ].map(([value, key]) => ({
    label: t(key),
    type: 'radio',
    checked: state.theme === value,
    click: () => send(`theme:${value}`),
  }));

  const languageRadios = [
    { label: t('languageAuto'), type: 'radio', checked: state.language === 'auto', click: () => send('lang:auto') },
    { type: 'separator' },
    ...i18n.languages().map(([code, name]) => ({
      label: name,
      type: 'radio',
      checked: state.language !== 'auto' && langNow === code,
      click: () => send(`lang:${code}`),
    })),
  ];

  return [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: t('menuFile'),
      submenu: [
        item(`${t('addVideo')}…`, 'add-video', { accelerator: 'CmdOrCtrl+O' }),
        item(`${t('addSubtitle')}…`, 'add-subtitle', { accelerator: 'CmdOrCtrl+Shift+A' }),
        { type: 'separator' },
        item(`${t('export')}…`, 'export', { accelerator: 'CmdOrCtrl+E' }),
        { type: 'separator' },
        item(`${t('saveJobFile')}`, 'save-job', { accelerator: 'CmdOrCtrl+S' }),
        item(`${t('openJobFile')}`, 'open-job', { accelerator: 'CmdOrCtrl+Shift+O' }),
        { type: 'separator' },
        item(`${t('settings')}…`, 'settings', { accelerator: 'CmdOrCtrl+,' }),
        { type: 'separator' },
        { label: t('menuExit'), accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4', click: () => app.quit() },
      ],
    },
    {
      label: t('menuEdit'),
      submenu: [
        item(t('kUndo'), 'undo'),
        item(t('kRedo'), 'redo'),
        { type: 'separator' },
        item(t('menuSetIn'), 'set-in'),
        item(t('menuSetOut'), 'set-out'),
        item(t('menuDeleteSel'), 'delete'),
        item(t('menuClearMarks'), 'clear-marks'),
        item(t('menuClearDeletes'), 'clear-deletes'),
      ],
    },
    {
      label: t('menuView'),
      submenu: [
        { label: t('source'), type: 'radio', checked: state.mode === 'source', click: () => send('mode-source') },
        { label: t('preview'), type: 'radio', checked: state.mode === 'result', click: () => send('mode-result') },
        { type: 'separator' },
        { label: t('snap'), type: 'checkbox', checked: !!state.snap, click: () => send('toggle-snap') },
        item(t('menuZoomIn'), 'zoom-in', { accelerator: 'CmdOrCtrl+=' }),
        item(t('menuZoomOut'), 'zoom-out', { accelerator: 'CmdOrCtrl+-' }),
        { type: 'separator' },
        {
          label: t('menuPanels'),
          submenu: [
            {
              label: t('menuPin'),
              submenu: [
                { label: t('sidePanel'), type: 'checkbox', checked: !!state.pinned.sidebar, click: () => send('pin-sidebar') },
                { label: t('controlCenter'), type: 'checkbox', checked: !!state.pinned.transport, click: () => send('pin-transport') },
              ],
            },
            {
              label: t('menuDetach'),
              submenu: [
                { label: t('sidePanel'), type: 'checkbox', checked: !!state.detached.sidebar, click: () => send('detach-sidebar') },
                { label: t('controlCenter'), type: 'checkbox', checked: !!state.detached.transport, click: () => send('detach-transport') },
              ],
            },
          ],
        },
        {
          label: t('setAppearance'),
          submenu: [{ label: t('theme'), submenu: themeRadios }, { label: t('language'), submenu: languageRadios }],
        },
        { type: 'separator' },
        { label: t('menuFullScreen'), role: 'togglefullscreen', accelerator: 'F11' },
      ],
    },
    {
      label: t('menuHelp'),
      role: 'help',
      submenu: [
        item(t('guideTitle'), 'guide', { accelerator: 'F1' }),
        item(t('guideShortcuts'), 'guide-shortcuts'),
        { type: 'separator' },
        {
          label: 'GitHub',
          click: () => shell.openExternal('https://github.com/abahkool/cuci2'),
        },
        { label: t('menuAbout'), click: () => about() },
      ],
    },
  ];
}

/** Rebuild the application menu from the current language + UI state. */
function build() {
  const menu = Menu.buildFromTemplate(template());
  Menu.setApplicationMenu(menu);
  return menu;
}

/** Called by the renderer whenever a menu-relevant state changes. */
function setState(next) {
  if (!next || typeof next !== 'object') return;
  if (typeof next.snap === 'boolean') state.snap = next.snap;
  if (next.mode === 'source' || next.mode === 'result') state.mode = next.mode;
  if (next.pinned && typeof next.pinned === 'object') {
    state.pinned.sidebar = !!next.pinned.sidebar;
    state.pinned.transport = !!next.pinned.transport;
  }
  if (next.detached && typeof next.detached === 'object') {
    state.detached.sidebar = !!next.detached.sidebar;
    state.detached.transport = !!next.detached.transport;
  }
  if (['system', 'dark', 'light'].includes(next.theme)) state.theme = next.theme;
  if (typeof next.language === 'string' && next.language) state.language = next.language;
  if (typeof next.resolvedLanguage === 'string' && next.resolvedLanguage) i18n.setLanguage(next.resolvedLanguage);
  schedule();
}

function schedule() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(() => {
    buildTimer = null;
    build();
  }, 30);
}

function init(opts = {}) {
  if (opts.getWindow) getWindow = opts.getWindow;
  // Match the language the settings already store.
  const stored = opts.language;
  i18n.setLanguage(stored && stored !== 'auto' ? stored : 'auto');
  if (stored) state.language = stored;
  build();
}

module.exports = { init, build, setState, template, state };
