// Store screenshots: boot the real renderer in an isolated profile and capture
// five views per UI language into Sample/msstore/screenshots/<locale>/.
//
//   npm run store:screenshots              # all 14 Store locales
//   npm run store:screenshots -- de-de ja-jp   # only the listed ones
//
// Needs Sample/bbb.mp4 (Big Buck Bunny, gitignored) as the demo clip and
// vendor/ffmpeg for nothing else — no network access, no real user settings.
// Output: 1920x1080 PNG at zoom 1.2 (readable when scaled down in the Store).
const { app, BrowserWindow, screen, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'Sample', 'msstore', 'screenshots');
const { MEDIA_PRIVILEGES, registerMediaProtocol } = require(path.join(ROOT, 'lib', 'media-protocol.js'));
protocol.registerSchemesAsPrivileged(MEDIA_PRIVILEGES);

// Store locale -> app UI language.
const LOCALES = [
  ['en-us', 'en'], ['ms-my', 'ms'], ['id-id', 'id'], ['zh-cn', 'zh'], ['es-es', 'es'],
  ['fr-fr', 'fr'], ['de-de', 'de'], ['pt-br', 'pt'], ['ru-ru', 'ru'], ['ja-jp', 'ja'],
  ['ko-kr', 'ko'], ['ar-sa', 'ar'], ['hi-in', 'hi'], ['tr-tr', 'tr'],
];
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = only.length ? LOCALES.filter((l) => only.includes(l[0]) || only.includes(l[1])) : LOCALES;
if (!targets.length) {
  console.error('No matching locale. Known:', LOCALES.map((l) => l[0]).join(' '));
  app.exit(2);
}

const W = 1920;
const H = 1080;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuci-shots-'));
const userData = path.join(tmp, 'userData');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  theme: 'light',
  language: 'en',
  loadThumbs: true,
  preferBundled: false,
  ffmpegPath: '',
  ffprobePath: '',
  nsfwThreshold: 0.3,
  nsfwIntervalMs: 2000,
  nsfwMinDurationMs: 5000,
  panels: {},
}, null, 2));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMedia() {
  const video = path.join(ROOT, 'Sample', 'bbb.mp4');
  if (!fs.existsSync(video)) throw new Error('missing Sample/bbb.mp4');

  // Clean, on-brand captions (no demo text, no "cut" wording) spread over the
  // 10:34 sample so the subtitle row and the overlay both look populated.
  const cues = [
    ['00:00:06,000', '00:00:12,000', 'A quiet morning in the forest.'],
    ['00:00:42,500', '00:00:48,000', 'Delete the scenes you do not need.'],
    ['00:01:15,000', '00:01:22,000', 'The subtitles follow automatically.'],
    ['00:02:10,000', '00:02:18,000', 'Zoom in for frame accuracy.'],
    ['00:03:05,000', '00:03:14,000', 'Mark as many ranges as you like.'],
    ['00:04:20,000', '00:04:30,000', 'Every clip stays on your device.'],
    ['00:05:40,000', '00:05:50,000', 'Merge several videos into one.'],
    ['00:06:55,000', '00:07:04,000', 'Export the result in eight formats.'],
    ['00:08:10,000', '00:08:20,000', 'Share the edit, not the file.'],
    ['00:09:25,000', '00:09:35,000', 'Millisecond precision, every time.'],
  ];
  const srt = path.join(tmp, 'captions.srt');
  const NL = String.fromCharCode(10);
  const body = cues.map((c, i) => (i + 1) + NL + c[0] + ' --> ' + c[1] + NL + c[2] + NL + NL).join('');
  fs.writeFileSync(srt, body, 'utf8');
  return { video, srt };
}

async function collect(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const dirs = path.join(OUT);
  fs.mkdirSync(dirs, { recursive: true });

  for (const [locale, code] of targets) {
    const dir = path.join(dirs, locale);
    fs.mkdirSync(dir, { recursive: true });

    await js(`(() => {
      const a = window.__cuciApp;
      window.CUCI.i18n.apply('${code}');
      a.state.selection = null;
      a.renderAll();
      return document.documentElement.lang + '/' + document.documentElement.dir;
    })()`);
    await sleep(500);

    const shot = async (n, name) => {
      await js(`(() => { const el = document.activeElement; if (el && el.blur) el.blur(); return true; })()`);
      await sleep(150);
      let img = null;
      for (let i = 0; i < 8 && !img; i++) {
        const cap = await win.webContents.capturePage();
        if (!cap.isEmpty()) img = cap;
        else await sleep(400);
      }
      if (!img) throw new Error('empty capture ' + locale + ' ' + name);
      const file = path.join(dir, `${n}-${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      const sz = img.getSize();
      console.log(`  ${path.relative(ROOT, file)}  ${sz.width}x${sz.height}`);
    };

    // 1 — editor
    await js(`(() => {
      const a = window.__cuciApp;
      const clip = a.state.clips[0];
      a.state.selection = clip ? { clipId: clip.id, start: 42000, end: 50000 } : null;
      if (clip) a.seekTo(5200);
      const v = document.querySelector('video');
      if (v) { try { v.currentTime = 45; } catch (e) {} }
      a.renderAll();
      window.scrollTo(0, 0);
      return true;
    })()`);
    await sleep(500);
    await js(`(() => {
      const tg = document.getElementById('btnToggleSubEvents');
      if (tg && tg.getAttribute('aria-expanded') === 'true') tg.click();
      return tg ? tg.getAttribute('aria-expanded') : 'none';
    })()`);
    await sleep(500);
    await shot('01', 'editor');

    // 2 — export
    await js(`document.getElementById('btnExport').click()`);
    await sleep(600);
    await shot('02', 'export');
    await js(`document.getElementById('expClose').click()`);
    await sleep(300);

    // 3 — parent assist
    await js(`document.getElementById('btnNsfw').click()`);
    await sleep(700);
    await shot('03', 'parent-assist');
    await js(`document.getElementById('nsfwClose').click()`);
    await sleep(300);

    // 4 — delete job / share code
    await js(`document.getElementById('btnJob').click()`);
    await sleep(500);
    await js(`(() => {
      const d = document.getElementById('jobDesc');
      if (d) { d.value = d.placeholder; d.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    })()`);
    await sleep(300);
    await shot('04', 'job');
    await js(`document.getElementById('jobClose').click()`);
    await sleep(300);

    // 5 — user guide
    await js(`document.getElementById('btnGuide').click()`);
    await sleep(600);
    await shot('05', 'guide');
    await js(`document.getElementById('guideClose').click()`);
    await sleep(300);
  }
}

app.whenReady().then(async () => {
  try {
    const { video, srt } = makeMedia();
    const disp = screen.getPrimaryDisplay();
    console.log('display:', JSON.stringify(disp.workAreaSize), 'scale', disp.scaleFactor);
    console.log('locales:', targets.map((l) => l[0]).join(' '));

    const win = new BrowserWindow({
      width: W,
      height: H,
      show: false,
      backgroundColor: '#0b0d12',
      icon: path.join(ROOT, 'build', 'icon.ico'),
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setContentSize(W, H);
    require(path.join(ROOT, 'lib', 'ipc.js')).registerIpc({ getWindow: () => win });
    registerMediaProtocol();
    await win.loadFile(path.join(ROOT, 'src', 'index.html'));
    win.show();
    win.focus();

    const js = (code) => win.webContents.executeJavaScript(code, true);

    // light theme, English start, thumbnails on; never the first-run tour or
    // the rating prompt in a Store screenshot
    await js(`(() => {
      localStorage.setItem('cuci.theme', 'light');
      localStorage.setItem('cuci.lang', 'en');
      localStorage.setItem('cuci.timelineHeight', '300');
      localStorage.setItem('cuci.tour', '1');
      localStorage.setItem('cuci.launches', '1');
      localStorage.setItem('cuci.rated', '1');
      return true;
    })()`);
    await win.webContents.reload();
    await sleep(1500);
    win.webContents.setZoomFactor(1.2);
    await sleep(600);
    await js(`(() => {
      document.getElementById('btnSettings').click();
      return document.documentElement.dataset.theme;
    })()`);
    await sleep(300);
    await js(`(() => { document.getElementById('setClose').click(); return true; })()`);
    await sleep(200);
    for (let i = 0; i < 40; i++) {
      const ready = await js(`!!window.__cuciApp`);
      if (ready) break;
      await sleep(250);
    }

    // load media + a subtitle track + a couple of deletions
    await js(`(async () => {
      const a = window.__cuciApp;
      await a.addVideos([${JSON.stringify(video)}]);
      return a.state.clips.length;
    })()`);
    await sleep(1500);
    await js(`(async () => {
      const a = window.__cuciApp;
      const clip = a.state.clips[0];
      await a.loadSubtitleFromPath(clip, ${JSON.stringify(srt)});
      a.addDelete(20000, 38000);
      a.addDelete(120000, 135000);
      a.seekTo(45000);
      a.renderAll();
      return clip.subtitles.length + '/' + clip.deletes.length;
    })()`);
    let thumbN = 0;
    for (let i = 0; i < 70; i++) {
      thumbN = await js(`document.querySelectorAll('.tl-thumb').length`);
      if (thumbN > 0) break;
      await sleep(500);
    }
    console.log('thumbs:', thumbN, 'settings:', JSON.stringify(await js(`(() => {
      const a = window.__cuciApp;
      const cb = document.getElementById('setLoadThumbs');
      return { loadThumbs: a.state.settings.loadThumbs, checkbox: cb ? cb.checked : null,
               clipThumbs: a.state.clips[0] && a.state.clips[0].thumbs ? a.state.clips[0].thumbs.files.length : -1,
               loading: !!a.state.clips[0].thumbsLoading };
    })()`)));
    await sleep(1200);

    const state = await js(`(() => {
      const a = window.__cuciApp;
      const c = a.state.clips[0];
      return {
        clips: a.state.clips.length,
        deletes: c ? c.deletes.length : 0,
        subs: c ? c.subtitles.length : 0,
        thumbs: document.querySelectorAll('.tl-thumb').length,
        theme: document.documentElement.dataset.theme,
        size: window.innerWidth + 'x' + window.innerHeight,
        dpr: window.devicePixelRatio,
      };
    })()`);
    console.log('state:', JSON.stringify(state));

    await collect(win);
    console.log('done:', targets.length, 'locales');
    app.exit(0);
  } catch (err) {
    console.error('SHOTS FAILED:', err && err.stack || err);
    app.exit(1);
  }
});
