# AGENTS.md — CUCI2 handoff

Pi auto-loads this file as a context file. Keep it short and current — its purpose is to let
a fresh session start cheaply, without re-reading the codebase.

## What this is

**CUCI²** — Electron desktop app: millisecond-precision video cut/merge, automatic subtitle
sync (multiple tracks), on-device NSFW ("Parental AI") scan, shareable cut jobs, MSIX/Store
packaging.

- Repo: https://github.com/abahkool/cuci2 — branch `main`, last commit `2aef20f`
- Working dir: `C:\Data\Project\CUCI2`
- Renderer: vanilla HTML/CSS/JS, **no bundler**, classic scripts attached to `window.CUCI`
- Main process: ffmpeg/ffprobe CLI + `onnxruntime-node`
- License: MIT

Docs: `README.md` (users) · `docs/DEVELOPMENT.md` (architecture, IPC, data formats, tests) ·
`docs/STORE-SUBMISSION.md` (MSIX, WACK, listing copy).

## Start here (cheapest path)

1. Read this file (already loaded).
2. Read **only** the doc section for the task — don't read all three.
3. For code, `grep -n "functionName" src/app.js`, then read ±40 lines.
   `src/app.js` is ~2800 lines: **never read it whole**.
4. Verify with `npm test` (or one suite) instead of manual UI poking.
5. `git status` + `git log --oneline -5` before editing.

## File map (line numbers drift — grep instead)

| File | Lines | Contents |
| --- | --- | --- |
| `main.js` | 69 | Electron bootstrap, `media://` scheme registration, window |
| `preload.js` | 57 | `window.api` surface |
| `panel-preload.js` | 40 | `window.panelAPI` for detached panel windows |
| `lib/ipc.js` | 644 | all IPC handlers, settings, export orchestration, cancel, NSFW scan |
| `lib/panels.js` | 240 | detached side panel / control center OS windows (lifecycle, bounds, relay) |
| `lib/exporter.js` | 100 | pure ffmpeg filtergraph/encoder builders (`buildFilterGraph`, `buildEncoderArgs`) |
| `lib/formats.js` | 100 | export containers → encoders/muxer/audio (mirrored in `src/app.js`) |
| `lib/media-protocol.js` | 130 | seekable `media://` with HTTP Range (206) |
| `lib/ffmpeg-locate.js` | 186 | custom → env → system → bundled resolution |
| `lib/nsfw.js` | 377 | ONNX NSFW scanning (sampling, inference, `groupDetections`) |
| `src/app.js` | 2801 | all renderer logic |
| `src/panel.html` | 170 | detached panel window markup (side panel + control center) |
| `src/panel.js` | 350 | thin panel view: renders snapshots, forwards commands |
| `src/panel.css` | 80 | panel window chrome |
| `src/job.js` | 357 | cut-job codec + **untrusted-input** validation (`sanitizeJob`) |
| `src/srt.js` | 157 | subtitle parse/serialise/remap + SRT text cleaning |
| `src/util.js` | 46 | time formatting helpers |
| `src/index.html` | 517 | UI markup (all modals, timeline, transport) |
| `src/styles.css` | 1689 | theme, timeline, modals, status bar, context menu |
| `scripts/fetch-ffmpeg.mjs` | 196 | resumable ffmpeg download into `vendor/ffmpeg` (postinstall) |
| `scripts/build-msix.mjs` | 239 | MSIX staging + `makeappx` packing |
| `scripts/make-store-assets.mjs` | 97 | placeholder MSIX/listing artwork |

Tests: `lib/selftest.js` (export graph), `lib/test-locate.js`, `lib/test-job.js`,
`lib/test-nsfw.js`, `lib/smoke.js`, `lib/e2e.js`, `lib/test-cancel.js`.

## Key functions in `src/app.js`

| Area | Functions (approx. line) |
| --- | --- |
| Ranges | `keptRanges` 83 · `programRanges` 96 · `clipBaseOffset` 131 |
| Subtitles | `activeSubtitleTrack` 115 · `remapTrack` 125 · `computeRemaps` 139 · `remapAllTracks` 160 |
| Status/toast | `toast` ~226 · `setStatus` 246 · `pushStatusHistory` |
| Media | `addVideos` 369 · `loadSubtitlesFromPaths` 477 · `loadSubtitleFromPath` ~522 |
| Rendering | `renderTimeline` ~600 · `buildBase` 633 · `renderOverlays` 711 · `updateSubPanel` 866 · `updateSubtitleOverlay` 980 |
| Timeline input | `onPointerDown` ~1180 · `onPointerMove` · `onPointerUp` · `showContextMenu` 1160 |
| Jobs | `buildJob` 1461 · `applyJob` 1537 · `selectJobTab` 1716 · `openJobModal` 1726 |
| NSFW | `openNsfwModal` ~1740 · `startNsfwScan` 1802 |
| Export | `currentSetup` 1909 · `updateExportSummary` 1956 · `openExportModal` 1990 · `startExport` 2003 |
| Layout | `wireSplitter` 2174 · `applyTimelineHeight` ~2140 |
| Boot | `wire` ~2270 · `refreshInfo` ~2030 · `init` 2758 |

IPC channels (`lib/ipc.js`): `app:info`, `settings:set`, `dialog:openVideos|openSubtitles|openFile|saveFile`,
`fs:readText|writeText`, `media:probe|thumbs|proxy`, `nsfw:status|scan|cancel`,
`export:start|cancel`, `clipboard:read|write`, `shell:showItem`.
Push events: `export:progress`, `thumbs:progress`, `nsfw:progress`, `proxy:log`.

## Data model

```js
state = {
  clips: [{
    id, path, name, fileSize, durationMs, fps, width, height, hasAudio,
    cuts: [{ id, start, end }],                              // ms, removed ranges
    subtitles: [{ id, path, name, format, events, enabled }], // multi-track
    activeSubtitleId, thumbs: { dir, files, stepMs }, proxyPath
  }],
  activeClipId, selection: { clipId, start, end } | null, inPoint, outPoint,
  playhead, resultTime, playMode: 'source' | 'result', snap, zoom, pxPerMs,
  globalSubOffset, settings, jobDescription, pendingJob,
  detectKey, detectScanning, detectSegments, detectors,
  scrubbing, undo, redo, exporting
}
```

- All times are **milliseconds** (floats rounded to 3 dp). Convert to seconds only at ffmpeg.
- Subtitle events: `{ start, end, text }`.
- Remapping: `rangeOutputOffsets[i] = Σ kept durations before i`; see `docs/DEVELOPMENT.md`
  for the formula and the regression that once broke it.

## Non-obvious invariants (read before changing)

1. **`media://` must answer Range requests (206)** or the `<video>` becomes unseekable.
   Implemented in `lib/media-protocol.js`; do not replace with `net.fetch(file://)`.
2. **Cancel/cleanup**: `taskkill /pid <pid> /T /F` + reap of newly-spawned ffmpeg. **Never add
   PowerShell/WMI process enumeration** — it previously tripped Defender (`Trojan:Win32/SuspExec.SE`).
3. **ffmpeg resolution** order: settings path → env → system PATH → bundled. Bundled lives in
   `vendor/ffmpeg` (gitignored). `npm run fetch:ffmpeg` re-downloads.
4. **Job files/share codes are untrusted.** `src/job.js` is the only path into app state:
   size caps, bounded inflate (zip-bomb), `__proto__`-safe JSON, schema validation, array caps.
   `applyJob()` sanitizes again. Never bypass.
5. **Subtitle text is cleaned** in `sanitizeSubtitleText` and in `serializeSrt/serializeVtt`:
   blank lines collapsed, `-->` → `→`, to prevent cue injection.
6. **Timeline geometry** uses `--timeline-h`; the splitter handle is `#playerSplitter`; the
   height persists in `localStorage["cuci2.timelineHeight"]`.
7. **Export guard**: exporting with 0 cuts requires a second click (prevents accidental
   full-length re-encodes).
8. **Detached panels are real OS windows** (`lib/panels.js` + `src/panel.*`). The main
   renderer is the only source of truth: panels get snapshots (`panel:state`, `kind: main |
   timeline`) and reply with validated commands (`panel:cmd`). They use `panel-preload.js`,
   never `window.api`. The timeline is part of the control center pane and is rendered inside
   that window (`#ptlTimeline`). Do not add app logic to `src/panel.js` — extend the
   snapshot/command maps in `src/app.js`.
9. **Export formats are a table**: `lib/formats.js` (muxer/audio/legal encoders) and the
   `EXPORT_FORMATS` mirror in `src/app.js` (dropdowns, extensions). Change both together;
   `lib/selftest.js` muxes every format.
10. **Classic scripts, ordered**: `util.js`, `srt.js`, `job.js`, `app.js`. No ES modules.
11. **Job-derived strings** are always rendered via `textContent` or `CU.escapeHtml()`.
12. Transport uses a CSS grid with named areas; breakpoint at 1250 px moves the right-hand
    controls to their own row.
13. Cut tools are inline SVG (no icon library).
14. Electron-builder must be spawned via `node .../cli.js`, not the `.cmd` shim (EINVAL).

## Commands

```bash
npm start                 # run
npm run dev               # devtools + renderer logs
npm test                  # locate → job → nsfw → export → smoke → e2e → cancel  (~6 min)
npm run test:job          # fast: job trust boundary (run when touching job.js/srt.js)
npm run test:e2e          # full UI flow (~4-5 min)
npm run test:cancel       # verifies cancel kills ffmpeg + cleans residue
npm run store:assets      # regenerate placeholder MSIX/listing artwork
npm run store:stage       # build + lay out dist/msix (no makeappx needed)
npm run store:package     # stage + pack .msix (needs makeappx)
npm run dist              # NSIS/portable/dmg/AppImage
```

Do **not** `npm install` for no reason — `postinstall` fetches ~110 MB ffmpeg (it skips when
`vendor/ffmpeg` exists). `node_modules` is already populated, including `electron-builder`.

## Testing notes

- `lib/e2e.js` drives the real renderer with `window.__cuciApp` and prints structured JSON;
  it uses an isolated temp `userData` (never touches real settings). It also opens the
  detached side panel / control center as real windows and checks the state/command relay.
- Debug handle exposes: `state`, `api`, `CU`, `addVideos`, `addSubtitleToClip`,
  `loadSubtitleFromPath`, `keptRanges`, `programRanges`, `remapAll`, `remapAllTracks`,
  `applyThumbSetting`, `applyNsfwSegments`, `buildJob`, `applyJob`, `encodeShareCode`,
  `decodeShareCode`, `addCut`, `removeCut`, `renderAll`, `seekTo`, `currentSetup`.
- Prefer DOM/state assertions over screenshots. If a screenshot is needed, call
  `win.show(); win.focus()` first — `capturePage()` returns an empty image for an unpainted
  window (retry a few times).
- When embedding renderer code in a Node template literal, avoid nested `\n`/regex escapes —
  build newlines with `String.fromCharCode(10)` (this caused a silent e2e hang once).

## Current status

Implemented and tested: timeline editing (drag select, I/O marks, double-click In/Out,
right-click cut menu, cut-edge drag, undo/redo), multi-clip merge, frame-accurate export with
progress + cancel, subtitle sync with **multiple tracks per clip** (enable/remove, per-track
`.srt` export, "track to burn"), Parental AI (NSFW) scanning, cut jobs (file + compact share
code, Export/Import tabs, description), status bar with history, player/timeline splitter,
context menu, keyboard shortcuts, workspace layout (per-pane **pin/peek/detach**:
auto-hide + hover chevrons open a temporary peek drawer, the side panel / control center
detach into their own OS windows, and the timeline travels inside the control center window),
MSIX packaging scaffold.

Local-only (gitignored): `vendor/ffmpeg` (ffmpeg/ffprobe 9.0.2), `vendor/nsfw/model_quantized.onnx`,
`Sample/` (including the user's screenshots in `Sample/others/`).

Known limitations / likely next work:

- **No ONNX gore model** exists on HF (violence detection was prototyped and reverted at the
  user's request — it is not in the codebase).
- Preview is limited to Chromium codecs; the proxy fallback covers the rest.
- `makeappx.exe` is **not installed** on this machine (`signtool` is). `npm run store:package`
  stages `dist/msix` then exits with install instructions. `store/identity.json` is gitignored.
- Bundled ffmpeg is GPLv3 — the licensing decision is documented in `docs/STORE-SUBMISSION.md`.
- No i18n. `docs/DEVELOPMENT.md` is the source of truth for schema/IPC changes.

## Conventions & cost-saving rules

- 2-space indent, single quotes, semicolons; small functions over classes; no new frameworks.
- ffmpeg args are always `spawn` arrays; escape filter paths with `escapeFilterPath()`.
- Use `setStatus()` for anything longer than a moment; route errors through `toast(...,'error')`.
- Update `docs/DEVELOPMENT.md` when changing IPC, the job schema, or the data model.
- Keep commits scoped with a descriptive message, then `git push` (remote is already configured).
- Don't re-read whole files or the whole git history; grep and read the relevant block.
- Ask before adding heavy dependencies; most needs are already covered.
