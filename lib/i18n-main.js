'use strict';

/**
 * Load the renderer's translation dictionaries in the main process so the
 * native application menu speaks the same language as the UI.
 *
 * The dictionaries are classic browser scripts attached to `window.CUCI`, so we
 * evaluate them in a VM with a minimal DOM/localStorage stub and then call
 * `apply(lang)` (which only touches those stubs).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = ['src/i18n.js', 'src/guide-i18n.js', 'src/messages-i18n.js', 'src/menu-i18n.js'];
const root = path.join(__dirname, '..');

function load() {
  const store = new Map();
  const noop = () => {};
  const win = {
    navigator: { language: 'en', languages: ['en'] },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    CustomEvent: class {
      constructor(type, opts) {
        this.type = type;
        this.detail = opts && opts.detail;
      }
    },
  };
  const document = {
    readyState: 'loading',
    documentElement: {},
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop } }),
  };
  const ctx = vm.createContext({
    window: win,
    document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    CustomEvent: win.CustomEvent,
    console,
  });
  for (const file of FILES) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: file });
  }
  return win.CUCI && win.CUCI.i18n ? win.CUCI.i18n : null;
}

const i18n = load();
let current = 'en';

/** `t('key')` in the language the UI currently uses. */
function t(key) {
  return i18n ? i18n.t(key) : key;
}

function setLanguage(lang) {
  if (!i18n) return 'en';
  current = i18n.apply(lang && lang !== 'auto' ? lang : i18n.resolve('auto'));
  return current;
}

const languages = () => (i18n ? i18n.LANGS : [['en', 'English']]);

module.exports = { t, setLanguage, languages, current: () => current };
