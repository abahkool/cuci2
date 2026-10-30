/* CUCI renderer — delete out bad scenes */
(function () {
  const api = window.api;
  const CU = window.CUCI;
  const $ = (id) => document.getElementById(id);

  /* ───────────────────────────── state ───────────────────────────── */
  const state = {
    clips: [],
    activeClipId: null,
    selection: null, // { clipId, start, end }
    inPoint: null,
    outPoint: null,
    playhead: 0, // source ms within active clip
    resultTime: 0, // output ms in merged result
    playMode: 'source',
    snap: true,
    zoom: 1,
    pxPerMs: 0,
    globalSubOffset: 0,
    settings: { loadThumbs: false },
    nsfwScanning: false,
    nsfwSegments: [],
    jobDescription: '',
    pendingJob: null,
    scrubbing: false,
    undo: [],
    redo: [],
    info: null,
    exporting: false,
  };

  let videoFile = null; // currently loaded media url in #video
  const program = { ranges: [], idx: 0, playing: false };
  const thumbJobs = new Map();
  let remapCache = null;
  let lastFocus = null;

  const t = (key) => CU.i18n.t(key);
  const tf = (key, vars) => t(key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

  /**
   * One-time move of the pre-rename (CUCI2) browser-storage keys so existing
   * installs keep their layout, splitter height and saved state.
   */
  function migrateStorage() {
    const moves = [
      ['cuci.layout', 'cuci2.layout'],
      ['cuci.timelineHeight', 'cuci2.timelineHeight'],
      ['cuci.state.v1', 'cuci2.state.v1'],
    ];
    try {
      for (const [now, oldKey] of moves) {
        const oldVal = localStorage.getItem(oldKey);
        if (oldVal != null) {
          if (localStorage.getItem(now) == null) localStorage.setItem(now, oldVal);
          localStorage.removeItem(oldKey);
        }
      }
    } catch {
      /* ignore */
    }
  }
  migrateStorage();

  /* ───────────────────────────── theme ───────────────────────────── */
  const THEME_KEY = 'cuci.theme';
  const THEME_MODES = ['system', 'dark', 'light'];
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  let themeMode = 'system';
  let appearanceApplied = false;
  // Set once the detached-panel snapshot machinery exists (applyTheme() runs
  // before that, so it must not touch the panel objects directly).
  let panelThemeSync = false;

  function resolveTheme(mode) {
    if (mode === 'dark' || mode === 'light') return mode;
    return darkMq.matches ? 'dark' : 'light';
  }

  function applyTheme(mode) {
    themeMode = THEME_MODES.includes(mode) ? mode : 'system';
    document.documentElement.dataset.theme = resolveTheme(themeMode);
    if (els.setTheme) els.setTheme.value = themeMode;
    try {
      localStorage.setItem(THEME_KEY, themeMode);
    } catch {
      /* ignore */
    }
    if (typeof sendMenuState === 'function' && layout) sendMenuState();
    // Detached panels are separate windows: push the resolved theme with the
    // next snapshot so they never fall back to the OS colour scheme.
    if (panelThemeSync) {
      pushPanelState('sidebar');
      pushPanelState('transport');
    }
  }

  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || 'system';
    } catch {
      return 'system';
    }
  }

  darkMq.addEventListener('change', () => {
    if (themeMode === 'system') applyTheme('system');
  });
  const els = {};
  let layout = null; // pane state; filled by loadLayout() during init

  // Apply the saved theme as early as possible (the select is filled later).
  applyTheme(storedTheme());

  function cacheEls() {
    [
      'video', 'subtitleOverlay', 'playerNotice', 'playerNoticeText', 'btnMakeProxy', 'btnDismissNotice',
      'btnAddVideo', 'btnAddVideo2', 'btnAddSub', 'btnExport', 'btnSettings', 'ffStatus',
      'clipList', 'clipCount', 'deleteList', 'deleteCount', 'ioReadout',
      'btnSetIn', 'btnSetOut', 'btnDelete', 'btnClearDeletes', 'btnClearMarks',
      'subInfo', 'subOffset', 'btnSubAdd', 'subTrackList', 'btnSubExport', 'subEventList',
      'btnToggleSubEvents', 'subEventCount',
      'btnSidebarAddSub', 'btnSidebarAddVideo',
      'btnPlay', 'btnStop', 'btnPrevFrame', 'btnNextFrame', 'btnPrevSec', 'btnNextSec',
      'timecode', 'timeTotal', 'resultTc', 'seekRange', 'modeSource', 'modeResult', 'chkSnap', 'zoomRange',
      'mainPane', 'transportBar', 'timelineWrap', 'playerSplitter', 'sidebar', 'playerWrap',
      'btnPinSidebar', 'btnPinTransport', 'btnDetachSidebar', 'btnDetachTransport',
      'revealBar', 'btnRevealSidebar', 'btnRevealTransport',
      'timelineScroll', 'timeline', 'tlRuler', 'tlFilm', 'tlDeletes', 'tlSubs',
      'tlSelection', 'tlMarkerIn', 'tlMarkerOut', 'tlPlayhead', 'emptyState',
      'exportModal', 'expPath', 'expBrowse', 'expContainer', 'expVcodec', 'expCrf', 'expCrfVal',
      'expPreset', 'expRes', 'expFps', 'expAbitrate', 'expBurn', 'expBurnTrack', 'expSrt', 'expSummary',
      'expProgressWrap', 'expProgressBar', 'expStatus', 'expStart', 'expCancel', 'expClose', 'expClose2',
      'settingsModal', 'setFfmpeg', 'setFfprobe', 'setFfmpegBrowse', 'setFfprobeBrowse', 'setPreferBundled', 'setUseBundled', 'setTheme', 'setLanguage',
      'setLoadThumbs', 'setDetect', 'setSaved', 'setClose', 'setClose2', 'setStatus',
      'btnJob', 'jobModal', 'jobClose', 'jobClose2', 'jobTabExport', 'jobTabImport', 'jobPanelExport', 'jobPanelImport',
      'jobSave', 'jobOpen', 'jobDesc', 'jobDescCount', 'jobIncludeSubs', 'jobCode',
      'btnGuide', 'guideModal', 'guideClose', 'guideClose2', 'guideTour',
      'tourRoot', 'tourDim', 'tourSpot', 'tourCard', 'tourTitle', 'tourBody', 'tourNext', 'tourBack', 'tourSkip',
      'rateModal', 'rateClose', 'rateGo', 'rateDone', 'rateLater', 'rateStatus',
      'confirmModal', 'confirmClose', 'confirmCancel', 'confirmOk', 'confirmRows',
      'jobCopy', 'jobRefresh', 'jobCodeInfo', 'jobPaste', 'jobImport', 'jobPasteClip', 'jobStatus',
      'statusbar', 'statusIcon', 'statusSpinner', 'statusText', 'statusInfo', 'statusClear', 'statusProgress', 'statusProgressBar', 'statusLog',
      'btnNsfw', 'nsfwModal', 'nsfwClose', 'nsfwClose2', 'nsfwInterval', 'nsfwMinDur', 'nsfwEstimate', 'nsfwThreshold',
      'nsfwThresholdVal', 'nsfwModelInfo', 'nsfwProgressWrap', 'nsfwProgressBar', 'nsfwStatus', 'nsfwResults',
      'nsfwCancel', 'nsfwApply', 'nsfwStart',
      'ctxMenu', 'toasts',
    ].forEach((id) => (els[id] = $(id)));
  }

  /* ──────── collapsible subtitle text list (collapsed until a track is chosen) ──────── */
  const SUB_EVENTS_KEY = 'cuci.subEvents';
  let subEventsOpen = false;
  // Track count seen on the previous render, per clip: the list opens when a clip
  // first shows subtitles or when a new track is added, but a manual collapse sticks.
  const subTrackCounts = Object.create(null);

  function applySubEventsState() {
    if (!els.subEventList || !els.btnToggleSubEvents) return;
    els.subEventList.classList.toggle('hidden', !subEventsOpen);
    els.btnToggleSubEvents.setAttribute('aria-expanded', String(subEventsOpen));
    els.btnToggleSubEvents.title = t(subEventsOpen ? 'collapse' : 'expand');
  }

  /** Open the subtitle text list as soon as a subtitle track is available (first
   *  load, an extra track, or switching to a clip that has one). A manual collapse
   *  sticks until another track shows up. */
  function autoOpenSubEvents() {
    const clip = activeClip();
    if (!clip) return;
    const count = Array.isArray(clip.subtitles) ? clip.subtitles.length : 0;
    if (count > (subTrackCounts[clip.id] || 0)) {
      subEventsOpen = true;
      applySubEventsState();
    }
    subTrackCounts[clip.id] = count;
  }

  function wireSubEventsToggle() {
    if (!els.btnToggleSubEvents) return;
    els.btnToggleSubEvents.addEventListener('click', () => {
      subEventsOpen = !subEventsOpen;
      try {
        localStorage.setItem(SUB_EVENTS_KEY, subEventsOpen ? '1' : '0');
      } catch {
        /* ignore */
      }
      applySubEventsState();
    });
  }

  /* ───────────────────────────── helpers ───────────────────────────── */
  const activeClip = () => state.clips.find((c) => c.id === state.activeClipId) || null;
  const even = (n) => {
    const v = Math.round(n);
    return v % 2 === 0 ? v : v + 1;
  };
  const pathJoin = (dir, file) => String(dir).replace(/[\\/]+$/, '') + '/' + file;
  const invalidate = () => {
    remapCache = null;
  };

  function totalKept(clip) {
    return keptRanges(clip).reduce((a, r) => a + (r.end - r.start), 0);
  }

  function keptRanges(clip) {
    if (!clip) return [];
    const deletes = [...clip.deletes].sort((a, b) => a.start - b.start);
    const out = [];
    let cur = 0;
    for (const c of deletes) {
      if (c.start > cur) out.push({ start: cur, end: c.start });
      cur = Math.max(cur, c.end);
    }
    if (cur < clip.durationMs) out.push({ start: cur, end: clip.durationMs });
    return out.filter((r) => r.end - r.start >= 1);
  }

  function programRanges() {
    const ranges = [];
    let offset = 0;
    for (const clip of state.clips) {
      for (const r of keptRanges(clip)) {
        ranges.push({
          clipId: clip.id,
          srcStart: r.start,
          srcEnd: r.end,
          outStart: offset,
          outEnd: offset + (r.end - r.start),
        });
        offset += r.end - r.start;
      }
    }
    return { ranges, total: offset };
  }

  /** The subtitle track currently shown in the panel / timeline / preview. */
  function activeSubtitleTrack(clip) {
    if (!clip || !Array.isArray(clip.subtitles) || !clip.subtitles.length) return null;
    return clip.subtitles.find((t) => t.id === clip.activeSubtitleId) || clip.subtitles[0];
  }

  function enabledSubtitleTracks(clip) {
    return (clip.subtitles || []).filter((t) => t.enabled !== false);
  }

  /** Total kept duration of every clip before this one in the join order. */
  function clipBaseOffset(clip) {
    let base = 0;
    for (const c of state.clips) {
      if (c.id === clip.id) break;
      base += totalKept(c);
    }
    return base;
  }

  /** Remap one track of one clip into output time. */
  function remapTrack(clip, track) {
    return CU.remapEvents(track.events, keptRanges(clip), clipBaseOffset(clip), state.globalSubOffset);
  }

  function computeRemaps() {
    if (remapCache) return remapCache;
    const tracks = [];
    const all = [];
    for (const c of state.clips) {
      for (const t of enabledSubtitleTracks(c)) {
        const events = remapTrack(c, t);
        tracks.push({ clipId: c.id, clipName: c.name, trackId: t.id, name: t.name, format: t.format, events });
        all.push(...events);
      }
    }
    remapCache = { tracks, all };
    return remapCache;
  }

  /** All enabled tracks flattened (debug handle / generic uses). */
  function remapAll() {
    return computeRemaps().all;
  }

  /** Remapped events per track, in clip order (used by export). */
  function remapAllTracks() {
    return computeRemaps().tracks;
  }

  function safeFileSuffix(name) {
    const s = CU.stripExt(name || '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    return s || 'sub';
  }

  /** Per-event source→output mapping used by the subtitle panel. */
  function buildSubRows(events, ranges, globalOffset) {
    const rangeOffsets = CU.rangeOutputOffsets(ranges);
    return events.map((ev) => {
      const parts = [];
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const s = Math.max(ev.start, r.start);
        const e = Math.min(ev.end, r.end);
        if (e - s > 0) parts.push({ start: rangeOffsets[i] + (s - r.start) + globalOffset, end: rangeOffsets[i] + (e - r.start) + globalOffset });
      }
      return { ev, parts, dropped: parts.length === 0 };
    });
  }

  function snapMs(ms) {
    const clip = activeClip();
    let v = Math.max(0, Math.min(clip ? clip.durationMs : ms, ms));
    if (state.snap && clip && clip.fps) {
      const f = clip.fps;
      v = Math.round((v * f) / 1000) * (1000 / f);
    }
    v = Math.round(v * 1000) / 1000; // strip float noise, keep sub-ms precision
    return Math.max(0, Math.min(clip ? clip.durationMs : v, v));
  }

  function frameMs() {
    const clip = activeClip();
    return clip && clip.fps ? 1000 / clip.fps : 40;
  }

  function toast(msg, kind = 'info', timeout = 4200) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind === 'info' ? '' : kind);
    el.innerHTML = `<div class="t-body">${CU.escapeHtml(msg)}</div><div class="t-close">✕</div>`;
    const close = () => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 180);
    };
    el.querySelector('.t-close').addEventListener('click', close);
    els.toasts.appendChild(el);
    if (timeout) setTimeout(close, timeout);
    // Errors and warnings are important enough to also hold in the status bar.
    if (kind === 'error') setStatus(msg, 'error');
    else if (kind === 'warn') setStatus(msg, 'warn');
    return close;
  }

  /* ───────────────────────────── status bar ───────────────────────────── */
  const STATUS_ICONS = { idle: '●', info: 'ℹ', busy: '●', ok: '✓', warn: '⚠', error: '✕' };
  const statusHistory = [];
  let statusState = { text: '', level: 'idle', progress: null };
  let statusTimer = null;

  function pushStatusHistory(text, level) {
    const last = statusHistory[statusHistory.length - 1];
    if (last && last.text === text && last.level === level) return;
    statusHistory.push({ time: Date.now(), text, level });
    if (statusHistory.length > 120) statusHistory.shift();
  }

  function renderStatus() {
    const { text, level, progress } = statusState;
    els.statusbar.className = 'statusbar ' + level;
    els.statusIcon.textContent = STATUS_ICONS[level] || '●';
    els.statusText.textContent = text || t('ready');
    els.statusSpinner.classList.toggle('hidden', level !== 'busy');
    const hasProgress = typeof progress === 'number';
    els.statusProgress.classList.toggle('hidden', !hasProgress);
    if (hasProgress) els.statusProgressBar.style.width = Math.max(0, Math.min(100, progress * 100)) + '%';
    els.statusClear.classList.toggle('hidden', !(level === 'error' || level === 'warn'));
  }

  function setStatus(text, level = 'info', opts = {}) {
    statusState = {
      text: text || t('ready'),
      level: text ? level : 'idle',
      progress: typeof opts.progress === 'number' ? opts.progress : null,
    };
    renderStatus();
    clearTimeout(statusTimer);
    if (text && opts.log !== false) pushStatusHistory(text, level);
    const auto = opts.timeout != null ? opts.timeout : level === 'ok' ? 4000 : level === 'info' ? 6000 : 0;
    if (auto > 0) {
      statusTimer = setTimeout(() => {
        statusState = { text: t('ready'), level: 'idle', progress: null };
        renderStatus();
      }, auto);
    }
    return statusState;
  }

  function clearStatus() {
    if (statusState.level === 'error' || statusState.level === 'warn') return;
    setStatus(t('ready'), 'idle');
  }

  function updateStatusInfo() {
    const clip = activeClip();
    if (!clip) {
      els.statusInfo.textContent = state.clips.length ? '' : 'No media loaded';
      return;
    }
    const idx = state.clips.indexOf(clip) + 1;
    els.statusInfo.textContent = `${idx}/${state.clips.length} · ${clip.name} · ${clip.width}×${clip.height} · ${
      clip.fps ? clip.fps.toFixed(2) : '?'
    } fps · ${CU.fmt(totalKept(clip), 3)} / ${CU.fmt(clip.durationMs, 3)}`;
  }

  function renderStatusLog() {
    els.statusLog.innerHTML = '';
    if (!statusHistory.length) {
      els.statusLog.innerHTML = `<div class="status-log-empty">${CU.escapeHtml(t('msgNoMessages'))}</div>`;
      return;
    }
    for (let i = statusHistory.length - 1; i >= 0; i--) {
      const m = statusHistory[i];
      const d = new Date(m.time);
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      const row = document.createElement('div');
      row.className = 'status-log-row ' + m.level;
      row.innerHTML = `<span class="sl-time">${time}</span><span class="sl-text">${CU.escapeHtml(m.text)}</span>`;
      els.statusLog.appendChild(row);
    }
  }

  function toggleStatusLog() {
    if (!els.statusLog.classList.contains('hidden')) {
      hideStatusLog();
      return;
    }
    renderStatusLog();
    const r = els.statusbar.getBoundingClientRect();
    els.statusLog.style.left = r.left + 8 + 'px';
    els.statusLog.style.width = Math.min(720, window.innerWidth - 24) + 'px';
    els.statusLog.style.bottom = window.innerHeight - r.top + 6 + 'px';
    els.statusLog.classList.remove('hidden');
  }

  function hideStatusLog() {
    els.statusLog.classList.add('hidden');
  }

  /* ───────────────────────────── undo ───────────────────────────── */
  function snapshot() {
    return JSON.stringify(
      state.clips.map((c) => ({
        id: c.id,
        deletes: c.deletes.map((x) => ({ id: x.id, start: x.start, end: x.end })),
        subtitles: (c.subtitles || []).map((t) => ({
          id: t.id,
          path: t.path,
          name: t.name,
          format: t.format,
          events: t.events,
          enabled: t.enabled !== false,
        })),
        activeSubtitleId: c.activeSubtitleId || null,
        order: null,
      })),
    );
  }
  function pushUndo() {
    state.undo.push(snapshot());
    if (state.undo.length > 60) state.undo.shift();
    state.redo.length = 0;
  }
  function applySnapshot(json) {
    const data = JSON.parse(json);
    const byId = new Map(state.clips.map((c) => [c.id, c]));
    const ordered = [];
    for (const d of data) {
      const c = byId.get(d.id);
      if (!c) continue;
      c.deletes = d.deletes || [];
      c.subtitles = (d.subtitles || []).map((t) => ({ ...t }));
      c.activeSubtitleId = d.activeSubtitleId || (c.subtitles[0] ? c.subtitles[0].id : null);
      ordered.push(c);
    }
    for (const c of state.clips) if (!ordered.includes(c)) ordered.push(c);
    state.clips = ordered;
    invalidate();
    renderAll();
  }
  function undo() {
    if (!state.undo.length) return toast(t('msgNothingUndo'), 'warn', 1600);
    state.redo.push(snapshot());
    applySnapshot(state.undo.pop());
  }
  function redo() {
    if (!state.redo.length) return toast(t('msgNothingRedo'), 'warn', 1600);
    state.undo.push(snapshot());
    applySnapshot(state.redo.pop());
  }

  /* ───────────────────────────── media ───────────────────────────── */
  async function addVideos(paths) {
    if (!paths || !paths.length) return;
    for (const p of paths) {
      try {
        setStatus(tf('msgAnalyzing', { name: CU.basename(p) }), 'busy', { log: false });
        const info = await api.probe(p);
        if (!info.hasVideo) {
          toast(tf('msgSkippedNoVideo', { name: CU.basename(p) }), 'warn');
          continue;
        }
        const clip = {
          id: CU.uid('clip'),
          path: p,
          name: info.name,
          durationMs: info.durationMs,
          fps: info.fps,
          width: info.width,
          height: info.height,
          hasAudio: info.hasAudio,
          videoCodec: info.videoCodec,
          audioCodec: info.audioCodec,
          fileSize: info.size || 0,
          deletes: [],
          subtitles: [],
          activeSubtitleId: null,
          thumbs: null,
          proxyPath: null,
        };
        state.clips.push(clip);
        if (!state.activeClipId) state.activeClipId = clip.id;
        if (state.settings.loadThumbs) loadThumbs(clip);
        else clip.thumbs = { dir: '', files: [], stepMs: 1000 };
      } catch (err) {
        toast(tf('msgCouldNotRead', { name: CU.basename(p) }) + '\n' + (err.message || err), 'error', 7000);
      }
    }
    invalidate();
    renderAll();
    const clip = activeClip();
    if (clip) await activateClip(clip.id);
    tryApplyPendingJob();

    // Don't leave the transient "Analyzing…" status on screen when nothing else
    // will replace it (i.e. keyframe snapshots are disabled).
    if (!thumbJobs.size && !state.clips.some((c) => c.thumbsLoading)) {
      const n = paths.length;
      const label = `Added ${n} clip${n > 1 ? 's' : ''}`;
      if (state.settings.loadThumbs) setStatus(label, 'ok', { timeout: 3000 });
      else setStatus(`${label} · ${t('msgThumbsAreOff')}`, 'info', { timeout: 4500 });
    }
  }

  async function loadThumbs(clip) {
    if (!state.settings.loadThumbs) {
      if (!clip.thumbs) clip.thumbs = { dir: '', files: [], stepMs: 1000 };
      return;
    }
    if (clip.thumbsLoading) return;
    clip.thumbsLoading = true;
    setStatus(tf('msgThumbsFor', { name: clip.name }), 'busy', { progress: 0, log: false });
    let failed = false;
    try {
      clip.thumbs = await api.thumbs(clip.path, { durationMs: clip.durationMs, height: 64, maxCount: 170 });
    } catch {
      clip.thumbs = { dir: '', files: [], stepMs: 1000 };
      failed = true;
    } finally {
      clip.thumbsLoading = false;
      thumbJobs.delete(clip.path);
    }
    if (state.activeClipId === clip.id) renderTimeline();
    if (failed) setStatus(tf('msgThumbsFailed', { name: clip.name }), 'warn');
    else if (!thumbJobs.size) {
      const n = clip.thumbs && clip.thumbs.files ? clip.thumbs.files.length : 0;
      if (n) setStatus(tf('msgThumbsLoaded', { n }), 'ok', { timeout: 2500 });
    }
  }

  /** Enable/disable the filmstrip according to the current setting. */
  function applyThumbSetting() {
    if (state.settings.loadThumbs) {
      let started = false;
      for (const clip of state.clips) {
        if (!clip.thumbs || !clip.thumbs.files || !clip.thumbs.files.length) {
          loadThumbs(clip);
          started = true;
        }
      }
      if (!started) setStatus(t('msgThumbsOn'), 'info', { timeout: 3000 });
    } else {
      for (const clip of state.clips) {
        clip.thumbs = { dir: '', files: [], stepMs: 1000 };
        thumbJobs.delete(clip.path);
      }
      setStatus(t('msgThumbsOff'), 'info', { timeout: 3000 });
    }
    renderTimeline();
    updateStatusInfo();
  }

  /** Re-generate any filmstrip that was interrupted (e.g. by cancelling an export). */
  function retryMissingThumbs() {
    for (const clip of state.clips) {
      if ((!clip.thumbs || !clip.thumbs.files || clip.thumbs.files.length === 0) && !clip.thumbsLoading) loadThumbs(clip);
    }
  }

  /** Load one or more subtitle files into a clip — one track per file. */
  async function loadSubtitlesFromPaths(clip, paths) {
    if (!clip || !paths || !paths.length) return 0;
    if (!Array.isArray(clip.subtitles)) clip.subtitles = [];
    let added = 0;
    const problems = [];

    for (const p of paths) {
      try {
        if (clip.subtitles.some((t) => t.path && t.path === p)) {
          problems.push(`${CU.basename(p)}: ${t('errSubLoaded')}`);
          continue;
        }
        const text = await api.readText(p, { maxBytes: 64 * 1024 * 1024 });
        const parsed = CU.parseSubtitles(text);
        if (!parsed.events.length) {
          problems.push(`${CU.basename(p)}: ${t('errSubNoEvents')}`);
          continue;
        }
        clip.subtitles.push({
          id: CU.uid('sub'),
          path: p,
          name: CU.basename(p),
          format: parsed.format,
          events: parsed.events,
          enabled: true,
        });
        added += 1;
      } catch (err) {
        problems.push(`${CU.basename(p)}: ${err.message || err}`);
      }
    }

    if (added) {
      pushUndo();
      if (!clip.activeSubtitleId || !clip.subtitles.some((t) => t.id === clip.activeSubtitleId)) {
        clip.activeSubtitleId = clip.subtitles[0].id;
      }
      invalidate();
      renderAll();
      setStatus(tf('msgSubsLoaded', { n: added, tracks: clip.subtitles.length, name: clip.name }), 'ok', { timeout: 3500 });
    }
    if (problems.length) toast(problems.join('\n'), 'warn', 8000);
    return added;
  }

  /** Compatibility wrapper used by tests: load a single subtitle file. */
  async function loadSubtitleFromPath(clip, p) {
    return (await loadSubtitlesFromPaths(clip, [p])) > 0;
  }

  async function addSubtitleToClip(clip) {
    const paths = await api.openSubtitles();
    if (!paths || !paths.length) return false;
    return (await loadSubtitlesFromPaths(clip, paths)) > 0;
  }

  /* ───────────────────────────── video element ───────────────────────────── */
  function ensureVideoFor(clip) {
    const src = api.mediaUrl(clip.proxyPath || clip.path);
    return new Promise((resolve) => {
      if (videoFile === src) return resolve(true);
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        els.video.removeEventListener('loadedmetadata', onOk);
        els.video.removeEventListener('error', onErr);
        resolve(ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      els.video.addEventListener('loadedmetadata', onOk);
      els.video.addEventListener('error', onErr);
      videoFile = src;
      els.video.src = src;
      els.video.load();
      setTimeout(() => done(false), 20000);
    });
  }

  function seekVideo(ms) {
    const video = els.video;
    return new Promise((resolve) => {
      const target = Math.max(0, ms / 1000);
      if (Math.abs(video.currentTime - target) < 0.0008) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', finish);
        resolve();
      };
      video.addEventListener('seeked', finish);
      try {
        video.currentTime = target;
      } catch {
        finish();
      }
      setTimeout(finish, 2500);
    });
  }

  async function activateClip(clipId, opts = {}) {
    state.activeClipId = clipId;
    program.playing = false;
    const clip = activeClip();
    updateClipList();
    if (!clip) {
      state.playhead = 0;
      renderTimeline();
      updateTransport();
      return;
    }
    if (opts.seek != null) state.playhead = opts.seek;
    if (opts.loadVideo !== false) {
      const ok = await ensureVideoFor(clip);
      if (ok) {
        await seekVideo(state.playhead);
      }
    }
    renderTimeline();
    updateTransport();
    updateStatusInfo();
  }

  /* ───────────────────────────── rendering ───────────────────────────── */
  function renderAll() {
    invalidate();
    updateStatusInfo();
    updateClipList();
    updateDeleteList();
    updateSubPanel();
    renderTimeline();
    updateTransport();
    updateModeUI();
    if (!els.exportModal.classList.contains('hidden')) updateExportSummary();
  }

  function renderTimeline() {
    scheduleTimelineSync();
    const clip = activeClip();
    els.emptyState.classList.toggle('hidden', state.clips.length > 0 && !!clip);
    if (!clip) {
      state.pxPerMs = 0;
      els.timeline.style.width = '100%';
      [els.tlRuler, els.tlFilm, els.tlDeletes, els.tlSubs].forEach((e) => (e.innerHTML = ''));
      renderOverlays();
      return;
    }
    const scrollW = els.timelineScroll.clientWidth || 900;
    const width = Math.max(scrollW, scrollW * state.zoom);
    els.timeline.style.width = width + 'px';
    state.pxPerMs = width / clip.durationMs;
    buildBase(clip);
    renderOverlays();
  }

  function buildBase(clip) {
    const ppm = state.pxPerMs;
    const width = clip.durationMs * ppm;

    // ruler
    els.tlRuler.innerHTML = '';
    const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
    const step = steps.find((s) => s * ppm >= 84) || 3600000;
    for (let t = 0; t <= clip.durationMs + 1; t += step) {
      const x = t * ppm;
      const tick = document.createElement('div');
      tick.className = 'tl-tick';
      tick.style.left = x + 'px';
      const label = document.createElement('div');
      label.className = 'tl-tick-label';
      label.style.left = x + 'px';
      label.textContent = CU.fmt(t, step < 1000 ? 3 : 0);
      els.tlRuler.append(tick, label);
    }

    // filmstrip
    els.tlFilm.innerHTML = '';
    if (clip.thumbs && clip.thumbs.files && clip.thumbs.files.length) {
      const stepMs = clip.thumbs.stepMs || 1000;
      clip.thumbs.files.forEach((f, i) => {
        const left = i * stepMs * ppm;
        if (left > width) return;
        const img = document.createElement('img');
        img.className = 'tl-thumb';
        img.draggable = false;
        img.src = api.mediaUrl(pathJoin(clip.thumbs.dir, f));
        img.style.left = left + 'px';
        img.style.width = Math.max(1, stepMs * ppm + 1) + 'px';
        els.tlFilm.appendChild(img);
      });
    } else if (!clip.thumbsLoading) {
      const hint = document.createElement('div');
      hint.className = 'tl-film-hint';
      hint.textContent = state.settings.loadThumbs
        ? t('msgNoKeyframes')
        : t('msgThumbsHint');
      els.tlFilm.appendChild(hint);
    }

    // deletes
    els.tlDeletes.innerHTML = '';
    for (const deletion of clip.deletes) {
      const el = document.createElement('div');
      el.className = 'tl-delete';
      el.dataset.deleteId = deletion.id;
      el.style.left = deletion.start * ppm + 'px';
      el.style.width = Math.max(3, (deletion.end - deletion.start) * ppm) + 'px';
      el.innerHTML =
        `<div class="delete-handle start" data-handle="start"></div>` +
        `<div class="delete-handle end" data-handle="end"></div>` +
        `<div class="delete-label">${CU.fmt(deletion.start, 3)} → ${CU.fmt(deletion.end, 3)} · ${CU.fmt(deletion.end - deletion.start, 3)}</div>`;
      els.tlDeletes.appendChild(el);
    }

    // subtitles (active track)
    els.tlSubs.innerHTML = '';
    const subTrack = activeSubtitleTrack(clip);
    if (subTrack) {
      const ranges = keptRanges(clip);
      const dropped = new Set(CU.droppedEvents(subTrack.events, ranges));
      subTrack.events.forEach((ev) => {
        const el = document.createElement('div');
        el.className = 'tl-sub' + (dropped.has(ev) ? ' dropped' : '');
        el.style.left = ev.start * ppm + 'px';
        el.style.width = Math.max(2, (ev.end - ev.start) * ppm) + 'px';
        el.title = `${CU.fmt(ev.start, 3)} → ${CU.fmt(ev.end, 3)}\n${ev.text}${dropped.has(ev) ? '\n\n(entirely inside a deletion — will be removed)' : ''}`;
        el.textContent = ev.text.replace(/\s*\n\s*/g, ' ');
        el.dataset.subStart = String(ev.start);
        els.tlSubs.appendChild(el);
      });
    }
  }

  function renderOverlays() {
    const clip = activeClip();
    if (!clip) {
      els.tlSelection.classList.add('hidden');
      els.tlMarkerIn.classList.add('hidden');
      els.tlMarkerOut.classList.add('hidden');
      els.tlPlayhead.style.left = '0px';
      return;
    }
    const ppm = state.pxPerMs || 0;

    const sel = state.selection && state.selection.clipId === clip.id ? state.selection : null;
    if (sel && Math.abs(sel.end - sel.start) > 1) {
      els.tlSelection.classList.remove('hidden');
      els.tlSelection.style.left = Math.min(sel.start, sel.end) * ppm + 'px';
      els.tlSelection.style.width = Math.abs(sel.end - sel.start) * ppm + 'px';
    } else {
      els.tlSelection.classList.add('hidden');
    }

    toggleMarker(els.tlMarkerIn, state.inPoint, ppm);
    toggleMarker(els.tlMarkerOut, state.outPoint, ppm);

    els.tlPlayhead.style.left = CU.clamp(state.playhead, 0, clip.durationMs) * ppm + 'px';
  }

  function toggleMarker(el, value, ppm) {
    if (value == null) el.classList.add('hidden');
    else {
      el.classList.remove('hidden');
      el.style.left = value * ppm + 'px';
    }
  }

  function updateClipList() {
    scheduleSidebarSync();
    els.clipCount.textContent = String(state.clips.length);
    els.clipList.innerHTML = '';
    if (!state.clips.length) {
      els.clipList.innerHTML = '<div class="sub-info"></div>';
      els.clipList.firstChild.textContent = t('noMedia');
      return;
    }
    state.clips.forEach((clip, i) => {
      const kept = totalKept(clip);
      const el = document.createElement('div');
      el.className = 'clip' + (clip.id === state.activeClipId ? ' active' : '');
      const badges = [];
      const subCount = (clip.subtitles || []).length;
      if (subCount) badges.push(`<span class="badge sub">SUB${subCount > 1 ? ' ' + subCount : ''}</span>`);
      if (clip.proxyPath) badges.push(`<span class="badge">PROXY</span>`);
      el.innerHTML = `
        <div class="clip-top">
          <div class="clip-name" title="${CU.escapeHtml(clip.path)}">${i + 1}. ${CU.escapeHtml(clip.name)}</div>
          <div class="clip-badges">${badges.join('')}</div>
        </div>
        <div class="clip-meta">
          <span>${CU.fmt(clip.durationMs, 3)}</span>
          <span class="kept">→ ${CU.fmt(kept, 3)}</span>
          <span>${clip.width}×${clip.height}</span>
          <span>${clip.fps ? clip.fps.toFixed(2) : '?'} fps</span>
          ${clip.hasAudio ? '' : '<span style="color:var(--warn)">no audio</span>'}
          ${clip.deletes.length ? `<span style="color:var(--danger)">${clip.deletes.length} delete${clip.deletes.length > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="clip-actions">
          <button class="btn tiny" data-act="up" title="${t('msgMoveEarlier')}">↑</button>
          <button class="btn tiny" data-act="down" title="${t('msgMoveLater')}">↓</button>
          <button class="btn tiny ghost" data-act="sub">${t('msgClipAddSub')}</button>
          <button class="btn tiny ghost" data-act="remove">${t('msgClipRemove')}</button>
        </div>`;
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('button[data-act]');
        if (b) {
          e.stopPropagation();
          await handleClipAction(b.dataset.act, clip.id);
          return;
        }
        if (state.exporting) return;
        await activateClip(clip.id);
      });
      els.clipList.appendChild(el);
    });
  }

  async function handleClipAction(act, clipId) {
    const idx = state.clips.findIndex((c) => c.id === clipId);
    const clip = state.clips[idx];
    if (!clip) return;
    if (act === 'up' && idx > 0) {
      pushUndo();
      state.clips.splice(idx, 1);
      state.clips.splice(idx - 1, 0, clip);
      invalidate();
      renderAll();
    } else if (act === 'down' && idx < state.clips.length - 1) {
      pushUndo();
      state.clips.splice(idx, 1);
      state.clips.splice(idx + 1, 0, clip);
      invalidate();
      renderAll();
    } else if (act === 'sub') {
      await addSubtitleToClip(clip);
    } else if (act === 'remove') {
      pushUndo();
      state.clips.splice(idx, 1);
      if (state.activeClipId === clipId) {
        state.activeClipId = state.clips[0] ? state.clips[0].id : null;
        videoFile = null;
        els.video.removeAttribute('src');
        els.video.load();
      }
      invalidate();
      renderAll();
      const a = activeClip();
      if (a) await activateClip(a.id);
    }
  }

  function updateDeleteList() {
    scheduleSidebarSync();
    const clip = activeClip();
    const deletes = clip ? [...clip.deletes].sort((a, b) => a.start - b.start) : [];
    els.deleteCount.textContent = String(deletes.length);
    els.deleteList.innerHTML = '';
    if (!clip) {
      els.deleteList.innerHTML = '<div class="sub-info"></div>';
      els.deleteList.firstChild.textContent = t('selectClip');
    } else if (!deletes.length) {
      els.deleteList.innerHTML = '<div class="sub-info"></div>';
      els.deleteList.firstChild.textContent = t('noDeletes');
    }
    deletes.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'delete-item';
      el.innerHTML =
        `<span class="delete-time">${CU.fmt(c.start, 3)} → ${CU.fmt(c.end, 3)}</span>` +
        `<span class="delete-dur">${CU.fmt(c.end - c.start, 3)}</span>` +
        `<button class="btn tiny danger" data-del="${c.id}">✕</button>`;
      el.querySelector('[data-del]').addEventListener('click', () => removeDelete(c.id));
      el.addEventListener('mouseenter', () => highlightDelete(c.id, true));
      el.addEventListener('mouseleave', () => highlightDelete(c.id, false));
      els.deleteList.appendChild(el);
    });
    updateIoReadout();
  }

  function highlightDelete(id, on) {
    const el = els.tlDeletes.querySelector(`[data-delete-id="${id}"]`);
    if (el) el.style.outline = on ? '2px solid #fff' : 'none';
  }

  function updateIoReadout() {
    const fmt = (v) => (v == null ? '—' : CU.fmt(v, 3));
    let extra = '';
    if (state.inPoint != null && state.outPoint != null && state.outPoint > state.inPoint) {
      extra = ` · ${t('selLabel')} ${CU.fmt(state.outPoint - state.inPoint, 3)}`;
    }
    els.ioReadout.innerHTML = `${t('inLabel')} <b>${fmt(state.inPoint)}</b> · ${t('outLabel')} <b>${fmt(state.outPoint)}</b>${extra}`;
  }

  function updateSubPanel() {
    scheduleSidebarSync();
    if (els.subEventCount) els.subEventCount.textContent = '0';
    autoOpenSubEvents();
    applySubEventsState();
    const clip = activeClip();
    if (document.activeElement !== els.subOffset) els.subOffset.value = String(state.globalSubOffset);
    els.subEventList.innerHTML = '';
    els.subTrackList.innerHTML = '';
    els.btnSubExport.disabled = !state.clips.some((c) => (c.subtitles || []).length);
    els.btnSubAdd.disabled = !clip;

    if (!clip) {
      els.subInfo.textContent = t('selectClipSubs');
      return;
    }

    const tracks = clip.subtitles || [];
    if (!tracks.length) {
      els.subInfo.textContent = t('noSubs');
      return;
    }

    const ranges = keptRanges(clip);
    const active = activeSubtitleTrack(clip);

    // One row per track: enable for export, pick which is shown, remove.
    tracks.forEach((t) => {
      const keptCount = remapTrack(clip, t).length;
      const row = document.createElement('div');
      row.className = 'sub-track' + (t.id === active.id ? ' active' : '') + (t.enabled === false ? ' disabled' : '');
      row.title = CU.i18n.t('msgShowTrack');
      row.innerHTML =
        `<input type="checkbox" class="sub-track-toggle" ${t.enabled !== false ? 'checked' : ''} title="Include this track when exporting" />` +
        `<span class="sub-track-name">${CU.escapeHtml(t.name)}</span>` +
        `<span class="sub-track-meta" title="kept / total events">${keptCount}/${t.events.length}</span>` +
        `<button class="sub-track-remove" title="Remove this subtitle track">✕</button>`;
      row.querySelector('.sub-track-toggle').addEventListener('change', (e) => {
        t.enabled = e.target.checked;
        invalidate();
        renderAll();
      });
      row.querySelector('.sub-track-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndo();
        clip.subtitles = clip.subtitles.filter((x) => x.id !== t.id);
        if (clip.activeSubtitleId === t.id) clip.activeSubtitleId = clip.subtitles[0] ? clip.subtitles[0].id : null;
        invalidate();
        renderAll();
      });
      row.addEventListener('click', (e) => {
        if (e.target.closest('input, button')) return;
        clip.activeSubtitleId = t.id;
        subEventsOpen = true; // choosing a track reveals its text
        renderAll();
      });
      els.subTrackList.appendChild(row);
    });

    const rows = buildSubRows(active.events, ranges, state.globalSubOffset);
    const droppedCount = rows.filter((r) => r.dropped).length;
    const keptCount = rows.length - droppedCount;
    els.subInfo.innerHTML =
      `<b>${tracks.length} track${tracks.length > 1 ? 's' : ''}</b> · ` +
      `<b>${CU.escapeHtml(active.name)}</b>${active.enabled === false ? ' (excluded from export)' : ''}<br>` +
      `${rows.length} events · <span class="ok">${keptCount} kept</span>` +
      (droppedCount ? ` · <span class="warn">${droppedCount} dropped inside deletes</span>` : '');

    const max = 400;
    rows.slice(0, max).forEach((row) => {
      const ev = row.ev;
      const el = document.createElement('div');
      el.className = 'sub-event' + (row.dropped ? ' dropped' : '');
      const newLabel = row.dropped ? 'deletion' : row.parts.map((p) => CU.fmt(p.start, 3)).join(', ');
      el.innerHTML =
        `<span class="se-time">${CU.fmt(ev.start, 3)}</span>` +
        `<span class="se-arrow">→</span>` +
        `<span class="se-new">${newLabel}</span>` +
        `<span class="se-text" title="${CU.escapeHtml(ev.text)}">${CU.escapeHtml(ev.text.replace(/\s*\n\s*/g, ' '))}</span>`;
      el.addEventListener('click', () => seekTo(ev.start));
      els.subEventList.appendChild(el);
    });
    if (els.subEventCount) els.subEventCount.textContent = String(rows.length);
    if (rows.length > max) {
      const more = document.createElement('div');
      more.className = 'sub-info';
      more.textContent = tf('msgMoreEvents', { n: rows.length - max });
      els.subEventList.appendChild(more);
    }
  }

  function updateTransport() {
    scheduleTransportSync();
    const clip = activeClip();
    const nowMs = clip ? state.playhead : 0;
    els.timecode.textContent = CU.fmt(nowMs, 3);
    els.timeTotal.textContent = clip ? CU.fmt(clip.durationMs, 3) : '0:00.000';
    const { total } = programRanges();
    if (state.playMode === 'result') {
      els.resultTc.classList.remove('hidden');
      els.resultTc.textContent = `${t('preview').toLowerCase()} ${CU.fmt(state.resultTime, 3)} / ${CU.fmt(total, 3)}`;
    } else {
      els.resultTc.classList.add('hidden');
    }

    const totalMs = state.playMode === 'result' ? programRanges().total : clip ? clip.durationMs : 0;
    const curMs = state.playMode === 'result' ? state.resultTime : clip ? state.playhead : 0;
    if (!state.scrubbing && els.seekRange) {
      els.seekRange.value = totalMs > 0 ? String(Math.round((curMs / totalMs) * 10000)) : '0';
    }

    els.btnPlay.textContent = !els.video.paused && (state.playMode === 'source' || program.playing) ? '❚❚' : '▶';
  }

  function updateModeUI() {
    els.modeSource.classList.toggle('active', state.playMode === 'source');
    els.modeResult.classList.toggle('active', state.playMode === 'result');
    updateTransport();
    sendMenuState();
  }

  function updateSubtitleOverlay() {
    const clip = activeClip();
    const track = activeSubtitleTrack(clip);
    if (!track) {
      els.subtitleOverlay.innerHTML = '';
      return;
    }
    let events;
    let time;
    if (state.playMode === 'result') {
      events = remapTrack(clip, track);
      time = state.resultTime;
    } else {
      events = track.events;
      time = state.playhead;
    }
    const active = [];
    for (const e of events) {
      if (time >= e.start && time <= e.end) active.push(e);
      else if (e.start > time) break;
    }
    els.subtitleOverlay.innerHTML = active.map((e) => `<span>${CU.escapeHtml(e.text)}</span>`).join('');
  }

  /* ───────────────────────────── delete operations ───────────────────────────── */
  function normalizeDeletes(clip) {
    const deletes = [...clip.deletes].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const c of deletes) {
      const last = merged[merged.length - 1];
      if (last && c.start <= last.end + 1) last.end = Math.max(last.end, c.end);
      else merged.push({ id: c.id, start: c.start, end: c.end });
    }
    clip.deletes = merged;
  }

  function addDelete(start, end) {
    const clip = activeClip();
    if (!clip) return;
    let s = snapMs(Math.min(start, end));
    let e = snapMs(Math.max(start, end));
    s = CU.clamp(s, 0, clip.durationMs);
    e = CU.clamp(e, 0, clip.durationMs);
    if (e - s < 1) {
      toast(t('msgSelTooShort'), 'warn', 2000);
      return;
    }
    pushUndo();
    clip.deletes.push({ id: CU.uid('delete'), start: s, end: e });
    normalizeDeletes(clip);
    state.selection = null;
    state.inPoint = null;
    state.outPoint = null;
    invalidate();
    renderAll();
  }

  function removeDelete(id) {
    const clip = activeClip();
    if (!clip) return;
    pushUndo();
    clip.deletes = clip.deletes.filter((c) => c.id !== id);
    invalidate();
    renderAll();
  }

  function getEditRange() {
    const clip = activeClip();
    if (!clip) return null;
    const sel = state.selection;
    if (sel && sel.clipId === clip.id && Math.abs(sel.end - sel.start) > 1) {
      return { start: Math.min(sel.start, sel.end), end: Math.max(sel.start, sel.end) };
    }
    if (state.inPoint != null && state.outPoint != null && Math.abs(state.outPoint - state.inPoint) > 1) {
      return { start: Math.min(state.inPoint, state.outPoint), end: Math.max(state.inPoint, state.outPoint) };
    }
    return null;
  }

  function deleteSelection() {
    const clip = activeClip();
    if (!clip) return toast(t('msgAddVideo'), 'warn', 2600);
    const r = getEditRange();
    if (!r) {
      if (state.inPoint != null && state.outPoint == null)
        return toast(t('msgOutNotSet'), 'warn', 4200);
      if (state.outPoint != null && state.inPoint == null)
        return toast(t('msgInNotSet'), 'warn', 4200);
      if (state.inPoint != null && state.outPoint != null)
        return toast(t('msgInOutSame'), 'warn', 4200);
      return toast(t('msgNothingSelected'), 'warn', 4200);
    }
    addDelete(r.start, r.end);
  }

  /** Double-click on the ruler/filmstrip: set In, then Out, then start a new range. */
  function applyDoubleClickMark(t) {
    const clip = activeClip();
    if (!clip) return;
    pause();
    state.selection = null;
    if (state.inPoint == null) {
      state.inPoint = t;
      state.outPoint = null;
      setStatus(tf('msgInSet', { time: CU.fmt(t, 3) }), 'info', { timeout: 3500 });
    } else if (state.outPoint == null) {
      state.outPoint = t;
      setStatus(tf('msgOutSet', { time: CU.fmt(t, 3), sel: CU.fmt(Math.abs(t - state.inPoint), 3) }), 'info', { timeout: 3500 });
    } else {
      state.inPoint = t;
      state.outPoint = null;
      setStatus(tf('msgNewIn', { time: CU.fmt(t, 3) }), 'info', { timeout: 3000 });
    }
    renderOverlays();
    updateIoReadout();
  }

  function clearMarks() {
    if (state.inPoint == null && state.outPoint == null && !state.selection) return;
    state.selection = null;
    state.inPoint = null;
    state.outPoint = null;
    renderOverlays();
    updateIoReadout();
  }

  function clearDeletes() {
    const clip = activeClip();
    if (!clip || !clip.deletes.length) return;
    pushUndo();
    clip.deletes = [];
    state.selection = null;
    invalidate();
    renderAll();
  }

  /* ───────────────────────── context menu ───────────────────────── */
  function hideContextMenu() {
    if (els.ctxMenu.classList.contains('hidden')) return;
    els.ctxMenu.classList.add('hidden');
    els.ctxMenu.innerHTML = '';
  }

  function buildContextItems(t, deleteId) {
    const clip = activeClip();
    const range = getEditRange();
    const at = CU.fmt(t, 3);
    const items = [];

    items.push({ label: 'Set In here', key: 'I', hint: at, action: () => { state.inPoint = t; renderOverlays(); updateIoReadout(); } });
    items.push({ label: 'Set Out here', key: 'O', hint: at, action: () => { state.outPoint = t; renderOverlays(); updateIoReadout(); } });
    items.push({ sep: true });

    items.push({
      label: 'Delete In → Out',
      key: 'X',
      hint: range ? CU.fmt(range.end - range.start, 3) : '',
      disabled: !range,
      action: () => deleteSelection(),
    });

    if (state.inPoint != null && Math.abs(t - state.inPoint) > 1) {
      items.push({ label: 'Delete from In to here', hint: CU.fmt(Math.abs(t - state.inPoint), 3), action: () => addDelete(state.inPoint, t) });
    }
    if (state.outPoint != null && Math.abs(state.outPoint - t) > 1) {
      items.push({ label: 'Delete from here to Out', hint: CU.fmt(Math.abs(state.outPoint - t), 3), action: () => addDelete(t, state.outPoint) });
    }

    const deletion = deleteId && clip ? clip.deletes.find((c) => c.id === deleteId) : null;
    if (deletion) {
      items.push({ sep: true });
      items.push({ label: 'Remove this deletion', danger: true, hint: CU.fmt(deletion.end - deletion.start, 3), action: () => removeDelete(deletion.id) });
    }

    items.push({ sep: true });
    items.push({ label: 'Clear marks', disabled: state.inPoint == null && state.outPoint == null && !state.selection, action: () => clearMarks() });
    items.push({ label: 'Clear deletions', danger: true, disabled: !clip || !clip.deletes.length, action: () => clearDeletes() });
    return items;
  }

  function showContextMenu(clientX, clientY, timeMs, deleteId) {
    const clip = activeClip();
    if (!clip) return;
    const t = snapMs(timeMs);
    const frame = clip.fps ? ` · frame ${Math.round(t / (1000 / clip.fps))}` : '';
    const menu = els.ctxMenu;
    menu.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = `at ${CU.fmt(t, 3)}${frame}`;
    menu.appendChild(head);

    for (const it of buildContextItems(t, deleteId)) {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        menu.appendChild(s);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '');
      const label = document.createElement('span');
      label.textContent = it.label;
      el.appendChild(label);
      if (it.hint) {
        const hint = document.createElement('span');
        hint.className = 'ctx-hint';
        hint.textContent = it.hint;
        el.appendChild(hint);
      }
      if (it.key) {
        const k = document.createElement('span');
        k.className = 'ctx-key';
        k.textContent = it.key;
        el.appendChild(k);
      }
      if (!it.disabled) {
        el.addEventListener('click', () => {
          hideContextMenu();
          it.action();
        });
      }
      menu.appendChild(el);
    }

    // Measure off-screen, then clamp into the viewport.
    menu.style.left = '-9999px';
    menu.style.top = '0px';
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8)) + 'px';
  }

  /** Map a source time on `clipId` to its position in the merged result. */
  function sourceToResultMs(clipId, srcMs) {
    const { ranges } = programRanges();
    const mine = ranges.filter((r) => r.clipId === clipId);
    if (!mine.length) return 0;
    for (const r of mine) {
      if (srcMs >= r.srcStart && srcMs <= r.srcEnd) return r.outStart + (srcMs - r.srcStart);
    }
    // Inside a removed range: snap forward to the next kept frame (or back to
    // the last one when the clip is delete away to its end).
    const next = mine.find((r) => r.srcStart >= srcMs);
    return next ? next.outStart : mine[mine.length - 1].outEnd;
  }

  function seekTo(ms) {
    const clip = activeClip();
    if (!clip) return;
    // In Result mode the timeline is source-time based; translate the target
    // before seeking, otherwise the preview stays where it was.
    if (state.playMode === 'result') {
      seekResult(sourceToResultMs(clip.id, CU.clamp(ms, 0, clip.durationMs)));
      return;
    }
    state.playhead = CU.clamp(ms, 0, clip.durationMs);
    if (state.playMode === 'source') {
      seekVideo(state.playhead);
    }
    renderOverlays();
    updateTransport();
    updateSubtitleOverlay();
    scrollPlayheadIntoView();
  }

  function scrollPlayheadIntoView(force) {
    const sc = els.timelineScroll;
    const x = state.playhead * state.pxPerMs;
    if (force || x < sc.scrollLeft + 30 || x > sc.scrollLeft + sc.clientWidth - 30) {
      sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.5);
    }
  }

  /* ───────────────────────────── playback ───────────────────────────── */
  async function playSource() {
    const clip = activeClip();
    if (!clip) return;
    const ok = await ensureVideoFor(clip);
    if (!ok) return;
    await seekVideo(state.playhead);
    await els.video.play().catch(() => {});
    updateTransport();
  }

  async function programPlay(fromResultMs) {
    const { ranges, total } = programRanges();
    if (!ranges.length) {
      toast(t('msgNothingPreview'), 'warn');
      return;
    }
    const target = CU.clamp(Number(fromResultMs) || 0, 0, total);
    let idx = ranges.findIndex((r) => target >= r.outStart && target < r.outEnd - 1);
    if (idx < 0) idx = ranges.findIndex((r) => r.outStart >= target);
    if (idx < 0) idx = ranges.length - 1;
    program.ranges = ranges;
    program.idx = idx;
    program.playing = true;
    // Resume *at* the requested output position (the old code snapped to the
    // start of the range, so every seek restarted from 0:00.000).
    state.resultTime = CU.clamp(target, ranges[idx].outStart, ranges[idx].outEnd);
    await playProgramRange();
  }

  async function playProgramRange() {
    const r = program.ranges[program.idx];
    if (!r) return;
    const clip = state.clips.find((c) => c.id === r.clipId);
    if (!clip) return;
    state.activeClipId = r.clipId;
    updateClipList();
    const local = r.srcStart + CU.clamp(state.resultTime - r.outStart, 0, r.srcEnd - r.srcStart);
    const ok = await ensureVideoFor(clip);
    if (!ok) {
      program.playing = false;
      return;
    }
    await seekVideo(local);
    state.playhead = local;
    renderTimeline();
    updateTransport();
    await els.video.play().catch(() => {});
  }

  function pause() {
    program.playing = false;
    els.video.pause();
    updateTransport();
  }

  /** Seek inside the merged result by output time (used by the scrubber). */
  async function seekResult(ms) {
    const { ranges, total } = programRanges();
    if (!ranges.length) return;
    const t = CU.clamp(ms, 0, total);
    state.resultTime = t;
    let idx = ranges.findIndex((r) => t >= r.outStart && t < r.outEnd);
    if (idx < 0) idx = ranges.findIndex((r) => r.outStart >= t);
    if (idx < 0) idx = ranges.length - 1;
    program.idx = idx;
    program.playing = false;
    if (!els.video.paused) els.video.pause();
    const r = ranges[idx];
    const clip = state.clips.find((c) => c.id === r.clipId);
    const local = r.srcStart + CU.clamp(t - r.outStart, 0, r.srcEnd - r.srcStart);
    const clipChanged = state.activeClipId !== r.clipId;
    state.activeClipId = r.clipId;
    if (clipChanged) {
      updateClipList();
      renderTimeline();
    }
    const ok = await ensureVideoFor(clip);
    if (ok) await seekVideo(local);
    state.playhead = local;
    if (!clipChanged) renderOverlays(); // scrubbing only moves the playhead
    updateTransport();
    updateSubtitleOverlay();
    scrollPlayheadIntoView();
  }

  async function togglePlay() {
    if (state.playMode === 'source') {
      if (els.video.paused) await playSource();
      else pause();
      return;
    }
    if (program.playing && !els.video.paused) pause();
    else await programPlay(state.resultTime);
  }

  /* ───────────────────────────── timeline interaction ───────────────────────────── */
  let drag = null;

  function xToMs(clientX) {
    const rect = els.timeline.getBoundingClientRect();
    return (clientX - rect.left) / (state.pxPerMs || 1);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return; // left button only; right button opens the context menu
    const clip = activeClip();
    if (!clip || state.exporting) return;
    const target = e.target;

    if (target.closest('#tlMarkerIn') && state.inPoint != null) {
      pause();
      seekTo(state.inPoint);
      return;
    }
    if (target.closest('#tlMarkerOut') && state.outPoint != null) {
      pause();
      seekTo(state.outPoint);
      return;
    }
    if (target.closest('#tlPlayhead')) {
      drag = { type: 'playhead' };
      pause();
      return;
    }
    if (target.closest('#tlRuler')) {
      drag = { type: 'scrub' };
      pause();
      seekTo(snapMs(xToMs(e.clientX)));
      return;
    }
    const deleteEl = target.closest('.tl-delete');
    if (deleteEl) {
      const deletion = clip.deletes.find((c) => c.id === deleteEl.dataset.deleteId);
      if (!deletion) return;
      const handle = target.closest('[data-handle]');
      const ms = snapMs(xToMs(e.clientX));
      if (handle) {
        drag = { type: 'delete-edge', deleteId: deletion.id, side: handle.dataset.handle, pushed: false };
      } else {
        drag = { type: 'delete-move', deleteId: deletion.id, grabMs: ms, origStart: deletion.start, origEnd: deletion.end, moved: false, pushed: false };
      }
      return;
    }
    if (target.closest('#tlSubs')) {
      const sub = target.closest('.tl-sub');
      if (sub) {
        seekTo(Number(sub.dataset.subStart));
        return;
      }
    }
    if (target.closest('#tlFilm')) {
      const ms = snapMs(xToMs(e.clientX));
      drag = { type: 'select', anchor: ms, moved: false };
      state.selection = { clipId: clip.id, start: ms, end: ms };
      renderOverlays();
    }
  }

  function onPointerMove(e) {
    if (!drag) return;
    const clip = activeClip();
    if (!clip) return;
    const ms = snapMs(xToMs(e.clientX));

    if (drag.type === 'playhead' || drag.type === 'scrub') {
      seekTo(ms);
      return;
    }
    if (drag.type === 'select') {
      if (Math.abs(ms - drag.anchor) > 3) drag.moved = true;
      state.selection = { clipId: clip.id, start: drag.anchor, end: ms };
      renderOverlays();
      return;
    }
    const deletion = clip.deletes.find((c) => c.id === drag.deleteId);
    if (!deletion) return;
    if (!drag.pushed && drag.type !== 'select' && drag.type !== 'scrub' && drag.type !== 'playhead') {
      pushUndo();
      drag.pushed = true;
    }
    if (drag.type === 'delete-edge') {
      if (drag.side === 'start') deletion.start = CU.clamp(ms, 0, deletion.end - 1);
      else deletion.end = CU.clamp(ms, deletion.start + 1, clip.durationMs);
    } else if (drag.type === 'delete-move') {
      const delta = ms - drag.grabMs;
      if (Math.abs(delta) > 1) drag.moved = true;
      const len = drag.origEnd - drag.origStart;
      let s = CU.clamp(drag.origStart + delta, 0, clip.durationMs - len);
      deletion.start = s;
      deletion.end = s + len;
    }
    invalidate();
    updateDeleteElement(deletion);
    updateDeleteList();
  }

  function updateDeleteElement(deletion) {
    const el = els.tlDeletes.querySelector(`[data-delete-id="${deletion.id}"]`);
    if (!el) return;
    el.style.left = deletion.start * state.pxPerMs + 'px';
    el.style.width = Math.max(3, (deletion.end - deletion.start) * state.pxPerMs) + 'px';
    const label = el.querySelector('.delete-label');
    if (label) label.textContent = `${CU.fmt(deletion.start, 3)} → ${CU.fmt(deletion.end, 3)} · ${CU.fmt(deletion.end - deletion.start, 3)}`;
  }

  function onPointerUp() {
    if (!drag) return;
    const clip = activeClip();
    if (drag.type === 'select' && clip) {
      if (!drag.moved) {
        state.selection = null;
        seekTo(snapMs(drag.anchor));
      } else {
        const sel = state.selection;
        const s = Math.min(sel.start, sel.end);
        const en = Math.max(sel.start, sel.end);
        if (en - s < 2) state.selection = null;
        else state.selection = { clipId: clip.id, start: s, end: en };
        renderOverlays();
      }
    }
    if ((drag.type === 'delete-edge' || drag.type === 'delete-move') && clip) {
      normalizeDeletes(clip);
      invalidate();
      updateDeleteList();
      updateClipList();
      renderTimeline();
    }
    drag = null;
  }

  /* ─────────────────── delete job: save / share / import ─────────────────── */
  const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

  function buildJob(includeSubtitles) {
    const description = (state.jobDescription || '').trim().slice(0, 200);
    return {
      app: 'CUCI',
      kind: 'delete-job',
      version: 1,
      created: new Date().toISOString(),
      description: description || undefined,
      subOffsetMs: Math.round(state.globalSubOffset),
      export: {
        container: els.expContainer.value,
        videoCodec: els.expVcodec.value,
        crf: Number(els.expCrf.value),
        preset: els.expPreset.value,
        resolution: els.expRes.value,
        fps: els.expFps.value,
        audioBitrate: els.expAbitrate.value,
        burnSubtitles: els.expBurn.checked,
        writeSrt: els.expSrt.checked,
      },
      clips: state.clips.map((clip) => {
        const entry = {
          name: clip.name,
          size: clip.fileSize || 0,
          durationMs: Math.round(clip.durationMs),
          fps: clip.fps ? Number(clip.fps.toFixed(4)) : 0,
          width: clip.width,
          height: clip.height,
          hasAudio: !!clip.hasAudio,
          deletes: [...clip.deletes].sort((a, b) => a.start - b.start).map((c) => [round3(c.start), round3(c.end)]),
          subtitles: [],
        };
        entry.subtitles = (clip.subtitles || []).map((t) => ({
          name: t.name,
          format: t.format || 'srt',
          events: includeSubtitles ? t.events.map((e) => [round3(e.start), round3(e.end), e.text]) : null,
        }));
        return entry;
      }),
    };
  }

  function findClipForEntry(entry, usedIds) {
    let best = null;
    let bestScore = 0;
    for (const clip of state.clips) {
      if (usedIds.has(clip.id)) continue;
      let score = 0;
      if (entry.name && clip.name === entry.name) score += 2;
      if (entry.size && clip.fileSize && entry.size === clip.fileSize) score += 4;
      if (entry.durationMs && Math.abs(clip.durationMs - entry.durationMs) <= 500) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = clip;
      }
    }
    return bestScore >= 2 ? best : null;
  }

  function applyExportSettings(exp) {
    if (!exp) return;
    const set = (el, v) => {
      if (el && v != null && v !== '') el.value = String(v);
    };
    set(els.expContainer, exp.container);
    refillCodecOptions(exp.videoCodec);
    set(els.expVcodec, exp.videoCodec);
    set(els.expCrf, exp.crf);
    set(els.expPreset, exp.preset);
    set(els.expRes, exp.resolution);
    set(els.expFps, exp.fps);
    set(els.expAbitrate, exp.audioBitrate);
    els.expCrfVal.textContent = els.expCrf.value;
    if (exp.burnSubtitles != null) els.expBurn.checked = !!exp.burnSubtitles;
    if (exp.writeSrt != null) els.expSrt.checked = !!exp.writeSrt;
  }

  function applyJob(rawJob, opts = {}) {
    // Jobs come from files, the clipboard or share codes — never trust them.
    // sanitizeJob() validates/coerces everything before the app acts on it.
    const job = CU.sanitizeJob(rawJob);
    if (!opts.silent) pushUndo();
    const usedIds = new Set();
    const matched = [];
    const missing = [];
    for (const entry of job.clips) {
      const clip = findClipForEntry(entry, usedIds);
      if (!clip) {
        missing.push(entry);
        continue;
      }
      usedIds.add(clip.id);
      matched.push(clip);
      clip.deletes = (entry.deletes || [])
        .map((c) => ({ id: CU.uid('delete'), start: Number(c[0]) || 0, end: Number(c[1]) || 0 }))
        .filter((c) => c.end > c.start);
      normalizeDeletes(clip);
      const incomingTracks = Array.isArray(entry.subtitles) ? entry.subtitles : [];
      clip.subtitles = incomingTracks
        .filter((t) => t && Array.isArray(t.events) && t.events.length)
        .map((t) => ({
          id: CU.uid('sub'),
          path: '',
          name: t.name || CU.i18n.t('msgSharedSubs'),
          format: t.format === 'vtt' ? 'vtt' : 'srt',
          events: t.events.map((e) => ({ start: Number(e[0]) || 0, end: Number(e[1]) || 0, text: String(e[2] == null ? '' : e[2]) })),
          enabled: true,
        }));
      clip.activeSubtitleId = clip.subtitles[0] ? clip.subtitles[0].id : null;
    }
    if (typeof job.subOffsetMs === 'number') {
      state.globalSubOffset = Math.round(job.subOffsetMs);
      els.subOffset.value = String(state.globalSubOffset);
    }
    state.jobDescription = String(job.description || '').slice(0, 200);
    if (els.jobDesc) els.jobDesc.value = state.jobDescription;
    updateJobDescCount();
    applyExportSettings(job.export);
    if (matched.length && missing.length === 0) {
      const extras = state.clips.filter((c) => !matched.includes(c));
      state.clips = [...matched, ...extras];
    }
    invalidate();
    renderAll();
    if (matched.length && !matched.some((c) => c.id === state.activeClipId)) {
      state.activeClipId = matched[0].id;
      videoFile = null;
      activateClip(state.activeClipId);
    }
    return { matched: matched.length, missing, job };
  }

  function finishJobApply(job, res, label) {
    const names = res.missing.map((m) => m.name || 'unknown file').join(', ');
    const desc = job.description ? `“${job.description}”\n` : '';
    if (res.missing.length) {
      state.pendingJob = job;
      setJobStatus(`${desc}${tf('msgJobAppliedMissing', { n: res.matched, names })}${label}`, 'warn');
      toast(`${desc}${tf('msgJobAppliedMissing', { n: res.matched, names })}`, 'warn', 9000);
    } else {
      state.pendingJob = null;
      setJobStatus(`${desc}${tf('msgJobApplied', { n: res.matched })}${label}`, 'ok');
      toast(`${desc}${t('msgJobAppliedToast')}`, 'ok');
    }
  }

  let jobCodeTimer = null;
  function scheduleShareCodeRefresh() {
    clearTimeout(jobCodeTimer);
    jobCodeTimer = setTimeout(refreshShareCode, 200);
  }

  function updateJobDescCount() {
    if (els.jobDescCount) {
      const len = (state.jobDescription || '').length;
      els.jobDescCount.textContent = `${len} / 200`;
      els.jobDescCount.classList.toggle('at-limit', len >= 190);
    }
    if (els.btnJob) els.btnJob.title = state.jobDescription ? `${t('job')}: ${state.jobDescription}` : t('jobHint');
  }

  function tryApplyPendingJob() {
    if (!state.pendingJob) return;
    try {
      const res = applyJob(state.pendingJob, { silent: true });
      if (res.missing.length === 0) {
        state.pendingJob = null;
        setJobStatus(tf('msgJobApplied', { n: res.matched }), 'ok');
        toast(t('msgJobAppliedToast'), 'ok');
      }
    } catch {
      /* ignore */
    }
  }

  function setJobStatus(text, kind) {
    els.jobStatus.textContent = text || '';
    els.jobStatus.classList.toggle('hidden', !text);
    els.jobStatus.style.color = kind === 'warn' ? 'var(--warn)' : kind === 'ok' ? 'var(--ok)' : '';
  }

  async function refreshShareCode() {
    if (!state.clips.length) {
      els.jobCode.value = '';
      els.jobCodeInfo.textContent = t('noMedia');
      return;
    }
    const job = buildJob(els.jobIncludeSubs.checked);
    const code = await CU.encodeShareCode(job);
    els.jobCode.value = code;
    const bytes = new TextEncoder().encode(code).length;
    const deletes = job.clips.reduce((a, c) => a + c.deletes.length, 0);
    const hasSubs = job.clips.some((c) => (c.subtitles || []).some((t) => t.events && t.events.length));
    const sizeHint = bytes <= 280;
    els.jobCodeInfo.textContent =
      tf('msgShareInfo', { chars: bytes.toLocaleString(), clips: job.clips.length, deletes }) +
      (hasSubs ? t('msgShareInfoSubs') : '') +
      (sizeHint ? t('msgShareTweet') : '');
    els.jobCodeInfo.classList.toggle('warn', bytes > 4000);
  }

  /* ─────────── job file: remembered path for the Ctrl+S shortcut ─────────── */
  const JOB_FILE_KEY = 'cuci.jobFile';
  let jobFilePath = null;
  let jobFileClipPath = null; // first clip the remembered file belongs to

  function setJobFilePath(p, clipPath) {
    jobFilePath = p || null;
    jobFileClipPath = jobFilePath ? clipPath || null : null;
    try {
      if (jobFilePath) {
        localStorage.setItem(JOB_FILE_KEY, JSON.stringify({ path: jobFilePath, clip: jobFileClipPath }));
      } else {
        localStorage.removeItem(JOB_FILE_KEY);
      }
    } catch {
      /* ignore */
    }
  }

  /** The remembered job file — only when the current project is still the one it
   *  was saved from, so working on another video never overwrites it silently. */
  function rememberedJobFile() {
    if (!jobFilePath) return null;
    const first = state.clips[0];
    if (jobFileClipPath && first && first.path !== jobFileClipPath) return null;
    return jobFilePath;
  }

  /** Write the job file. `ask: true` (the Job panel button) always shows the save
   *  dialog; otherwise the remembered path is reused so a second Ctrl+S only
   *  overwrites the same file and reports it as saved. */
  async function saveJobFile({ ask = false } = {}) {
    if (!state.clips.length) return toast(t('msgAddVideo'), 'warn');
    const first = state.clips[0];
    let target = !ask ? rememberedJobFile() : null;
    if (!target) {
      const def = jobFilePath || pathJoin(CU.dirname(first.path), CU.stripExt(first.name) + '.cuci.json');
      target = await api.saveFile({ title: t('jobTitle'), defaultPath: def, filters: [{ name: t('jobTitle'), extensions: ['json'] }] });
      if (!target) return;
    }
    try {
      await api.writeText(target, JSON.stringify(buildJob(true), null, 2));
      setJobFilePath(target, first.path);
      setJobStatus(t('msgJobSaved') + ' ' + target, 'ok');
      toast(t('msgJobSaved') + ':\n' + target, 'ok', 6000);
    } catch (err) {
      // A remembered path that no longer works (drive unplugged, file moved) falls
      // back to the dialog on the next save instead of failing forever.
      if (!ask && jobFilePath) setJobFilePath(null);
      toast(t('msgJobSaveFailed') + '\n' + (err.message || err), 'error', 8000);
    }
  }

  async function openJobFile() {
    const p = await api.openFile({
      title: t('jobTitle'),
      filters: [{ name: t('jobTitle'), extensions: ['json', 'txt', 'cuci'] }, { name: t('fltAllFiles'), extensions: ['*'] }],
    });
    if (!p) return;
    try {
      const text = await api.readText(p, { maxBytes: CU.JOB_LIMITS.jsonBytes });
      // Remember the file only once the user confirms the import.
      await requestJobImport(text, ` from ${CU.basename(p)}`, p);
    } catch (err) {
      toast(t('msgJobOpenFailed') + '\n' + (err.message || err), 'error', 9000);
    }
  }

  /** Copy the share code for the current deletes. Used by the Job panel button and by
   *  the global Ctrl+C shortcut, so the code is regenerated from the live state. */
  async function copyShareCode() {
    if (!state.clips.length) return toast(t('msgAddVideo'), 'warn');
    try {
      await refreshShareCode();
    } catch (err) {
      return toast(t('msgJobSaveFailed') + '\n' + (err.message || err), 'error', 8000);
    }
    if (!els.jobCode.value) return toast(t('msgNothingShare'), 'warn');
    await api.clipboardWrite(els.jobCode.value);
    toast(t('msgShareCopied'), 'ok', 3000);
  }

  /** Ctrl+V outside a text field: import whatever share code the clipboard holds.
   *  Goes through the normal preview + confirmation prompt (untrusted input). */
  async function pasteJobCode() {
    let text = '';
    try {
      text = (await api.clipboardRead()) || '';
    } catch {
      /* ignore */
    }
    if (!text.trim()) return toast(t('msgClipboardEmpty'), 'warn');
    await requestJobImport(text.trim(), ' from clipboard');
  }

  async function pasteFromClipboard() {
    const text = await api.clipboardRead();
    if (!text || !text.trim()) return toast(t('msgClipboardEmpty'), 'warn');
    els.jobPaste.value = text.trim();
    toast(t('msgPasted'), 'ok', 2500);
  }

  /* ───────────────────────── user guide ───────────────────────── */
  function openGuide() {
    els.guideModal.classList.remove('hidden');
    els.guideClose.focus();
  }

  function closeGuide() {
    els.guideModal.classList.add('hidden');
  }

  /* ─────────────────────── product tour ─────────────────────── */
  const TOUR_KEY = 'cuci.tour';
  const LAUNCH_KEY = 'cuci.launches';
  const RATED_KEY = 'cuci.rated';
  const RATING_DELAY_MS = 5000;
  const STORE_PRODUCT_URL = 'ms-windows-store://pdp/?productid=9NSMJN6FDMV8';

  // Only what is needed to finish a job: load a video, mark the bad parts,
  // check the result, sync subtitles, export. Copy lives in the dictionaries.
  // The first entry has no target: it is the welcome card that opens the tour.
  const TOUR_STEPS = [
    { sel: null, title: 'tourWelcomeTitle', body: 'tourWelcomeBody' },
    { sel: '#btnAddVideo', title: 'tourS1Title', body: 'tourS1Body' },
    { sel: '#timelineWrap', title: 'tourS2Title', body: 'tourS2Body' },
    { sel: '#modeResult', title: 'tourS3Title', body: 'tourS3Body' },
    { sel: '#btnAddSub', title: 'tourS4Title', body: 'tourS4Body' },
    { sel: '#btnExport', title: 'tourS5Title', body: 'tourS5Body' },
  ];

  let tourIndex = 0;
  let ratingOpen = false;

  function tourVisible() {
    return !!els.tourRoot && !els.tourRoot.classList.contains('hidden');
  }

  function tourTarget(step) {
    const el = step && step.sel ? document.querySelector(step.sel) : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    if (r.right < 8 || r.bottom < 8 || r.left > window.innerWidth - 8 || r.top > window.innerHeight - 8) return null;
    return el;
  }

  function centerTourCard() {
    const card = els.tourCard;
    els.tourSpot.classList.add('hidden');
    card.style.left = `${Math.max(12, (window.innerWidth - card.offsetWidth) / 2)}px`;
    card.style.top = `${Math.max(12, (window.innerHeight - card.offsetHeight) / 2)}px`;
  }

  function placeTour(el) {
    const PAD = 6;
    const GAP = 14;
    const MARGIN = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // No clamping: the ring must sit exactly on the control even when it hugs
    // an edge, and the giant box-shadow covers the rest of the screen anyway.
    const r = el.getBoundingClientRect();
    const x = r.left - PAD;
    const y = r.top - PAD;
    const w = Math.max(24, r.width + PAD * 2);
    const h = Math.max(24, r.height + PAD * 2);
    els.tourSpot.style.left = `${x}px`;
    els.tourSpot.style.top = `${y}px`;
    els.tourSpot.style.width = `${w}px`;
    els.tourSpot.style.height = `${h}px`;
    els.tourSpot.classList.remove('hidden');

    const card = els.tourCard;
    const cardW = card.offsetWidth || 360;
    const cardH = card.offsetHeight || 170;
    let top = y + h + GAP;
    if (top + cardH > vh - MARGIN) {
      const above = y - GAP - cardH;
      top = above >= MARGIN ? above : Math.max(MARGIN, Math.min(vh - cardH - MARGIN, top));
    }
    const left = Math.max(MARGIN, Math.min(vw - cardW - MARGIN, x + w / 2 - cardW / 2));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function showTourStep() {
    if (!tourVisible()) return;
    // Skip steps whose control is not on screen (a detached pane, for example);
    // the welcome card needs no control, so it is never skipped.
    while (tourIndex < TOUR_STEPS.length) {
      const candidate = TOUR_STEPS[tourIndex];
      if (!candidate.sel || tourTarget(candidate)) break;
      tourIndex += 1;
    }
    if (tourIndex >= TOUR_STEPS.length) return endTour(true);
    const step = TOUR_STEPS[tourIndex];
    els.tourTitle.textContent = t(step.title);
    els.tourBody.textContent = t(step.body);
    els.tourBack.classList.toggle('hidden', tourIndex === 0);
    els.tourNext.textContent = t(tourIndex === TOUR_STEPS.length - 1 ? 'tourDone' : 'tourNext');
    // Without a target (the welcome card) the whole screen dims instead of a ring.
    els.tourRoot.classList.toggle('welcome', !step.sel);
    const el = tourTarget(step);
    if (el) placeTour(el);
    else centerTourCard();
    els.tourNext.focus({ preventScroll: true });
  }

  function startTour() {
    if (!els.tourRoot) return;
    tourIndex = 0;
    els.tourRoot.classList.remove('hidden');
    // The tour points at panes that may be auto-hidden; reveal them first.
    peekPane('sidebar');
    peekPane('transport');
    // Render now, not in rAF: a hidden/occluded window (tests, minimised start)
    // never fires animation frames and the card would stay empty.
    showTourStep();
    setTimeout(() => {
      if (tourVisible()) showTourStep();
    }, 150);
  }

  function endTour(remember) {
    if (!els.tourRoot) return;
    els.tourRoot.classList.add('hidden');
    els.tourSpot.classList.add('hidden');
    if (remember) {
      try {
        localStorage.setItem(TOUR_KEY, '1');
      } catch (err) {
        /* storage may be unavailable */
      }
    }
  }

  function tourNext() {
    if (tourIndex >= TOUR_STEPS.length - 1) return endTour(true);
    tourIndex += 1;
    showTourStep();
  }

  function tourBack() {
    if (tourIndex === 0) return;
    tourIndex -= 1;
    showTourStep();
  }

  /* ─────────────────────── rating prompt ─────────────────────── */
  function launchCount() {
    let n = 0;
    try {
      n = Math.max(0, Number(localStorage.getItem(LAUNCH_KEY)) || 0) + 1;
      localStorage.setItem(LAUNCH_KEY, String(n));
      return { launches: n, rated: localStorage.getItem(RATED_KEY) === '1' };
    } catch (err) {
      return { launches: n, rated: false };
    }
  }

  function tourSeen() {
    try {
      return localStorage.getItem(TOUR_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function setRateStatus(text) {
    if (!els.rateStatus) return;
    els.rateStatus.textContent = text || '';
    els.rateStatus.classList.toggle('hidden', !text);
  }

  function openRating() {
    if (ratingOpen || !els.rateModal || tourVisible()) return;
    ratingOpen = true;
    setRateStatus('');
    els.rateModal.classList.remove('hidden');
    els.rateGo.focus({ preventScroll: true });
  }

  function closeRating() {
    if (!els.rateModal) return;
    ratingOpen = false;
    els.rateModal.classList.add('hidden');
  }

  function markRated() {
    try {
      localStorage.setItem(RATED_KEY, '1');
    } catch (err) {
      /* storage may be unavailable */
    }
  }

  // Opening the Store page is not a review: the prompt keeps coming back until the
  // user says they already rated it, and the card only closes on an explicit choice.
  async function openStoreListing() {
    let res = null;
    try {
      res = api.openStoreListing ? await api.openStoreListing() : null;
    } catch (err) {
      res = null;
    }
    if (!res || !res.ok) {
      setRateStatus(tf('msgStoreFailed', { url: STORE_PRODUCT_URL }));
      return;
    }
    setRateStatus(t('msgStoreOpened'));
  }

  function onTourKey(event) {
    if (!tourVisible()) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    endTour(true);
  }

  /* ─────────────────────── launch prompts ─────────────────────── */
  function scheduleLaunchPrompts() {
    const launch = launchCount();
    if (!tourSeen()) {
      setTimeout(() => {
        if (!document.hidden && !tourSeen()) startTour();
      }, 700);
      return;
    }
    if (launch.rated) return;
    if (launch.launches % 5 !== 0) return;
    let attempts = 0;
    const ask = () => {
      if (document.hidden) return;
      // never stack the two prompts; the tour ends on its own, so just wait
      if (tourVisible()) {
        if (attempts++ < 10) setTimeout(ask, 2000);
        return;
      }
      openRating();
    };
    setTimeout(ask, RATING_DELAY_MS);
  }

  /* ─────────── job import: summary + confirmation prompt ─────────── */
  let importResolve = null;

  function closeImportConfirm(ok) {
    if (!importResolve) return;
    const resolve = importResolve;
    importResolve = null;
    els.confirmModal.classList.add('hidden');
    resolve(ok);
  }

  /**
   * Fill the confirmation dialog from an already-sanitized job. Every value is
   * written with textContent: a share code can carry arbitrary unicode, so it
   * must never reach innerHTML.
   */
  function renderImportSummary(job, matched, missing) {
    const dl = els.confirmRows;
    dl.textContent = '';
    const add = (key, value, kind) => {
      const dt = document.createElement('dt');
      dt.textContent = t(key);
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      if (kind) dd.className = kind;
      dl.append(dt, dd);
    };
    if (job.description) add('confirmDescription', job.description);
    add('confirmClips', job.clips.length);
    const deletes = job.clips.reduce((n, c) => n + c.deletes.length, 0);
    if (deletes) add('confirmDeletes', deletes);
    const tracks = job.clips.reduce((n, c) => n + (c.subtitles || []).filter((x) => x.events && x.events.length).length, 0);
    if (tracks) add('confirmSubtitles', tracks);
    add('confirmFound', `${matched} / ${job.clips.length}`);
    if (missing.length) add('confirmMissing', missing.join(', '), 'warn');
    if (job.export && job.export.container) {
      const fmt = exportFormat(job.export.container);
      add('format', `${fmt.label} · ${job.export.videoCodec} + ${fmt.audio}`);
    }
  }

  function askImportConfirm(job, matched, missing) {
    renderImportSummary(job, matched, missing);
    els.confirmModal.classList.remove('hidden');
    els.confirmOk.focus();
    return new Promise((resolve) => {
      importResolve = resolve;
    });
  }

  /** Decode → sanitize → preview → confirm → apply (never trusts the payload). */
  async function requestJobImport(text, sourceLabel, sourcePath) {
    let job;
    try {
      // parseJobText enforces the byte caps, bounded inflate and sanitizeJob.
      job = await CU.parseJobText(text);
      job = CU.sanitizeJob(job); // plain, length-capped strings only
    } catch (err) {
      toast(t('msgImportFailed') + '\n' + (err.message || err), 'error', 9000);
      return;
    }
    const used = new Set();
    let matched = 0;
    const missing = [];
    for (const entry of job.clips) {
      const clip = findClipForEntry(entry, used);
      if (clip) {
        used.add(clip.id);
        matched += 1;
      } else {
        missing.push(entry.name || '?');
      }
    }
    const ok = await askImportConfirm(job, matched, missing);
    if (!ok) return;
    const res = applyJob(job);
    // Opening a job file makes it the Ctrl+S target for this project.
    if (sourcePath) setJobFilePath(sourcePath, state.clips[0] ? state.clips[0].path : null);
    finishJobApply(res.job, res, sourceLabel);
  }

  async function importShareCode() {
    const text = (els.jobPaste.value || '').trim();
    if (!text) return toast(t('msgPasteFirst'), 'warn');
    await requestJobImport(text, ' from share code');
  }

  /** Switch the delete-job modal between its Export and Import tabs. */
  function selectJobTab(which) {
    const isExport = which !== 'import';
    els.jobTabExport.classList.toggle('active', isExport);
    els.jobTabImport.classList.toggle('active', !isExport);
    els.jobTabExport.setAttribute('aria-selected', String(isExport));
    els.jobTabImport.setAttribute('aria-selected', String(!isExport));
    els.jobPanelExport.classList.toggle('hidden', !isExport);
    els.jobPanelImport.classList.toggle('hidden', isExport);
  }

  function openJobModal() {
    setJobStatus('');
    els.jobStatus.classList.add('hidden');
    if (els.jobDesc) els.jobDesc.value = state.jobDescription || '';
    updateJobDescCount();
    selectJobTab('export');
    refreshShareCode();
    els.jobModal.classList.remove('hidden');
  }

  function closeJobModal() {
    els.jobModal.classList.add('hidden');
  }

  /* ─────────────────── NSFW scene detection ─────────────────── */
  const NSFW_MIN_INTERVAL_S = 0.25;
  const NSFW_MAX_INTERVAL_S = 60;
  const NSFW_SEC_PER_FRAME = 0.2; // ~5 frames/second of inference on a typical CPU

  function nsfwIntervalSeconds() {
    const raw = Number(els.nsfwInterval.value);
    const v = Number.isFinite(raw) && raw > 0 ? raw : 2;
    return Math.min(NSFW_MAX_INTERVAL_S, Math.max(NSFW_MIN_INTERVAL_S, v));
  }

  function updateNsfwEstimate() {
    const clip = activeClip();
    if (!clip) {
      els.nsfwEstimate.textContent = '';
      return;
    }
    const sec = nsfwIntervalSeconds();
    const frames = Math.max(1, Math.round(clip.durationMs / (sec * 1000)));
    const est = CU.fmt(frames * NSFW_SEC_PER_FRAME * 1000, 0);
    els.nsfwEstimate.textContent = tf('msgNsfwEstimate', { frames: frames.toLocaleString(), est });
  }

  async function refreshNsfwModelInfo() {
    try {
      const s = await api.nsfwStatus();
      const mb = (s.approxBytes / 1048576).toFixed(0);
      els.nsfwModelInfo.innerHTML = CU.escapeHtml(
        [
          `model   : ${s.repo}`,
          `input   : ${s.inputSize}×${s.inputSize} · labels: ${(s.labels || []).join(' / ')}`,
          `status  : ${s.installed ? t('msgNsfwInstalled') + (s.vendored ? ' ' + t('msgNsfwBundled') : '') : tf('msgNsfwWillDownload', { mb })}`,
        ].join('\n'),
      );
    } catch (err) {
      els.nsfwModelInfo.textContent = t('msgNsfwUnavailable') + ' ' + (err.message || err);
    }
  }

  async function openNsfwModal() {
    const clip = activeClip();
    if (!clip) return toast(t('msgAddVideo'), 'warn');
    if (state.nsfwScanning) return;
    els.nsfwInterval.value = String(((state.settings.nsfwIntervalMs || 2000) / 1000).toFixed(2).replace(/\.?0+$/, ''));
    els.nsfwMinDur.value = String(state.settings.nsfwMinDurationMs != null ? state.settings.nsfwMinDurationMs : 5000);
    updateNsfwEstimate();
    els.nsfwThreshold.value = String(state.settings.nsfwThreshold != null ? state.settings.nsfwThreshold : 0.3);
    els.nsfwThresholdVal.textContent = Number(els.nsfwThreshold.value).toFixed(2);
    els.nsfwResults.innerHTML = '';
    els.nsfwProgressWrap.classList.add('hidden');
    els.nsfwApply.disabled = true;
    els.nsfwApply.textContent = t('applyDeletes');
    state.nsfwSegments = [];
    els.nsfwModal.classList.remove('hidden');
    await refreshNsfwModelInfo();
  }

  function closeNsfwModal() {
    if (state.nsfwScanning) return;
    els.nsfwModal.classList.add('hidden');
  }

  async function startNsfwScan() {
    if (state.nsfwScanning) return;
    const clip = activeClip();
    if (!clip) return toast(t('msgAddVideo'), 'warn');

    const intervalMs = Math.round(nsfwIntervalSeconds() * 1000);
    els.nsfwInterval.value = String(nsfwIntervalSeconds());
    const minDurationMs = Number(els.nsfwMinDur.value) || 0;
    const threshold = Number(els.nsfwThreshold.value) || 0.3;

    // remember the choice for next time
    api.setSettings({ nsfwIntervalMs: intervalMs, nsfwMinDurationMs: minDurationMs, nsfwThreshold: threshold });
    state.settings.nsfwIntervalMs = intervalMs;
    state.settings.nsfwMinDurationMs = minDurationMs;
    state.settings.nsfwThreshold = threshold;

    state.nsfwScanning = true;
    els.nsfwStart.disabled = true;
    els.nsfwApply.disabled = true;
    els.nsfwCancel.classList.remove('hidden');
    els.nsfwClose.disabled = true;
    els.nsfwResults.innerHTML = '';
    els.nsfwProgressWrap.classList.remove('hidden');
    els.nsfwProgressBar.style.width = '0%';
    els.nsfwStatus.textContent = t('msgStarting');
    setStatus(t('msgScanning'), 'busy', { progress: 0, log: false });

    const res = await api.nsfwScan({ videoPath: clip.path, durationMs: clip.durationMs, intervalMs, threshold, minDurationMs });

    state.nsfwScanning = false;
    els.nsfwStart.disabled = false;
    els.nsfwCancel.classList.add('hidden');
    els.nsfwClose.disabled = false;

    if (!res.ok) {
      els.nsfwStatus.textContent = t('msgFailed');
      setStatus(t('msgNsfwFailed'), 'error');
      toast(t('msgNsfwFailed') + ':\n' + (res.error || t('msgUnknownError')), 'error', 10000);
      return;
    }
    state.nsfwSegments = res.segments || [];
    renderNsfwResults(res);
    if (res.cancelled) setStatus(t('msgNsfwCancelled'), 'warn');
    else if (state.nsfwSegments.length) setStatus(tf('msgNsfwDetected', { n: state.nsfwSegments.length }), 'warn');
    else setStatus(t('msgNsfwNoScenes'), 'ok', { timeout: 4000 });
  }

  function renderNsfwResults(res) {
    els.nsfwProgressBar.style.width = '100%';
    const clip = activeClip();
    els.nsfwStatus.textContent = tf('msgNsfwAnalyzed', { frames: res.scannedFrames, positives: res.positives });
    els.nsfwResults.innerHTML = '';

    if (!state.nsfwSegments.length) {
      els.nsfwResults.innerHTML = `<div class="nsfw-none">${CU.escapeHtml(tf('msgNsfwNoneAbove', { t: Number(res.threshold).toFixed(2) }))}</div>`;
      return;
    }

    const total = state.nsfwSegments.reduce((a, s) => a + (s.end - s.start), 0);
    const pct = clip ? ((total / clip.durationMs) * 100).toFixed(2) : '0';
    const head = document.createElement('div');
    head.className = 'job-info';
    head.textContent = tf('msgNsfwSummary', { n: state.nsfwSegments.length, a: CU.fmt(total, 3), b: CU.fmt(clip ? clip.durationMs : 0, 3), p: pct });
    els.nsfwResults.appendChild(head);

    for (const seg of state.nsfwSegments) {
      const row = document.createElement('div');
      row.className = 'nsfw-hit';
      row.innerHTML =
        `<span class="hit-time">${CU.fmt(seg.start, 3)} → ${CU.fmt(seg.end, 3)}</span>` +
        `<span>${CU.fmt(seg.end - seg.start, 3)}</span>` +
        `<span class="hit-score">${(seg.maxScore * 100).toFixed(1)}%</span>`;
      els.nsfwResults.appendChild(row);
    }
    els.nsfwApply.disabled = false;
    els.nsfwApply.textContent = tf('msgNsfwApplyN', { n: state.nsfwSegments.length });
  }

  /** Add the given ranges as deletes on the active clip. Returns how many were added. */
  function applyNsfwSegments(segments) {
    const clip = activeClip();
    if (!clip || !Array.isArray(segments) || !segments.length) return 0;
    pushUndo();
    let added = 0;
    for (const seg of segments) {
      const s = CU.clamp(Number(seg.start) || 0, 0, clip.durationMs);
      const e = CU.clamp(Number(seg.end) || 0, 0, clip.durationMs);
      if (e - s < 1) continue;
      clip.deletes.push({ id: CU.uid('delete'), start: s, end: e });
      added += 1;
    }
    normalizeDeletes(clip);
    state.selection = null;
    invalidate();
    renderAll();
    return added;
  }

  function applyNsfwDeletes() {
    const n = applyNsfwSegments(state.nsfwSegments);
    if (!n) return toast(t('msgNsfwNone'), 'warn');
    setStatus(tf('msgNsfwMarked', { n }), 'ok', { timeout: 4500 });
    toast(tf('msgNsfwMarked', { n }), 'ok');
    closeNsfwModal();
  }

  /* ───────────────────────────── export ───────────────────────────── */
  /* Export formats — keep in sync with lib/formats.js (the main process muxes). */
  const EXPORT_FORMATS = {
    mp4: {
      label: 'MP4',
      ext: 'mp4',
      audio: 'AAC',
      video: [
        ['libx264', 'H.264 · x264 (CPU)'],
        ['h264_nvenc', 'H.264 · NVENC (GPU)'],
        ['libx265', 'H.265 · x265 (CPU)'],
        ['hevc_nvenc', 'H.265 · NVENC (GPU)'],
      ],
      defaultVideo: 'libx264',
    },
    mov: {
      label: 'MOV',
      ext: 'mov',
      audio: 'AAC',
      video: [
        ['libx264', 'H.264 · x264 (CPU)'],
        ['h264_nvenc', 'H.264 · NVENC (GPU)'],
        ['libx265', 'H.265 · x265 (CPU)'],
        ['hevc_nvenc', 'H.265 · NVENC (GPU)'],
      ],
      defaultVideo: 'libx264',
    },
    mkv: {
      label: 'MKV',
      ext: 'mkv',
      audio: 'AAC',
      video: [
        ['libx264', 'H.264 · x264 (CPU)'],
        ['h264_nvenc', 'H.264 · NVENC (GPU)'],
        ['libx265', 'H.265 · x265 (CPU)'],
        ['hevc_nvenc', 'H.265 · NVENC (GPU)'],
      ],
      defaultVideo: 'libx264',
    },
    webm: { label: 'WebM', ext: 'webm', audio: 'Opus', video: [['libvpx-vp9', 'VP9 · libvpx (CPU)']], defaultVideo: 'libvpx-vp9' },
    avi: { label: 'AVI', ext: 'avi', audio: 'MP3', video: [['mpeg4', 'MPEG-4 part 2 (CPU)']], defaultVideo: 'mpeg4' },
    wmv: { label: 'WMV', ext: 'wmv', audio: 'WMA', video: [['wmv2', 'WMV2 (CPU)']], defaultVideo: 'wmv2' },
    flv: { label: 'FLV', ext: 'flv', audio: 'AAC', video: [['libx264', 'H.264 · x264 (CPU)']], defaultVideo: 'libx264' },
    ts: { label: 'MPEG-TS', ext: 'ts', audio: 'AAC', video: [['libx264', 'H.264 · x264 (CPU)']], defaultVideo: 'libx264' },
  };
  const exportFormat = (name) => (Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, name) ? EXPORT_FORMATS[name] : EXPORT_FORMATS.mp4);

  /** Rebuild the codec list for the selected format (keeps the old choice when valid). */
  function refillCodecOptions(preferred) {
    const fmt = exportFormat(els.expContainer.value);
    const prev = preferred || els.expVcodec.value;
    const keep = fmt.video.some(([v]) => v === prev) ? prev : fmt.defaultVideo;
    els.expVcodec.innerHTML = '';
    for (const [value, label] of fmt.video) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      els.expVcodec.appendChild(opt);
    }
    els.expVcodec.value = keep;
  }

  function codecLabel() {
    const opt = els.expVcodec.options[els.expVcodec.selectedIndex];
    return (opt && opt.textContent) || els.expVcodec.value || 'H.264';
  }

  function currentSetup() {
    const { ranges, total } = programRanges();
    const first = state.clips[0];
    const res = els.expRes.value;
    let width = first ? first.width : 1920;
    let height = first ? first.height : 1080;
    if (res !== 'source') {
      height = parseInt(res, 10);
      const aspect = first && first.height ? first.width / first.height : 16 / 9;
      width = Math.round(height * aspect);
    }
    width = even(width);
    height = even(height);
    const fpsSel = els.expFps.value;
    const fps = fpsSel === 'source' ? (first && first.fps) || 25 : parseFloat(fpsSel);
    const tracks = remapAllTracks().filter((t) => t.events.length);
    const subs = tracks.reduce((acc, t) => acc.concat(t.events), []);
    return { ranges, total, width, height, fps, tracks, subs };
  }

  function refreshBurnTrackOptions(tracks) {
    const sel = els.expBurnTrack;
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const t of tracks) {
      const opt = document.createElement('option');
      opt.value = t.trackId;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
    if (prev && tracks.some((t) => t.trackId === prev)) sel.value = prev;
    sel.disabled = !tracks.length;
    const wrap = sel.closest('.burn-track');
    if (wrap) wrap.classList.toggle('hidden', !els.expBurn.checked || !tracks.length);
  }

  // Guards against accidentally exporting the full source when the user meant
  // to delete something: the first click arms, the second confirms.
  let exportConfirmArmed = false;

  function resetExportConfirm() {
    exportConfirmArmed = false;
    els.expStart.classList.remove('armed');
    if (!state.exporting) els.expStart.textContent = t('startExport');
  }

  function updateExportSummary() {
    const { ranges, total, width, height, fps, tracks, subs } = currentSetup();
    const completed = state.clips.reduce((a, c) => a + c.durationMs, 0);
    const removed = Math.max(0, completed - total);
    const noDeletes = removed < 1;
    const fmt = exportFormat(els.expContainer.value);
    const lines = [
      `${t('confirmClips')}: ${state.clips.length}`,
      `${t('sumSegments')}: ${ranges.length}`,
      `${t('sumSource')}: ${CU.fmt(completed, 3)}`,
      `${t('sumOutput')}: ${CU.fmt(total, 3)}`,
      `${t('sumRemoved')}: ${CU.fmt(removed, 3)}`,
      `${t('sumVideo')}: ${width}×${height} @ ${Number(fps).toFixed(3)} fps`,
      `${t('format')}: ${fmt.label} · ${codecLabel()} + ${fmt.audio} · ${els.expAbitrate.value}`,
      `${t('sumSubtitles')}: ${tracks.length} · ${subs.length}`,
    ];
    let html = lines
      .map((l) => {
        const i = l.indexOf(': ');
        return i > 0 ? `<b>${CU.escapeHtml(l.slice(0, i))}</b>: ${CU.escapeHtml(l.slice(i + 2))}` : CU.escapeHtml(l);
      })
      .join('\n');
    if (noDeletes) {
      html += '\n\n<b style="color:var(--warn)">⚠ ' + CU.escapeHtml(t('msgNoDeletesSummary')) + '</b>';
    }
    els.expSummary.innerHTML = html;
    refreshBurnTrackOptions(tracks);
    els.expStart.disabled = ranges.length === 0;
    resetExportConfirm();
  }

  function defaultOutputPath() {
    const first = state.clips[0];
    if (!first) return '';
    const dir = CU.dirname(first.path);
    return pathJoin(dir, CU.stripExt(first.name) + '.delete.' + exportFormat(els.expContainer.value).ext);
  }

  function openExportModal() {
    if (!state.clips.length) return toast(t('msgAddVideo'), 'warn');
    pause();
    if (!els.expPath.value) els.expPath.value = defaultOutputPath();
    updateExportSummary();
    els.exportModal.classList.remove('hidden');
  }

  function closeExportModal() {
    if (state.exporting) return;
    els.exportModal.classList.add('hidden');
  }

  async function startExport() {
    if (state.exporting) return;
    const outputPath = els.expPath.value.trim();
    if (!outputPath) return toast(t('msgChooseOutput'), 'warn');

    const { ranges, total, width, height, fps, tracks, subs } = currentSetup();
    if (!ranges.length) return toast(t('msgNothingExport'), 'warn');

    const completed = state.clips.reduce((a, c) => a + c.durationMs, 0);
    const removed = Math.max(0, completed - total);
    if (removed < 1 && !exportConfirmArmed) {
      exportConfirmArmed = true;
      els.expStart.classList.add('armed');
      els.expStart.textContent = t('expArm');
      toast(t('msgNoDeletesConfirm'), 'warn', 7000);
      return;
    }
    resetExportConfirm();

    const burnTrack = tracks.find((t) => t.trackId === els.expBurnTrack.value) || tracks[0] || null;
    const burn = els.expBurn.checked && !!burnTrack;
    if (els.expBurn.checked && !burnTrack) toast(t('msgNoSubsBurn'), 'warn');

    // Write one synced .srt per enabled track next to the output.
    if (els.expSrt.checked && tracks.length) {
      const dir = CU.dirname(outputPath);
      const base = CU.stripExt(CU.basename(outputPath));
      const multi = tracks.length > 1;
      try {
        for (const t of tracks) {
          const suffix = multi ? '.' + safeFileSuffix(t.name) : '';
          await api.writeText(pathJoin(dir, base + suffix + '.srt'), CU.serializeSrt(t.events));
        }
        toast(tf('msgSrtWritten', { n: tracks.length }), 'ok', 6000);
      } catch (err) {
        toast(t('msgFailedSave') + '\n' + (err.message || err), 'error');
      }
    }

    const segments = ranges.map((r) => {
      const clip = state.clips.find((c) => c.id === r.clipId);
      return { path: clip.path, start: r.srcStart, end: r.srcEnd, hasAudio: clip.hasAudio };
    });

    const req = {
      outputPath,
      container: els.expContainer.value,
      segments,
      width,
      height,
      fps,
      videoCodec: els.expVcodec.value,
      crf: Number(els.expCrf.value),
      preset: els.expPreset.value,
      audioBitrate: els.expAbitrate.value,
      burnSubtitles: burn,
      subtitleSrt: burn && burnTrack ? CU.serializeSrt(burnTrack.events) : '',
    };

    state.exporting = true;
    els.expStart.disabled = true;
    els.expCancel.classList.remove('hidden');
    els.expClose.disabled = true;
    els.expProgressWrap.classList.remove('hidden');
    els.expProgressBar.style.width = '0%';
    els.expStatus.textContent = t('msgExpStarting');

    const started = Date.now();
    const result = await api.exportVideo(req);
    state.exporting = false;
    els.expCancel.classList.add('hidden');
    els.expClose.disabled = false;

    if (result.ok) {
      els.expProgressBar.style.width = '100%';
      els.expStatus.textContent = t('msgDone');
      setStatus(t('msgExportDone') + ': ' + CU.basename(result.outputPath), 'ok', { timeout: 9000 });
      const close = toast(t('msgExportDone') + ':\n' + result.outputPath, 'ok', 0);
      const el = els.toasts.lastElementChild;
      if (el) {
        const openBtn = document.createElement('button');
        openBtn.className = 'btn tiny';
        openBtn.textContent = t('msgOpenFolder');
        openBtn.style.marginTop = '8px';
        openBtn.addEventListener('click', () => api.showItem(result.outputPath));
        el.querySelector('.t-body').appendChild(document.createElement('br'));
        el.querySelector('.t-body').appendChild(openBtn);
      }
      updateExportSummary();
    } else if (result.cancelled) {
      els.expStatus.textContent = t('msgCancelled');
      setStatus(t('msgExportCancelled'), 'warn');
      toast(t('msgExportCancelled'), 'warn');
    } else {
      els.expStatus.textContent = t('msgFailed');
      setStatus(t('msgExportFailed'), 'error');
      toast(t('msgExportFailed') + ':\n' + (result.error || t('msgUnknownError')), 'error', 12000);
    }
    els.expStart.disabled = false;
  }

  /* ───────────────────────────── ffmpeg / settings ───────────────────────────── */
  const SOURCE_KEY = { custom: 'srcCustom', env: 'srcEnv', system: 'srcSystem', bundled: 'srcBundled', sibling: 'srcSibling', missing: 'srcMissing' };
  const sourceLabel = (src) => t(SOURCE_KEY[src] || 'srcMissing');

  /** ffmpeg/ffprobe/bundled rows for the settings page (translated labels). */
  function renderToolStatus(info) {
    const b = info.bundled || {};
    els.setStatus.textContent = '';
    const row = (label, value, cls) => {
      const el = document.createElement('div');
      el.className = 'ff-row';
      const k = document.createElement('span');
      k.className = 'ff-k';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'ff-v' + (cls ? ' ' + cls : '');
      v.textContent = value;
      el.append(k, v);
      els.setStatus.appendChild(el);
    };
    const one = (label, tool) => {
      if (!tool || !tool.ok) return row(label, t('stNotFound'), 'bad');
      const meta = `${tool.version || '?'}${tool.libass ? ' · libass' : ''} · ${sourceLabel(tool.source)}`;
      row(label, `${tool.path || ''}\n${meta}`, 'ok');
    };
    one('ffmpeg', info.ffmpeg);
    one('ffprobe', info.ffprobe);
    row(t('stBundled'), b.present ? t('stInstalled') : t('stNotInstalled'), b.present ? 'ok' : 'bad');
  }

  /* ───────────── settings: applied immediately, no Save button ───────────── */
  let settingsTimer = null;
  let savedTimer = null;

  function flashSaved() {
    if (!els.setSaved) return;
    els.setSaved.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => els.setSaved.classList.remove('show'), 1600);
  }

  function persistSettings() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(
      async () => {
        try {
          await api.setSettings({
            ffmpegPath: els.setFfmpeg.value.trim(),
            ffprobePath: els.setFfprobe.value.trim(),
            loadThumbs: els.setLoadThumbs.checked,
            preferBundled: els.setPreferBundled.checked,
            theme: els.setTheme.value,
            language: els.setLanguage.value,
          });
          flashSaved();
          await refreshInfo();
        } catch (err) {
          toast(t('msgFailedSave') + '\n' + (err.message || err), 'error', 7000);
        }
      },
      150,
    );
  }

  /** Switch UI language (and re-render the strings this renderer owns). */
  function applyLanguage(preferred, opts = {}) {
    const lang = CU.i18n.apply(preferred || 'auto');
    if (els.setLanguage) CU.i18n.fillSelect(els.setLanguage, preferred || 'auto');
    if (opts.silent) return lang;
    renderAll();
    updateTransport();
    updateIoReadout();
    if (!els.exportModal.classList.contains('hidden')) updateExportSummary();
    sendMenuState();
    if (!statusState.text || statusState.text === t('ready') || statusState.text === 'Ready') {
      setStatus(t(state.clips.length ? 'ready' : 'readyHint'), 'idle', { log: false });
    }
    return lang;
  }

  async function refreshInfo() {
    const info = await api.getInfo();
    state.info = info;
    state.settings = { loadThumbs: false, preferBundled: false, ...(info.settings || {}) };

    if (info.ffmpeg.ok) {
      // Healthy ffmpeg stays silent: the chip is only a problem indicator, so it
      // is hidden unless resolution fails (details live in Settings).
      const shortVer = String(info.ffmpeg.version || '?').split(/[-_\s]/)[0];
      els.ffStatus.className = 'ff-status ok';
      els.ffStatus.textContent = `ffmpeg ✓ ${shortVer} · ${sourceLabel(info.ffmpeg.source)}`;
      els.ffStatus.title = `${info.ffmpeg.version}\n${info.ffmpeg.path}${info.ffmpeg.libass ? '\nlibass' : ''}`;
      els.ffStatus.hidden = true;
    } else {
      els.ffStatus.hidden = false;
      els.ffStatus.className = 'ff-status bad';
      els.ffStatus.textContent = `ffmpeg ✗ ${t('stNotFound')}`;
      els.ffStatus.title = info.ffmpeg.error || t('stNotFound');
      setStatus(t('msgFfmpegMissing'), 'error');
    }

    els.setFfmpeg.value = info.settings.ffmpegPath || '';
    els.setFfprobe.value = info.settings.ffprobePath || '';
    els.setPreferBundled.checked = !!state.settings.preferBundled;
    els.setLoadThumbs.checked = !!state.settings.loadThumbs;
    // Apply the stored appearance once; later refreshes must not undo a choice
    // the user just made in the (auto-applied) settings dialog.
    if (!appearanceApplied) {
      applyTheme(state.settings.theme || storedTheme());
      applyLanguage(state.settings.language || 'auto', { silent: true });
      appearanceApplied = true;
    }

    renderToolStatus(info);
    return info;
  }

  function openSettings() {
    refreshInfo();
    els.settingsModal.classList.remove('hidden');
  }

  /* ───────────────────────────── wiring ───────────────────────────── */
  /* ────────────── workspace layout: pin (auto-hide) / detach ───────── */
  /*
   * Each pane carries a flat [pin][detach] pair in its own header:
   *   pinned   → docked and always visible (the default)
   *   unpinned → auto-hidden; moving the pointer over the player fades in a
   *              chevron handle that opens a temporary *peek* (a slide-over
   *              drawer). A peek is not a pin: it closes again when the pointer
   *              leaves, unless the user clicks the pin button.
   *   detached → the pane moves into its own OS window (src/panel.html). The
   *              timeline belongs to the control center, so both travel
   *              together and the timeline is rendered inside that window.
   *
   * Windowed panels are thin views: this renderer stays the source of truth and
   * pushes snapshots (`pushPanelState` / `pushPanelTimeline`) while the panels
   * send back commands (`onPanelCommand`). See lib/panels.js.
   */
  const PANEL_NAMES = ['sidebar', 'timeline', 'transport'];
  const PANEL_LABEL = { sidebar: 'Side panel', timeline: 'Timeline', transport: 'Control center' };
  const PANEL_EL = { sidebar: 'sidebar', timeline: 'timelineWrap', transport: 'transportBar' };
  const WINDOWED_PANELS = new Set(['sidebar', 'transport']);
  const openPanels = { sidebar: false, transport: false };
  panelThemeSync = true;
  let sidebarSyncTimer = null;
  let transportSyncTimer = null;
  let timelineSyncTimer = null;
  let revealTimer = null;
  let peekHideTimer = null;
  let autoHideHintShown = false;
  const peeking = { sidebar: false, transport: false };

  function defaultLayout() {
    const one = () => ({ pinned: true, detached: false });
    return { sidebar: one(), timeline: one(), transport: one() };
  }

  const panelEl = (name) => els[PANEL_EL[name]] || null;

  /* The timeline belongs to the control center: it is pinned/hidden/detached
     with it and rendered inside the control center window when detached. */
  function paneState(name) {
    const src = name === 'timeline' ? layout.transport : layout[name];
    return { pinned: src.pinned, detached: src.detached };
  }

  function loadLayout() {
    layout = defaultLayout();
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('cuci.layout') || 'null');
    } catch {
      saved = null;
    }
    if (!saved || typeof saved !== 'object') return;
    for (const name of PANEL_NAMES) {
      const st = saved[name];
      if (!st || typeof st !== 'object') continue;
      // `hidden` is the pre-pin field name; keep reading it for old profiles.
      if (typeof st.pinned === 'boolean') layout[name].pinned = st.pinned;
      else if (st.hidden === true) layout[name].pinned = false;
      layout[name].detached = st.detached === true;
    }
    for (const name of PANEL_NAMES) if (layout[name].detached) layout[name].pinned = true;
  }

  function saveLayout() {
    try {
      localStorage.setItem(
        'cuci.layout',
        JSON.stringify({
          sidebar: { pinned: layout.sidebar.pinned, detached: layout.sidebar.detached },
          transport: { pinned: layout.transport.pinned, detached: layout.transport.detached },
        }),
      );
    } catch {
      /* ignore */
    }
  }

  /* Chrome measurements used by the peek drawers (they sit between the topbar
     and the status bar and stack above each other). */
  function measureChrome() {
    const topbar = document.querySelector('.topbar');
    const top = topbar ? Math.round(topbar.getBoundingClientRect().height) : 54;
    const status = els.statusbar ? Math.round(els.statusbar.getBoundingClientRect().height) : 27;
    document.documentElement.style.setProperty('--topbar-h', top + 'px');
    document.documentElement.style.setProperty('--status-h', status + 'px');
    if (peeking.transport && els.transportBar) {
      const h = Math.round(els.transportBar.getBoundingClientRect().height) || 96;
      document.documentElement.style.setProperty('--transport-h', h + 'px');
    }
  }

  function applyLayout() {
    if (!layout) return;
    for (const name of PANEL_NAMES) {
      const st = paneState(name);
      const el = panelEl(name);
      if (!el) continue;
      const peeked = !st.pinned && !st.detached && (name === 'timeline' ? peeking.transport : peeking[name]);
      document.body.classList.toggle('hide-' + name, !st.pinned && !peeked);
      document.body.classList.toggle('peek-' + name, peeked);
      document.body.classList.toggle('detach-' + name, st.detached);
    }

    setPinButton(els.btnPinSidebar, layout.sidebar.pinned, 'side panel');
    setPinButton(els.btnPinTransport, layout.transport.pinned, 'control center and timeline');
    setDetachButton(els.btnDetachSidebar, layout.sidebar.detached, 'side panel', 'Ctrl+Shift+1');
    setDetachButton(els.btnDetachTransport, layout.transport.detached, 'control center', 'Ctrl+Shift+2');

    // Chevron handles only for panes that are auto-hidden (detached panes are
    // already on screen, in their own window).
    const needSide = !layout.sidebar.pinned;
    const needControls = !layout.transport.pinned;
    els.btnRevealSidebar.classList.toggle('hidden', !needSide);
    els.btnRevealTransport.classList.toggle('hidden', !needControls);
    if (!needSide && !needControls) els.revealBar.classList.remove('visible');
    sendMenuState();
  }

  function setPinButton(btn, pinned, label) {
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(!!pinned));
    btn.title = pinned ? `Pinned — click to auto-hide the ${label}` : `Auto-hidden — click to pin the ${label} back`;
  }

  function setDetachButton(btn, detached, label, keys) {
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(!!detached));
    btn.title = detached
      ? `Detached to its own window — click to bring the ${label} back (${keys})`
      : `Detach the ${label} into its own window (${keys})`;
  }

  function afterLayoutChange() {
    measureChrome();
    renderTimeline();
    applyTimelineHeight(false);
  }

  /* ───────────────────────── peek drawers ───────────────────────── */
  function anyPeeked() {
    return peeking.sidebar || peeking.transport;
  }

  function peekPane(name) {
    if (name === 'timeline') name = 'transport';
    const st = paneState(name);
    if (!st || st.pinned || st.detached || peeking[name]) return;
    peeking[name] = true;
    applyLayout();
    afterLayoutChange();
    requestAnimationFrame(measureChrome);
  }

  function closePeek(name) {
    if (name === 'timeline') name = 'transport';
    if (!peeking[name]) return;
    peeking[name] = false;
    applyLayout();
    afterLayoutChange();
  }

  function closeAllPeeks() {
    if (!anyPeeked()) return;
    peeking.sidebar = false;
    peeking.transport = false;
    applyLayout();
    afterLayoutChange();
  }

  function pointerOverPeek(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return !!(target.closest('#sidebar') || target.closest('#transportBar') || target.closest('#timelineWrap') || target.closest('#revealBar'));
  }

  function wirePeek() {
    // Fade the reveal handles in while the pointer moves over the player.
    if (els.playerWrap) {
      els.playerWrap.addEventListener('pointermove', () => {
        if (layout.sidebar.pinned && layout.transport.pinned) return;
        els.revealBar.classList.add('visible');
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => els.revealBar.classList.remove('visible'), 2200);
      });
      els.playerWrap.addEventListener('pointerleave', () => {
        clearTimeout(revealTimer);
        els.revealBar.classList.remove('visible');
      });
    }

    // Opening a peek: the chevrons never pin — pinning is an explicit gesture.
    if (els.btnRevealSidebar) els.btnRevealSidebar.addEventListener('click', () => peekPane('sidebar'));
    if (els.btnRevealTransport) els.btnRevealTransport.addEventListener('click', () => peekPane('transport'));

    // A peek closes when the pointer leaves it, when the player is clicked, or
    // on Escape. Never while a mouse button is held (drag inside the drawer).
    let pointerDown = false;
    let pointerOver = false;
    const schedulePeekClose = () => {
      clearTimeout(peekHideTimer);
      peekHideTimer = setTimeout(() => {
        if (pointerDown || pointerOver) return;
        closeAllPeeks();
      }, 260);
    };
    document.addEventListener('pointerdown', (e) => {
      pointerDown = true;
      if (!anyPeeked() || pointerOverPeek(e.target)) return;
      closeAllPeeks();
    }, true);
    document.addEventListener('pointerup', (e) => {
      pointerDown = false;
      if (!anyPeeked()) return;
      pointerOver = pointerOverPeek(e.target);
      if (!pointerOver) schedulePeekClose();
    }, true);
    document.addEventListener('pointermove', (e) => {
      if (!anyPeeked()) return;
      clearTimeout(peekHideTimer);
      pointerOver = pointerOverPeek(e.target);
      if (!pointerOver) schedulePeekClose();
    });
    window.addEventListener('blur', closeAllPeeks);
  }

  /* ───────────────── pin / detach ───────────────── */
  async function setPanelPinned(name, pinned) {
    if (name === 'timeline') return setPanelPinned('transport', pinned); // sticky
    const st = layout[name];
    if (!st || st.pinned === pinned) return;
    st.pinned = pinned;
    peeking[name] = false;
    if (!pinned && st.detached) {
      // Unpinning a windowed pane brings it back out of the window first.
      st.detached = false;
      if (WINDOWED_PANELS.has(name) && openPanels[name]) await api.panelClose(name);
    }
    applyLayout();
    afterLayoutChange();
    saveLayout();
    pushPanelState(name);
    if (!pinned && !autoHideHintShown) {
      autoHideHintShown = true;
      toast(t('msgAutoHidden'), 'info', 3800);
    }
  }

  async function setPanelDetached(name, detached) {
    if (name === 'timeline') return setPanelDetached('transport', detached); // sticky
    const st = layout[name];
    const el = panelEl(name);
    if (!st || !el || st.detached === detached) return;
    peeking[name] = false;
    if (detached) {
      st.pinned = true; // detaching implies visible
      if (WINDOWED_PANELS.has(name)) {
        const res = await api.panelOpen({ name, theme: resolveTheme(themeMode) });
        if (!res || !res.ok) {
          toast((res && res.error) || t('msgPanelOpenFailed'), 'error');
          return;
        }
        openPanels[name] = true;
        st.detached = true;
      } else {
        st.detached = true;
      }
    } else {
      st.detached = false;
      st.pinned = true;
      if (WINDOWED_PANELS.has(name) && openPanels[name]) await api.panelClose(name);
    }
    applyLayout();
    afterLayoutChange();
    saveLayout();
    pushPanelState(name);
    if (name === 'transport') pushPanelTimeline();
  }

  /* ───────── panel windows: state snapshots + commands ───────── */
  function sidebarSnapshot() {
    const clip = activeClip();
    const deletes = clip ? [...clip.deletes].sort((a, b) => a.start - b.start) : [];
    const tracks = (clip && clip.subtitles) || [];
    const active = clip ? activeSubtitleTrack(clip) : null;
    let rows = [];
    let eventCount = 0;
    let dropped = 0;
    if (active) {
      const all = buildSubRows(active.events, keptRanges(clip), state.globalSubOffset);
      eventCount = all.length;
      dropped = all.reduce((n, r) => n + (r.dropped ? 1 : 0), 0);
      rows = all.slice(0, 400).map((r) => ({
        start: r.ev.start,
        text: r.ev.text,
        dropped: !!r.dropped,
        newStarts: r.dropped ? [] : r.parts.map((p) => p.start),
      }));
    }
    return {
      lang: CU.i18n.current(),
      theme: resolveTheme(themeMode),
      clips: state.clips.map((c) => ({
        id: c.id,
        name: c.name,
        path: c.path,
        durationMs: c.durationMs,
        width: c.width,
        height: c.height,
        fps: c.fps,
        hasAudio: c.hasAudio,
        kept: totalKept(c),
        subCount: (c.subtitles || []).length,
        hasProxy: !!c.proxyPath,
        deletes: c.deletes.length,
      })),
      activeClipId: state.activeClipId,
      clipName: clip ? clip.name : null,
      deletes: deletes.map((c) => ({ id: c.id, start: c.start, end: c.end })),
      sub: {
        tracks: tracks.map((t) => ({
          id: t.id,
          name: t.name,
          enabled: t.enabled !== false,
          kept: remapTrack(clip, t).length,
          total: t.events.length,
          active: !!active && t.id === active.id,
        })),
        activeName: active ? active.name : null,
        activeEnabled: active ? active.enabled !== false : false,
        eventCount,
        dropped,
        rows,
        offset: state.globalSubOffset,
        canExport: state.clips.some((c) => (c.subtitles || []).length),
      },
    };
  }

  function transportSnapshot() {
    const clip = activeClip();
    const total = state.playMode === 'result' ? programRanges().total : clip ? clip.durationMs : 0;
    const cur = state.playMode === 'result' ? state.resultTime : clip ? state.playhead : 0;
    return {
      lang: CU.i18n.current(),
      theme: resolveTheme(themeMode),
      clipName: clip ? clip.name : null,
      hasClip: !!clip,
      time: clip ? state.playhead : 0,
      total: clip ? clip.durationMs : 0,
      mode: state.playMode,
      resultTime: state.resultTime,
      resultTotal: programRanges().total,
      playing: !els.video.paused && (state.playMode === 'source' || program.playing),
      seekValue: total > 0 ? Math.round((cur / total) * 10000) : 0,
      snap: !!state.snap,
      zoom: state.zoom,
      inPoint: state.inPoint,
      outPoint: state.outPoint,
      selection: state.selection && state.selection.clipId === state.activeClipId
        ? { start: state.selection.start, end: state.selection.end }
        : null,
    };
  }

  /* Slower, structural payload for the timeline that lives in the control
     center window (deletes, subtitle blocks, filmstrip). */
  function timelineSnapshot() {
    const clip = activeClip();
    if (!clip) return { durationMs: 0, fps: 30, deletes: [], subs: [], thumbs: null };
    const ranges = keptRanges(clip);
    const track = activeSubtitleTrack(clip);
    let subs = [];
    if (track) {
      const dropped = new Set(CU.droppedEvents(track.events, ranges));
      subs = track.events.slice(0, 1500).map((ev) => ({
        start: ev.start,
        end: ev.end,
        text: ev.text.replace(/\s*\n\s*/g, ' '),
        dropped: dropped.has(ev),
      }));
    }
    const thumbs =
      clip.thumbs && clip.thumbs.files && clip.thumbs.files.length
        ? { dir: clip.thumbs.dir, files: clip.thumbs.files, stepMs: clip.thumbs.stepMs || 1000 }
        : null;
    return {
      durationMs: clip.durationMs,
      fps: clip.fps || 30,
      deletes: [...clip.deletes].sort((a, b) => a.start - b.start).map((c) => ({ id: c.id, start: c.start, end: c.end })),
      subs,
      thumbs,
    };
  }

  function pushPanelState(name) {
    if (!openPanels[name]) return;
    try {
      api.sendPanelState({ panel: name, kind: 'main', data: name === 'sidebar' ? sidebarSnapshot() : transportSnapshot() });
    } catch {
      /* ignore */
    }
  }

  function pushPanelTimeline() {
    if (!openPanels.transport) return;
    try {
      api.sendPanelState({ panel: 'transport', kind: 'timeline', data: timelineSnapshot() });
    } catch {
      /* ignore */
    }
  }

  function scheduleSidebarSync() {
    if (!openPanels.sidebar || sidebarSyncTimer) return;
    sidebarSyncTimer = setTimeout(() => {
      sidebarSyncTimer = null;
      pushPanelState('sidebar');
    }, 40);
  }

  function scheduleTransportSync() {
    if (!openPanels.transport || transportSyncTimer) return;
    transportSyncTimer = setTimeout(() => {
      transportSyncTimer = null;
      pushPanelState('transport');
    }, 60);
  }

  function scheduleTimelineSync() {
    if (!openPanels.transport || timelineSyncTimer) return;
    timelineSyncTimer = setTimeout(() => {
      timelineSyncTimer = null;
      pushPanelTimeline();
    }, 120);
  }

  function onPanelReady(payload) {
    const name = payload && payload.panel;
    if (!WINDOWED_PANELS.has(name) || !layout) return;
    // The ready handshake can beat the panelOpen() reply in the renderer, so
    // adopt the detached state here too.
    openPanels[name] = true;
    if (!layout[name].detached) {
      layout[name].detached = true;
      layout[name].pinned = true;
      applyLayout();
      afterLayoutChange();
      saveLayout();
    }
    pushPanelState(name);
    if (name === 'transport') pushPanelTimeline();
  }

  function onPanelClosed(payload) {
    const name = payload && payload.panel;
    if (!name) return;
    openPanels[name] = false;
    const st = layout[name];
    if (!st || !st.detached) return;
    // The window was closed from its title bar: dock the panel back in.
    st.detached = false;
    st.pinned = true;
    applyLayout();
    afterLayoutChange();
    saveLayout();
    toast(tf('msgPanelDocked', { name: t(name === 'transport' ? 'controlCenter' : 'sidePanel') }), 'info', 2400);
  }

  const PANEL_CLICK_IDS = new Set([
    'btnStop', 'btnPrevSec', 'btnPrevFrame', 'btnPlay', 'btnNextFrame', 'btnNextSec',
    'btnSetIn', 'btnSetOut', 'btnDelete', 'btnClearMarks', 'btnClearDeletes',
    'modeSource', 'modeResult', 'btnSubAdd', 'btnSubExport',
    'btnJob', 'btnNsfw', 'btnSidebarAddSub', 'btnSidebarAddVideo',
  ]);

  async function onPanelCommand(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.action !== 'string') return;
    const action = msg.action;
    if (action === 'click') {
      const id = String(msg.id || '');
      if (!PANEL_CLICK_IDS.has(id)) return;
      const el = els[id];
      if (el && typeof el.click === 'function') el.click();
      return;
    }
    if (action === 'seek') {
      els.seekRange.value = String(Math.max(0, Math.min(10000, Math.round(Number(msg.value) || 0))));
      els.seekRange.dispatchEvent(new Event('input'));
      return;
    }
    if (action === 'zoom') {
      els.zoomRange.value = String(Math.max(1, Math.min(12, Number(msg.value) || 1)));
      els.zoomRange.dispatchEvent(new Event('input'));
      return;
    }
    if (action === 'snap') {
      els.chkSnap.checked = !!msg.value;
      els.chkSnap.dispatchEvent(new Event('change'));
      return;
    }
    if (action === 'activate') {
      const clip = state.clips.find((c) => c.id === msg.clipId);
      if (clip) await activateClip(clip.id);
      return;
    }
    if (action === 'clip') {
      const act = String(msg.act || '');
      if (!['up', 'down', 'sub', 'remove'].includes(act)) return;
      if (!state.clips.some((c) => c.id === msg.clipId)) return;
      await handleClipAction(act, msg.clipId);
      return;
    }
    if (action === 'deleteRemove' || action === 'deleteHover') {
      const clip = activeClip();
      if (!clip || !clip.deletes.some((c) => c.id === msg.deleteId)) return;
      if (action === 'deleteRemove') removeDelete(msg.deleteId);
      else highlightDelete(msg.deleteId, !!msg.on);
      return;
    }
    if (action === 'seekTo') {
      pause();
      seekTo(Number(msg.ms) || 0);
      return;
    }
    // ── timeline gestures coming from the detached control center window
    if (action === 'select') {
      const clip = activeClip();
      if (!clip) return;
      const a = Math.max(0, Math.min(clip.durationMs, Number(msg.start) || 0));
      const b = Math.max(0, Math.min(clip.durationMs, Number(msg.end) || 0));
      state.selection = b - a > 1 ? { clipId: clip.id, start: Math.min(a, b), end: Math.max(a, b) } : null;
      renderOverlays();
      updateTransport();
      return;
    }
    if (action === 'mark') {
      const clip = activeClip();
      if (!clip) return;
      const ms = snapMs(Number(msg.ms) || 0);
      if (state.inPoint == null || state.outPoint != null) {
        state.inPoint = ms;
        state.outPoint = null;
      } else {
        state.outPoint = Math.max(ms, state.inPoint);
      }
      renderOverlays();
      updateIoReadout();
      updateTransport();
      return;
    }
    if (action === 'subOffset') {
      state.globalSubOffset = Number(msg.ms) || 0;
      invalidate();
      updateSubPanel();
      renderTimeline();
      updateSubtitleOverlay();
      return;
    }
    if (action === 'subToggle' || action === 'subActivate' || action === 'subRemove') {
      const clip = activeClip();
      const track = clip && (clip.subtitles || []).find((t) => t.id === msg.trackId);
      if (!clip || !track) return;
      if (action === 'subToggle') {
        track.enabled = !!msg.enabled;
        invalidate();
        renderAll();
      } else if (action === 'subActivate') {
        clip.activeSubtitleId = track.id;
        renderAll();
      } else {
        pushUndo();
        clip.subtitles = clip.subtitles.filter((t) => t.id !== track.id);
        if (clip.activeSubtitleId === track.id) clip.activeSubtitleId = clip.subtitles[0] ? clip.subtitles[0].id : null;
        invalidate();
        renderAll();
      }
    }
  }

  /* Re-open panels that were detached to their own window last session. */
  async function restorePanelWindows() {
    for (const name of WINDOWED_PANELS) {
      if (!layout[name].detached || openPanels[name]) continue;
      const res = await api.panelOpen({ name, theme: resolveTheme(themeMode) });
      if (res && res.ok) {
        openPanels[name] = true;
        pushPanelState(name);
        if (name === 'transport') pushPanelTimeline();
      } else {
        layout[name].detached = false;
        layout[name].pinned = true;
        applyLayout();
        afterLayoutChange();
        saveLayout();
      }
    }
  }

  /* ─────────────── native menu: commands + state sync ─────────────── */
  let menuStateTimer = null;

  /** Tell the main process which menu items should be checked. */
  function sendMenuState() {
    clearTimeout(menuStateTimer);
    menuStateTimer = setTimeout(() => {
      try {
        api.setMenuState({
          snap: !!state.snap,
          mode: state.playMode,
          pinned: { sidebar: layout.sidebar.pinned, transport: layout.transport.pinned },
          detached: { sidebar: layout.sidebar.detached, transport: layout.transport.detached },
          theme: themeMode,
          language: CU.i18n.stored(),
          resolvedLanguage: CU.i18n.current(),
        });
      } catch {
        /* ignore */
      }
    }, 40);
  }

  function bumpZoom(delta) {
    const next = Math.max(1, Math.min(12, Math.round((state.zoom + delta) * 10) / 10));
    els.zoomRange.value = String(next);
    els.zoomRange.dispatchEvent(new Event('input'));
  }

  /** Actions coming from the application menu (File / Edit / View / Help). */
  async function onMenuCommand(action) {
    if (typeof action !== 'string') return;
    if (action.startsWith('theme:')) {
      const value = action.slice(6);
      applyTheme(value);
      if (els.setTheme) els.setTheme.value = themeMode;
      persistSettings();
    } else if (action.startsWith('lang:')) {
      const value = action.slice(5);
      applyLanguage(value === 'auto' ? 'auto' : value);
      persistSettings();
    } else {
      switch (action) {
        case 'add-video': els.btnAddVideo.click(); break;
        case 'add-subtitle': els.btnAddSub.click(); break;
        case 'export': els.btnExport.click(); break;
        case 'save-job': await saveJobFile(); break;
        case 'open-job': await openJobFile(); break;
        case 'settings': openSettings(); break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
        case 'set-in': els.btnSetIn.click(); break;
        case 'set-out': els.btnSetOut.click(); break;
        case 'delete': els.btnDelete.click(); break;
        case 'clear-marks': els.btnClearMarks.click(); break;
        case 'clear-deletes': els.btnClearDeletes.click(); break;
        case 'mode-source': els.modeSource.click(); break;
        case 'mode-result': els.modeResult.click(); break;
        case 'toggle-snap':
          els.chkSnap.checked = !els.chkSnap.checked;
          els.chkSnap.dispatchEvent(new Event('change'));
          break;
        case 'zoom-in': bumpZoom(0.5); break;
        case 'zoom-out': bumpZoom(-0.5); break;
        case 'pin-sidebar': setPanelPinned('sidebar', !layout.sidebar.pinned); break;
        case 'pin-transport': setPanelPinned('transport', !layout.transport.pinned); break;
        case 'detach-sidebar': setPanelDetached('sidebar', !layout.sidebar.detached); break;
        case 'detach-transport': setPanelDetached('transport', !layout.transport.detached); break;
        case 'guide':
        case 'guide-shortcuts': openGuide(); break;
        default: break;
      }
    }
    sendMenuState();
  }

  /* Flat [pin][detach] pair in each pane header + the peek handles. */
  function wireLayout() {
    const bindPin = (btn, name) => {
      if (!btn) return;
      btn.addEventListener('click', () => setPanelPinned(name, !layout[name].pinned));
    };
    const bindDetach = (btn, name) => {
      if (!btn) return;
      btn.addEventListener('click', () => setPanelDetached(name, !layout[name].detached));
    };
    bindPin(els.btnPinSidebar, 'sidebar');
    bindPin(els.btnPinTransport, 'transport');
    bindDetach(els.btnDetachSidebar, 'sidebar');
    bindDetach(els.btnDetachTransport, 'transport');
    wirePeek();
  }

  /* ─────────────────── player / timeline splitter ─────────────────── */
  let timelineHeight = 260;

  function applyTimelineHeight(persist) {
    if (!els.mainPane || !els.transportBar) return;
    const transportH = els.transportBar.getBoundingClientRect().height || 90;
    const min = 140;
    const playerMin = 120;
    const max = Math.max(min, els.mainPane.clientHeight - transportH - playerMin);
    const h = Math.round(Math.max(min, Math.min(max, timelineHeight)));
    document.documentElement.style.setProperty('--timeline-h', h + 'px');
    if (persist) {
      try {
        localStorage.setItem('cuci.timelineHeight', String(h));
      } catch {
        /* ignore */
      }
    }
  }

  function wireSplitter() {
    const handle = els.playerSplitter;
    if (!handle) return;
    let splitDrag = null;

    const start = (e) => {
      if (e.button !== 0) return;
      if (!layout.transport.pinned || layout.transport.detached) return;
      splitDrag = { startY: e.clientY, startH: els.timelineWrap.getBoundingClientRect().height };
      handle.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      e.preventDefault();
    };
    const move = (e) => {
      if (!splitDrag) return;
      // Dragging down grows the player and shrinks the timeline (and vice versa).
      timelineHeight = splitDrag.startH - (e.clientY - splitDrag.startY);
      applyTimelineHeight(false);
    };
    const end = () => {
      if (!splitDrag) return;
      splitDrag = null;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      applyTimelineHeight(true);
    };

    handle.addEventListener('pointerdown', start);
    // The bar's empty background doubles as a drag handle.
    els.transportBar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, label, .player-splitter, .io-readout')) return;
      start(e);
    });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    // Double-click the splitter to restore the default height.
    handle.addEventListener('dblclick', () => {
      timelineHeight = 260;
      applyTimelineHeight(true);
    });
  }

  function wire() {
    wireSubEventsToggle();
    els.btnAddVideo.addEventListener('click', async () => addVideos(await api.openVideos()));
    els.btnAddVideo2.addEventListener('click', async () => addVideos(await api.openVideos()));
    // Sidebar quick actions mirror the topbar buttons.
    els.btnSidebarAddSub.addEventListener('click', () => els.btnAddSub.click());
    els.btnSidebarAddVideo.addEventListener('click', () => els.btnAddVideo.click());

    els.btnAddSub.addEventListener('click', async () => {
      const clip = activeClip();
      if (!clip) return toast(t('msgAddVideo'), 'warn');
      await addSubtitleToClip(clip);
    });

    els.btnExport.addEventListener('click', openExportModal);
    els.btnSettings.addEventListener('click', openSettings);
    els.btnGuide.addEventListener('click', openGuide);
    els.guideClose.addEventListener('click', closeGuide);
    els.guideClose2.addEventListener('click', closeGuide);
    els.guideTour.addEventListener('click', () => {
      closeGuide();
      startTour();
    });

    // Product tour
    els.tourSkip.addEventListener('click', () => endTour(true));
    els.tourNext.addEventListener('click', tourNext);
    els.tourBack.addEventListener('click', tourBack);
    document.addEventListener('keydown', onTourKey, true);
    window.addEventListener('resize', () => {
      if (tourVisible()) showTourStep();
    });
    document.addEventListener('cuci:lang', () => {
      if (tourVisible()) showTourStep();
    });

    // Rating prompt
    els.rateGo.addEventListener('click', () => openStoreListing());
    els.rateDone.addEventListener('click', () => {
      markRated();
      closeRating();
    });
    els.rateLater.addEventListener('click', closeRating);
    els.rateClose.addEventListener('click', closeRating);
    // Deliberately no backdrop/Escape dismissal: the prompt is a decision, not a
    // dialog you can wave away, and only X / Maybe later / already-rated close it.
    els.confirmOk.addEventListener('click', () => closeImportConfirm(true));
    els.confirmCancel.addEventListener('click', () => closeImportConfirm(false));
    els.confirmClose.addEventListener('click', () => closeImportConfirm(false));
    els.btnJob.addEventListener('click', openJobModal);
    els.jobTabExport.addEventListener('click', () => selectJobTab('export'));
    els.jobTabImport.addEventListener('click', () => selectJobTab('import'));
    els.btnNsfw.addEventListener('click', openNsfwModal);
    els.nsfwClose.addEventListener('click', closeNsfwModal);
    els.nsfwClose2.addEventListener('click', closeNsfwModal);
    els.nsfwStart.addEventListener('click', startNsfwScan);
    els.nsfwApply.addEventListener('click', applyNsfwDeletes);
    els.nsfwCancel.addEventListener('click', async () => {
      await api.nsfwCancel();
      els.nsfwStatus.textContent = t('msgCancelling');
    });
    els.nsfwThreshold.addEventListener('input', () => {
      els.nsfwThresholdVal.textContent = Number(els.nsfwThreshold.value).toFixed(2);
    });
    els.nsfwInterval.addEventListener('input', updateNsfwEstimate);
    els.nsfwInterval.addEventListener('change', () => {
      els.nsfwInterval.value = String(nsfwIntervalSeconds());
      updateNsfwEstimate();
    });
    els.jobClose.addEventListener('click', closeJobModal);
    els.jobClose2.addEventListener('click', closeJobModal);
    els.jobSave.addEventListener('click', () => saveJobFile({ ask: true }));
    els.jobOpen.addEventListener('click', openJobFile);
    els.jobCopy.addEventListener('click', copyShareCode);
    els.jobRefresh.addEventListener('click', refreshShareCode);
    els.jobIncludeSubs.addEventListener('change', refreshShareCode);
    els.jobDesc.addEventListener('input', () => {
      state.jobDescription = els.jobDesc.value.slice(0, 200);
      updateJobDescCount();
      scheduleShareCodeRefresh();
    });
    els.jobImport.addEventListener('click', importShareCode);
    els.jobPasteClip.addEventListener('click', pasteFromClipboard);
    els.ffStatus.addEventListener('click', openSettings);

    els.btnPlay.addEventListener('click', togglePlay);
    els.btnStop.addEventListener('click', () => {
      pause();
      seekTo(0);
    });
    els.btnPrevFrame.addEventListener('click', () => {
      pause();
      seekTo(state.playhead - frameMs());
    });
    els.btnNextFrame.addEventListener('click', () => {
      pause();
      seekTo(state.playhead + frameMs());
    });
    els.btnPrevSec.addEventListener('click', () => {
      pause();
      seekTo(state.playhead - 1000);
    });
    els.btnNextSec.addEventListener('click', () => {
      pause();
      seekTo(state.playhead + 1000);
    });

    els.btnSetIn.addEventListener('click', () => {
      state.inPoint = snapMs(state.playhead);
      renderOverlays();
      updateIoReadout();
    });
    els.btnSetOut.addEventListener('click', () => {
      state.outPoint = snapMs(state.playhead);
      renderOverlays();
      updateIoReadout();
    });
    els.btnDelete.addEventListener('click', deleteSelection);
    els.btnClearMarks.addEventListener('click', clearMarks);
    els.btnClearDeletes.addEventListener('click', clearDeletes);

    els.modeSource.addEventListener('click', async () => {
      pause();
      state.playMode = 'source';
      state.selection = null;
      updateModeUI();
      const clip = activeClip();
      if (clip) {
        await ensureVideoFor(clip);
        await seekVideo(state.playhead);
      }
      renderTimeline();
      updateSubtitleOverlay();
    });
    els.modeResult.addEventListener('click', async () => {
      pause();
      state.playMode = 'result';
      updateModeUI();
      state.resultTime = 0;
      renderTimeline();
      updateSubtitleOverlay();
      await programPlay(0);
    });

    els.seekRange.addEventListener('pointerdown', () => {
      state.scrubbing = true;
      pause();
    });
    window.addEventListener('pointerup', () => {
      if (state.scrubbing) {
        state.scrubbing = false;
        updateTransport();
      }
    });
    els.seekRange.addEventListener('input', () => {
      const frac = Number(els.seekRange.value) / 10000;
      if (state.playMode === 'result') seekResult(frac * programRanges().total);
      else {
        const clip = activeClip();
        if (clip) seekTo(frac * clip.durationMs);
      }
    });

    els.chkSnap.addEventListener('change', () => {
      state.snap = els.chkSnap.checked;
      sendMenuState();
    });
    els.zoomRange.addEventListener('input', () => {
      state.zoom = parseFloat(els.zoomRange.value) || 1;
      const center = state.playhead / (activeClip() ? activeClip().durationMs : 1);
      renderTimeline();
      els.timelineScroll.scrollLeft = Math.max(0, center * state.pxPerMs - els.timelineScroll.clientWidth / 2);
      scheduleTransportSync(); // the detached window re-renders its timeline at the new zoom
    });

    els.subOffset.addEventListener('input', () => {
      state.globalSubOffset = Number(els.subOffset.value) || 0;
      invalidate();
      updateSubPanel();
      renderTimeline();
      updateSubtitleOverlay();
    });

    els.btnSubAdd.addEventListener('click', async () => {
      const clip = activeClip();
      if (!clip) return toast(t('msgAddVideo'), 'warn');
      await addSubtitleToClip(clip);
    });

    els.btnSubExport.addEventListener('click', async () => {
      const tracks = remapAllTracks().filter((t) => t.events.length);
      if (!tracks.length) return toast(t('msgNoSubsExport'), 'warn');
      const first = state.clips[0];
      const def = pathJoin(CU.dirname(first.path), CU.stripExt(first.name) + '.synced.srt');
      const p = await api.saveFile({ title: 'Save synced subtitles', defaultPath: def, filters: [{ name: 'SubRip', extensions: ['srt'] }] });
      if (!p) return;
      try {
        const dir = CU.dirname(p);
        const base = CU.stripExt(CU.basename(p));
        const multi = tracks.length > 1;
        for (const t of tracks) {
          const out = multi ? pathJoin(dir, base + '.' + safeFileSuffix(t.name) + '.srt') : p;
          await api.writeText(out, CU.serializeSrt(t.events));
        }
        toast(tf('msgSubsSaved', { n: tracks.length }) + (multi ? ' ' + dir : ''), 'ok', 6000);
      } catch (err) {
        toast(t('msgFailedSave') + '\n' + (err.message || err), 'error');
      }
    });

    // timeline pointer handling
    els.timeline.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    // right-click context menu for the delete tools
    els.timeline.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const clip = activeClip();
      if (!clip || state.exporting) return;
      const deleteEl = e.target.closest('.tl-delete');
      showContextMenu(e.clientX, e.clientY, xToMs(e.clientX), deleteEl ? deleteEl.dataset.deleteId : null);
    });
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!els.ctxMenu.classList.contains('hidden') && !els.ctxMenu.contains(e.target)) hideContextMenu();
      },
      true,
    );
    els.timelineScroll.addEventListener('scroll', hideContextMenu);
    window.addEventListener('blur', hideContextMenu);
    els.tlDeletes.addEventListener('dblclick', (e) => {
      const deleteEl = e.target.closest('.tl-delete');
      if (deleteEl) removeDelete(deleteEl.dataset.deleteId);
    });

    // Double-click: markers are removed, ruler/filmstrip sets In then Out.
    els.timeline.addEventListener('dblclick', (e) => {
      if (e.target.closest('#tlMarkerIn')) {
        state.inPoint = null;
        renderOverlays();
        updateIoReadout();
        setStatus(t('msgInCleared'), 'info', { timeout: 2000 });
        return;
      }
      if (e.target.closest('#tlMarkerOut')) {
        state.outPoint = null;
        renderOverlays();
        updateIoReadout();
        setStatus(t('msgOutCleared'), 'info', { timeout: 2000 });
        return;
      }
      if (e.target.closest('.tl-delete')) return; // the delete handler removes the delete
      if (e.target.closest('#tlRuler') || e.target.closest('#tlFilm')) applyDoubleClickMark(snapMs(xToMs(e.clientX)));
    });

    // video events
    els.video.addEventListener('timeupdate', () => {
      const clip = activeClip();
      if (!clip) return;
      const t = els.video.currentTime * 1000;
      if (state.playMode === 'result' && program.playing) {
        const r = program.ranges[program.idx];
        if (!r) return;
        if (t >= r.srcEnd - 25) {
          if (program.idx < program.ranges.length - 1) {
            program.idx++;
            state.resultTime = program.ranges[program.idx].outStart;
            state.playhead = program.ranges[program.idx].srcStart;
            playProgramRange();
          } else {
            program.playing = false;
            els.video.pause();
            state.resultTime = r.outEnd;
            state.playhead = r.srcEnd;
            postTick(true);
          }
          return;
        }
        state.playhead = t;
        state.resultTime = r.outStart + (t - r.srcStart);
      } else {
        state.playhead = t;
      }
      postTick(!els.video.paused);
    });
    els.video.addEventListener('play', updateTransport);
    els.video.addEventListener('pause', updateTransport);
    els.video.addEventListener('error', () => {
      const clip = activeClip();
      if (!clip) return;
      els.playerNoticeText.textContent = tf('msgPlayerNotice', { name: clip.name, codec: clip.videoCodec || t('errUnknownCodec') });
      els.playerNotice.classList.remove('hidden');
    });

    els.btnMakeProxy.addEventListener('click', async () => {
      const clip = activeClip();
      if (!clip) return;
      els.playerNotice.classList.add('hidden');
      const close = toast(t('msgProxyGenerating'), 'info', 0);
      setStatus(tf('msgProxyFor', { name: clip.name }), 'busy', { log: false });
      try {
        clip.proxyPath = await api.proxy(clip.path);
        videoFile = null;
        close();
        const ok = await ensureVideoFor(clip);
        if (ok) {
          await seekVideo(state.playhead);
          els.playerNotice.classList.add('hidden');
          updateClipList();
          setStatus(t('msgProxyReady'), 'ok', { timeout: 4000 });
          toast(t('msgProxyReady'), 'ok');
        } else {
          setStatus(t('msgProxyFailed'), 'error');
          toast(t('msgProxyFailed'), 'error');
        }
      } catch (err) {
        close();
        setStatus(tf('msgProxyFailedFor', { name: clip.name }), 'error');
        toast(t('msgProxyFailed') + ':\n' + (err.message || err), 'error', 9000);
      }
    });
    els.btnDismissNotice.addEventListener('click', () => els.playerNotice.classList.add('hidden'));

    // export modal
    els.expClose.addEventListener('click', closeExportModal);
    els.expClose2.addEventListener('click', closeExportModal);
    els.expBrowse.addEventListener('click', async () => {
      const fmt = exportFormat(els.expContainer.value);
      const filters = [
        { name: `${fmt.label} video`, extensions: [fmt.ext] },
        { name: 'All files', extensions: ['*'] },
      ];
      const p = await api.saveFile({ title: t('export'), defaultPath: els.expPath.value || defaultOutputPath(), filters });
      if (p) {
        els.expPath.value = p;
        updateExportSummary();
      }
    });
    ['expContainer', 'expVcodec', 'expCrf', 'expPreset', 'expRes', 'expFps', 'expAbitrate', 'expBurn', 'expSrt'].forEach((id) => {
      els[id].addEventListener('input', () => {
        if (id === 'expCrf') els.expCrfVal.textContent = els.expCrf.value;
        updateExportSummary();
      });
    });
    els.expContainer.addEventListener('change', () => {
      const fmt = exportFormat(els.expContainer.value);
      const cur = els.expPath.value;
      if (cur) els.expPath.value = cur.replace(/\.[^./\\]+$/, '.' + fmt.ext);
      refillCodecOptions();
      updateExportSummary();
    });
    els.expStart.addEventListener('click', startExport);
    els.expCancel.addEventListener('click', async () => {
      await api.cancelExport();
      els.expStatus.textContent = t('msgCancelling');
      // Cancel also stops background thumbnail/proxy ffmpeg jobs; rebuild them.
      setTimeout(retryMissingThumbs, 600);
    });

    // settings
    els.setClose.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
    els.setClose2.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
    els.setTheme.addEventListener('change', () => {
      applyTheme(els.setTheme.value);
      persistSettings();
    });
    els.setLanguage.addEventListener('change', () => {
      applyLanguage(els.setLanguage.value);
      persistSettings();
    });
    els.setLoadThumbs.addEventListener('change', () => {
      state.settings.loadThumbs = els.setLoadThumbs.checked;
      applyThumbSetting();
      persistSettings();
    });
    els.setPreferBundled.addEventListener('change', () => persistSettings());
    els.setFfmpeg.addEventListener('change', () => persistSettings());
    els.setFfprobe.addEventListener('change', () => persistSettings());
    els.setDetect.addEventListener('click', () => refreshInfo());

    const pickBinary = async (input) => {
      const p = await api.openFile({
        title: t('dlgExecutable'),
        filters: [{ name: t('dlgExecutable'), extensions: ['exe'] }, { name: t('fltAllFiles'), extensions: ['*'] }],
      });
      if (p) input.value = p;
    };
    els.setFfmpegBrowse.addEventListener('click', () => pickBinary(els.setFfmpeg));
    els.setFfprobeBrowse.addEventListener('click', () => pickBinary(els.setFfprobe));
    els.setUseBundled.addEventListener('click', () => {
      const b = (state.info && state.info.bundled) || {};
      if (!b.ffmpeg) return toast(t('msgNoBundledPath'), 'warn');
      els.setFfmpeg.value = b.ffmpeg;
      els.setFfprobe.value = b.ffprobe || '';
      els.setPreferBundled.checked = true;
      persistSettings();
      toast(t('msgBundledFilled'), 'info', 3000);
    });

    // keyboard
    window.addEventListener('keydown', onKeyDown);
    wireLayout();

    // native application menu
    api.onMenuCommand(onMenuCommand);

    // detached panel windows (side panel / control center)
    api.onPanelReady(onPanelReady);
    api.onPanelClosed(onPanelClosed);
    api.onPanelCommand(onPanelCommand);

    // export progress
    api.onExportProgress((d) => {
      if (!state.exporting) return;
      els.expProgressBar.style.width = d.percent.toFixed(1) + '%';
      let eta = '';
      const sp = parseFloat(String(d.speed || '').replace('x', ''));
      if (sp > 0.01 && d.totalSec > d.timeSec) {
        const secs = (d.totalSec - d.timeSec) / sp;
        eta = ` · ETA ${CU.fmt(secs * 1000, 0)}`;
      }
      els.expStatus.textContent = `${d.percent.toFixed(1)}% · ${CU.fmt(d.timeSec * 1000, 1)} / ${CU.fmt(d.totalSec * 1000, 1)}${sp ? ` · ${sp.toFixed(2)}x` : ''}${eta}`;
      setStatus(`${t('msgExporting')} ${d.percent.toFixed(0)}%${eta}`, 'busy', { progress: d.percent / 100, log: false });
    });

    // NSFW scan progress
    api.onNsfwProgress((p) => {
      if (!state.nsfwScanning) return;
      const pct = p.percent != null ? p.percent : 0;
      els.nsfwProgressBar.style.width = pct.toFixed(1) + '%';
      els.nsfwStatus.textContent = p.message || p.phase;
      setStatus(p.phase === 'download' ? p.message : t('msgScanning'), 'busy', { progress: pct / 100, log: false });
    });

    // keyframe snapshot progress
    api.onThumbsProgress((d) => {
      thumbJobs.set(d.path, Math.max(0, Math.min(99, d.percent || 0)));
      const vals = [...thumbJobs.values()];
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      setStatus(`${t('msgThumbsLoading')} ${Math.round(avg)}%`, 'busy', { progress: avg / 100, log: false });
    });

    // status bar: click for history, dismiss errors/warnings
    els.statusbar.addEventListener('click', (e) => {
      if (e.target === els.statusClear) return;
      toggleStatusLog();
    });
    els.statusClear.addEventListener('click', (e) => {
      e.stopPropagation();
      hideStatusLog();
      setStatus(t('ready'), 'idle');
    });
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!els.statusLog.classList.contains('hidden') && !els.statusLog.contains(e.target) && !els.statusbar.contains(e.target)) {
          hideStatusLog();
        }
      },
      true,
    );
    window.addEventListener('blur', hideStatusLog);

    // window resize
    let rzTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => {
        measureChrome();
        applyLayout();
        renderTimeline();
        applyTimelineHeight(false);
      }, 120);
    });

    // Release the media pipeline before the window is destroyed. Chromium can
    // otherwise log "ffmpeg_common.cc ... Unsupported pixel format: -1" while
    // tearing down a still-active <video> decoder — harmless, but noisy.
    const releaseVideo = () => {
      try {
        const v = els.video;
        if (!v) return;
        program.playing = false;
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('beforeunload', releaseVideo);
    window.addEventListener('pagehide', releaseVideo);

    // empty-state add button is wired above
  }

  function postTick(scroll) {
    renderOverlays();
    updateTransport();
    updateSubtitleOverlay();
    if (scroll) scrollPlayheadIntoView();
  }

  function onKeyDown(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Escape' && anyPeeked()) {
      closeAllPeeks();
      return;
    }
    if (e.key === 'Escape' && !els.statusLog.classList.contains('hidden')) {
      hideStatusLog();
      return;
    }
    if (e.key === 'Escape' && !els.ctxMenu.classList.contains('hidden')) {
      hideContextMenu();
      return;
    }
    if (e.key === 'F1') {
      e.preventDefault();
      if (els.guideModal.classList.contains('hidden')) openGuide();
      else closeGuide();
      return;
    }
    if (!els.confirmModal.classList.contains('hidden')) {
      if (e.key === 'Escape') closeImportConfirm(false);
      return;
    }
    if (!els.guideModal.classList.contains('hidden')) {
      if (e.key === 'Escape') closeGuide();
      return;
    }
    if (!els.exportModal.classList.contains('hidden')) {
      if (e.key === 'Escape' && !state.exporting) closeExportModal();
      return;
    }
    if (!els.settingsModal.classList.contains('hidden')) {
      if (e.key === 'Escape') els.settingsModal.classList.add('hidden');
      return;
    }
    if (!els.jobModal.classList.contains('hidden')) {
      if (e.key === 'Escape') closeJobModal();
      return;
    }
    if (!els.nsfwModal.classList.contains('hidden')) {
      if (e.key === 'Escape') closeNsfwModal();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }

    // Job shortcuts. Ctrl+S keeps its native-menu accelerator (File ▸ Save job
    // file); Ctrl+C / Ctrl+V are handled here only when the focus is not a text
    // field (see the early return above), so editing still copies/pastes text.
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copyShareCode();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      pasteJobCode();
      return;
    }

    if (mod && /^Digit[12]$/.test(e.code)) {
      e.preventDefault();
      const name = e.code === 'Digit1' ? 'sidebar' : 'transport';
      if (e.shiftKey) setPanelDetached(name, !layout[name].detached);
      else setPanelPinned(name, !layout[name].pinned);
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        pause();
        seekTo(state.playhead - (e.shiftKey ? 1000 : frameMs()));
        break;
      case 'ArrowRight':
        e.preventDefault();
        pause();
        seekTo(state.playhead + (e.shiftKey ? 1000 : frameMs()));
        break;
      case 'i':
      case 'I':
        state.inPoint = snapMs(state.playhead);
        renderOverlays();
        updateIoReadout();
        break;
      case 'o':
      case 'O':
        state.outPoint = snapMs(state.playhead);
        renderOverlays();
        updateIoReadout();
        break;
      case 'x':
      case 'X':
        deleteSelection();
        break;
      case 'Home':
        pause();
        seekTo(0);
        break;
      case 'End': {
        const c = activeClip();
        if (c) {
          pause();
          seekTo(c.durationMs);
        }
        break;
      }
      case '+':
      case '=':
        els.zoomRange.value = String(Math.min(12, state.zoom + 0.5));
        els.zoomRange.dispatchEvent(new Event('input'));
        break;
      case '-':
      case '_':
        els.zoomRange.value = String(Math.max(1, state.zoom - 0.5));
        els.zoomRange.dispatchEvent(new Event('input'));
        break;
      default:
        break;
    }
  }

  /* ───────────────────────────── boot ───────────────────────────── */
  async function init() {
    cacheEls();
    try {
      subEventsOpen = localStorage.getItem(SUB_EVENTS_KEY) === '1';
    } catch {
      subEventsOpen = false;
    }
    try {
      jobFilePath = localStorage.getItem(JOB_FILE_KEY) || null;
    } catch {
      jobFilePath = null;
    }
    if (jobFilePath) {
      try {
        const rec = JSON.parse(jobFilePath);
        jobFilePath = rec && rec.path ? rec.path : null;
        jobFileClipPath = rec && rec.clip ? rec.clip : null;
      } catch {
        jobFileClipPath = null; // legacy/plain string entry
      }
    }
    refillCodecOptions();
    loadLayout();
    try {
      const saved = Number(localStorage.getItem('cuci.timelineHeight'));
      if (Number.isFinite(saved) && saved >= 140) timelineHeight = saved;
    } catch {
      /* ignore */
    }
    wire();
    wireSplitter();
    applyLayout();
    renderStatus();
    await refreshInfo();
    renderAll();
    requestAnimationFrame(() => {
      measureChrome();
      applyLayout();
      applyTimelineHeight(false);
    });
    restorePanelWindows();
    sendMenuState();
    if (!statusState.text || statusState.text === 'Ready' || statusState.text === t('ready')) {
      setStatus(t('readyHint'), 'idle', { log: false });
    }

    // Debug / automation handle (also used by lib/e2e.js).
    window.__cuciApp = {
      state,
      api,
      CU,
      addVideos,
      addSubtitleToClip,
      loadSubtitleFromPath,
      keptRanges,
      programRanges,
      remapAll,
      remapAllTracks,
      applyThumbSetting,
      applyNsfwSegments,
      buildJob,
      applyJob,
      encodeShareCode: CU.encodeShareCode,
      decodeShareCode: CU.decodeShareCode,
      addDelete,
      removeDelete,
      renderAll,
      seekTo,
      currentSetup,
      setPanelPinned,
      setPanelDetached,
      startTour,
      endTour,
      tourVisible,
      tourStep: () => ({ index: tourIndex, total: TOUR_STEPS.length }),
      openRating,
      closeRating,
      markRated,
    };

    scheduleLaunchPrompts();
  }

  window.addEventListener('DOMContentLoaded', init);
})();
