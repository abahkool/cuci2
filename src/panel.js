/* CUCI2 detached panel renderer — thin view over the main window's state. */
(function () {
  const panelAPI = window.panelAPI;
  const CU = window.CUCI;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const NAME = params.get('panel') === 'transport' ? 'transport' : 'sidebar';
  const TITLES = { sidebar: 'Side panel', transport: 'Control center' };

  let last = null;

  /* Send a user intent to the main window (the single source of truth). */
  function send(action, extra) {
    try {
      panelAPI.send(action, extra);
    } catch {
      /* ignore */
    }
  }

  /* ───────────────────────── control center ───────────────────────── */
  const TRANSPORT_CLICKS = [
    'btnStop',
    'btnPrevSec',
    'btnPrevFrame',
    'btnPlay',
    'btnNextFrame',
    'btnNextSec',
    'btnSetIn',
    'btnSetOut',
    'btnCut',
    'btnClearMarks',
    'btnClearCuts',
    'modeSource',
    'modeResult',
  ];

  function wireTransport() {
    TRANSPORT_CLICKS.forEach((id) => $(id).addEventListener('click', () => send('click', { id })));
    $('seekRange').addEventListener('input', () => send('seek', { value: Number($('seekRange').value) }));
    $('chkSnap').addEventListener('change', () => send('snap', { value: $('chkSnap').checked }));
    $('zoomRange').addEventListener('input', () => send('zoom', { value: Number($('zoomRange').value) }));
  }

  function renderIo(t) {
    const fmt = (v) => (v == null ? '—' : CU.fmt(v, 3));
    let extra = '';
    if (t.inPoint != null && t.outPoint != null && t.outPoint > t.inPoint) {
      extra = ` · sel ${CU.fmt(t.outPoint - t.inPoint, 3)}`;
    }
    $('ioReadout').innerHTML = `In <b>${fmt(t.inPoint)}</b> · Out <b>${fmt(t.outPoint)}</b>${extra}`;
  }

  function renderTransport(t) {
    $('timecode').textContent = CU.fmt(t.time, 3);
    $('timeTotal').textContent = CU.fmt(t.total, 3);
    const tc = $('resultTc');
    tc.classList.toggle('hidden', t.mode !== 'result');
    if (t.mode === 'result') tc.textContent = `result ${CU.fmt(t.resultTime, 3)} / ${CU.fmt(t.resultTotal, 3)}`;
    $('btnPlay').textContent = t.playing ? '❚❚' : '▶';

    const seek = $('seekRange');
    if (document.activeElement !== seek && Number(seek.value) !== t.seekValue) seek.value = String(t.seekValue);
    const zoom = $('zoomRange');
    if (document.activeElement !== zoom && Math.abs(Number(zoom.value) - t.zoom) > 0.001) zoom.value = String(t.zoom);
    const snap = $('chkSnap');
    if (snap.checked !== !!t.snap) snap.checked = !!t.snap;

    $('modeSource').classList.toggle('active', t.mode === 'source');
    $('modeResult').classList.toggle('active', t.mode === 'result');
    $('btnPlay').disabled = !t.hasClip;
    $('btnCut').disabled = !t.hasClip;
    $('btnClearCuts').disabled = !t.hasClip;
    renderIo(t);
    $('panelStatus').textContent = t.clipName || 'No media';
  }

  /* ───────────────────────── side panel ───────────────────────── */
  function wireSidebar() {
    $('btnSubAdd').addEventListener('click', () => send('click', { id: 'btnSubAdd' }));
    $('btnSubExport').addEventListener('click', () => send('click', { id: 'btnSubExport' }));
    $('subOffset').addEventListener('input', () => send('subOffset', { ms: Number($('subOffset').value) || 0 }));
  }

  function renderClipList(s) {
    $('clipCount').textContent = String(s.clips.length);
    const list = $('clipList');
    list.innerHTML = '';
    if (!s.clips.length) {
      list.innerHTML = '<div class="sub-info">No media loaded yet.</div>';
      return;
    }
    s.clips.forEach((clip, i) => {
      const el = document.createElement('div');
      el.className = 'clip' + (clip.id === s.activeClipId ? ' active' : '');
      const badges = [];
      if (clip.subCount) badges.push(`<span class="badge sub">SUB${clip.subCount > 1 ? ' ' + clip.subCount : ''}</span>`);
      if (clip.hasProxy) badges.push('<span class="badge">PROXY</span>');
      el.innerHTML = `
        <div class="clip-top">
          <div class="clip-name" title="${CU.escapeHtml(clip.path)}">${i + 1}. ${CU.escapeHtml(clip.name)}</div>
          <div class="clip-badges">${badges.join('')}</div>
        </div>
        <div class="clip-meta">
          <span>${CU.fmt(clip.durationMs, 3)}</span>
          <span class="kept">→ ${CU.fmt(clip.kept, 3)}</span>
          <span>${clip.width}×${clip.height}</span>
          <span>${clip.fps ? clip.fps.toFixed(2) : '?'} fps</span>
          ${clip.hasAudio ? '' : '<span style="color:var(--warn)">no audio</span>'}
          ${clip.cuts ? `<span style="color:var(--danger)">${clip.cuts} cut${clip.cuts > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="clip-actions">
          <button class="btn tiny" data-act="up" title="Move earlier">↑</button>
          <button class="btn tiny" data-act="down" title="Move later">↓</button>
          <button class="btn tiny ghost" data-act="sub">Add sub</button>
          <button class="btn tiny ghost" data-act="remove">Remove</button>
        </div>`;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (b) {
          e.stopPropagation();
          send('clip', { act: b.dataset.act, clipId: clip.id });
          return;
        }
        send('activate', { clipId: clip.id });
      });
      list.appendChild(el);
    });
  }

  function renderCutList(s) {
    $('cutCount').textContent = String(s.cuts.length);
    const list = $('cutList');
    list.innerHTML = '';
    if (!s.clipName) list.innerHTML = '<div class="sub-info">Select a clip first.</div>';
    else if (!s.cuts.length) {
      list.innerHTML = '<div class="sub-info">No cuts yet. Drag on the filmstrip in the main window, or use the cut tools.</div>';
    }
    s.cuts.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'cut-item';
      el.innerHTML =
        `<span class="cut-time">${CU.fmt(c.start, 3)} → ${CU.fmt(c.end, 3)}</span>` +
        `<span class="cut-dur">${CU.fmt(c.end - c.start, 3)}</span>` +
        `<button class="btn tiny danger" title="Remove this cut">✕</button>`;
      el.querySelector('button').addEventListener('click', () => send('cutDelete', { cutId: c.id }));
      el.addEventListener('mouseenter', () => send('cutHover', { cutId: c.id, on: true }));
      el.addEventListener('mouseleave', () => send('cutHover', { cutId: c.id, on: false }));
      list.appendChild(el);
    });
  }

  function renderSubPanel(s) {
    const sub = s.sub;
    const offset = $('subOffset');
    if (document.activeElement !== offset) offset.value = String(sub.offset);
    $('btnSubExport').disabled = !sub.canExport;
    $('btnSubAdd').disabled = !s.clipName;

    const info = $('subInfo');
    const trackList = $('subTrackList');
    const eventList = $('subEventList');
    trackList.innerHTML = '';
    eventList.innerHTML = '';

    if (!s.clipName) {
      info.textContent = 'Select a clip to manage its subtitles.';
      return;
    }
    if (!sub.tracks.length) {
      info.innerHTML =
        'No subtitles loaded for this clip. Add one or more <code>.srt</code>/<code>.vtt</code> files — each becomes its own track.';
      return;
    }

    sub.tracks.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'sub-track' + (t.active ? ' active' : '') + (t.enabled ? '' : ' disabled');
      row.title = 'Click to show this track in the timeline and preview';
      row.innerHTML =
        `<input type="checkbox" class="sub-track-toggle" ${t.enabled ? 'checked' : ''} title="Include this track when exporting" />` +
        `<span class="sub-track-name">${CU.escapeHtml(t.name)}</span>` +
        `<span class="sub-track-meta" title="kept / total events">${t.kept}/${t.total}</span>` +
        `<button class="sub-track-remove" title="Remove this subtitle track">✕</button>`;
      row.querySelector('.sub-track-toggle').addEventListener('change', (e) =>
        send('subToggle', { trackId: t.id, enabled: e.target.checked }),
      );
      row.querySelector('.sub-track-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        send('subRemove', { trackId: t.id });
      });
      row.addEventListener('click', (e) => {
        if (e.target.closest('input, button')) return;
        send('subActivate', { trackId: t.id });
      });
      trackList.appendChild(row);
    });

    const kept = Math.max(0, sub.eventCount - sub.dropped);
    info.innerHTML =
      `<b>${sub.tracks.length} track${sub.tracks.length > 1 ? 's' : ''}</b> · ` +
      `<b>${CU.escapeHtml(sub.activeName || '')}</b>${sub.activeEnabled ? '' : ' (excluded from export)'}<br>` +
      `${sub.eventCount} events · <span class="ok">${kept} kept</span>` +
      (sub.dropped ? ` · <span class="warn">${sub.dropped} dropped inside cuts</span>` : '');

    sub.rows.forEach((r) => {
      const el = document.createElement('div');
      el.className = 'sub-event' + (r.dropped ? ' dropped' : '');
      const newLabel = r.dropped ? 'cut' : r.newStarts.map((v) => CU.fmt(v, 3)).join(', ');
      el.innerHTML =
        `<span class="se-time">${CU.fmt(r.start, 3)}</span>` +
        `<span class="se-arrow">→</span>` +
        `<span class="se-new">${newLabel}</span>` +
        `<span class="se-text" title="${CU.escapeHtml(r.text)}">${CU.escapeHtml(r.text.replace(/\s*\n\s*/g, ' '))}</span>`;
      el.addEventListener('click', () => send('seekTo', { ms: r.start }));
      eventList.appendChild(el);
    });
    if (sub.eventCount > sub.rows.length) {
      const more = document.createElement('div');
      more.className = 'sub-info';
      more.textContent = `… ${sub.eventCount - sub.rows.length} more events`;
      eventList.appendChild(more);
    }
  }

  function renderSidebar(s) {
    renderClipList(s);
    renderCutList(s);
    renderSubPanel(s);
    $('panelStatus').textContent = s.clipName ? `${s.clipName} · ${s.cuts.length} cut${s.cuts.length === 1 ? '' : 's'}` : 'No clip selected';
  }

  /* ───────────────────────────── keys ───────────────────────────── */
  function onKey(e) {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (NAME !== 'transport') return;
    const clickOf = (id) => {
      e.preventDefault();
      send('click', { id });
    };
    switch (e.key) {
      case ' ':
        clickOf('btnPlay');
        break;
      case 'ArrowLeft':
        clickOf(e.shiftKey ? 'btnPrevSec' : 'btnPrevFrame');
        break;
      case 'ArrowRight':
        clickOf(e.shiftKey ? 'btnNextSec' : 'btnNextFrame');
        break;
      case 'i':
      case 'I':
        clickOf('btnSetIn');
        break;
      case 'o':
      case 'O':
        clickOf('btnSetOut');
        break;
      case 'x':
      case 'X':
        clickOf('btnCut');
        break;
      case 'Home':
        clickOf('btnStop');
        break;
      default:
        break;
    }
  }

  /* ───────────────────────────── boot ───────────────────────────── */
  function init() {
    document.body.dataset.panel = NAME;
    document.title = `CUCI² — ${TITLES[NAME]}`;
    $('panelSub').textContent = TITLES[NAME];
    $('panelSidebar').hidden = NAME !== 'sidebar';
    $('panelTransport').hidden = NAME !== 'transport';

    if (NAME === 'transport') wireTransport();
    else wireSidebar();

    panelAPI.onState((payload) => {
      if (!payload || payload.panel !== NAME || !payload.data) return;
      last = payload.data;
      if (NAME === 'transport') renderTransport(last);
      else renderSidebar(last);
    });

    $('btnDock').addEventListener('click', () => panelAPI.close());
    window.addEventListener('keydown', onKey);

    panelAPI.ready();
    // The main window may still be booting; ask again shortly if nothing came.
    setTimeout(() => {
      if (!last) panelAPI.ready();
    }, 1500);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
