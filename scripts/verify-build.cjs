#!/usr/bin/env node
/**
 * Smoke-test the packaged app directory produced by scripts/obfuscate.mjs.
 *
 *   node scripts/verify-build.mjs [--app-dir .build/app]
 *
 * Boots the *staged* renderer + main-process modules in an isolated Electron
 * profile and checks that the obfuscated scripts still work: CUCI helpers, the
 * preload API, the debug handle, i18n, theme, media probing and a delete.
 * Exits non-zero so build.ps1 can stop before packaging a broken build.
 */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const root = path.resolve(__dirname, '..');
const appDir = path.resolve(root, opt('--app-dir', '.build/app'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(appDir, 'src', 'index.html'))) {
  console.error(`verify-build: ${appDir} does not look like a staged app (run scripts/obfuscate.mjs).`);
  process.exit(1);
}

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cuci-verify-')));

const { registerIpc } = require(path.join(appDir, 'lib', 'ipc.js'));
const { MEDIA_PRIVILEGES, registerMediaProtocol } = require(path.join(appDir, 'lib', 'media-protocol.js'));
protocol.registerSchemesAsPrivileged(MEDIA_PRIVILEGES);

let win = null;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

/** Generate a 2 s test clip so media paths are exercised without Sample/. */
function makeSample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuci-verify-media-'));
  const file = path.join(dir, 'clip.mp4');
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { windowsHide: true },
  );
  if (r.error || r.status !== 0 || !fs.existsSync(file)) return null;
  const srt = path.join(dir, 'clip.srt');
  fs.writeFileSync(srt, '1\n00:00:00,200 --> 00:00:00,900\nHello\n');
  return { file, srt };
}

app.whenReady().then(async () => {
  try {
    registerIpc({ getWindow: () => win });
    registerMediaProtocol();

    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 820,
      webPreferences: {
        preload: path.join(appDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    const errors = [];
    win.webContents.on('console-message', (...args) => {
      const d = args[1];
      const level = d && typeof d === 'object' ? d.level : args[1];
      const msg = d && typeof d === 'object' ? d.message : args[2];
      if (level === 'error' || level === 3) errors.push(String(msg));
    });
    await win.loadFile(path.join(appDir, 'src', 'index.html'));
    await sleep(2200);

    const boot = await win.webContents.executeJavaScript(`(() => ({
      cu: typeof window.CUCI === 'object' && typeof window.CUCI.uid === 'function',
      api: typeof window.api === 'object' && typeof window.api.probe === 'function',
      app: !!window.__cuciApp,
      exportLabel: (document.getElementById('btnExport') || {}).textContent,
      i18n: typeof window.CUCI.i18n === 'object',
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      scripts: [...document.scripts].map((s) => s.getAttribute('src')),
    }))()`);

    console.log('\nverify-build:', path.relative(root, appDir));
    check('renderer boots (CUCI global)', boot.cu);
    check('preload API exposed', boot.api);
    check('app debug handle', boot.app);
    check('i18n module usable', boot.i18n);
    check('theme applied', boot.theme === 'dark' || boot.theme === 'light', boot.theme);
    check('scripts present', (boot.scripts || []).length >= 5, (boot.scripts || []).join(','));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    // Obfuscated files must not still contain readable markers from the source.
    const appJs = fs.readFileSync(path.join(appDir, 'src', 'app.js'), 'utf8');
    const leaked = ['function renderTimeline', 'function buildFilterGraph', 'CUCI renderer'].filter((m) => appJs.includes(m));
    check('renderer obfuscated', leaked.length === 0, leaked.join(','));

    const i18nProbe = await win.webContents.executeJavaScript(`(() => {
      const out = {};
      window.CUCI.i18n.apply('ms');
      out.malay = document.getElementById('btnExport').textContent;
      window.CUCI.i18n.apply('ar');
      out.rtl = document.documentElement.dir === 'rtl';
      window.CUCI.i18n.apply('en');
      out.english = document.getElementById('btnExport').textContent;
      return out;
    })()`);
    check('i18n switching works (obfuscated)', i18nProbe.malay === 'Eksport' && i18nProbe.rtl && i18nProbe.english === 'Export', JSON.stringify(i18nProbe));

    const sample = makeSample();
    if (!sample) {
      console.log('  SKIP  media probe (ffmpeg not on PATH)');
    } else {
      const media = await win.webContents.executeJavaScript(
        `(async () => {
          const a = window.__cuciApp;
          const out = {};
          await a.addVideos([${JSON.stringify(sample.file)}]);
          const clip = a.state.clips[0];
          out.clips = a.state.clips.length;
          out.duration = Math.round(clip ? clip.durationMs : 0);
          out.runtime = document.querySelectorAll('#clipList .clip').length;
          if (clip) {
            const okSub = await a.loadSubtitleFromPath(clip, ${JSON.stringify(sample.srt)});
            out.subs = okSub ? clip.subtitles.length : 0;
            a.addDelete(0, 500);
            out.kept = Math.round(a.programRanges().total);
            out.deleteRows = document.querySelectorAll('#deleteList .delete-item').length;
          }
          return out;
        })()`,
      );
      await sleep(300);
      check('media probe + clip list', media.clips === 1 && media.duration > 1500 && media.runtime === 1, JSON.stringify(media));
      check('subtitle + delete pipeline', media.subs >= 1 && media.kept > 0 && media.deleteRows >= 1, JSON.stringify(media));
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\nVERIFY: ${failed.length ? 'FAIL ❌' : 'PASS ✅'} (${results.length - failed.length}/${results.length})`);
    app.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.error('\nVERIFY: FAIL ❌', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
