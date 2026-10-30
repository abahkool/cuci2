# AGENTS.md — CUCI handoff

Pi auto-loads this file as a context file. Keep it short and current — its purpose is to let
a fresh session start cheaply, without re-reading the codebase.

## What this is

**CUCI** — Electron desktop app: millisecond-precision video delete/merge, automatic subtitle
sync (multiple tracks), on-device NSFW ("Parent Assist") scan, shareable delete jobs, MSIX/APPX
store packaging.

- Repo: https://github.com/abahkool/cuci2 — branch `main` (the repo keeps its original name)
- Working dir: `C:\Data\Project\CUCI2` (folder keeps the old name)
- Renderer: vanilla HTML/CSS/JS, **no bundler**, classic scripts attached to `window.CUCI`
- Main process: ffmpeg/ffprobe CLI + `onnxruntime-node`
- License: MIT

Docs: `README.md` (users) · `docs/DEVELOPMENT.md` (architecture, IPC, data formats, tests) ·
`docs/STORE-SUBMISSION.md` (MSIX, WACK, listing copy).

## Start here (cheapest path)

1. Read this file (already loaded).
2. Read **only** the doc section for the task — don't read all three.
3. For code, `grep -n "functionName" src/app.js`, then read ±40 lines.
   `src/app.js` is ~3900 lines: **never read it whole**.
4. Verify with `npm test` (or one suite) instead of manual UI poking.
5. `git status` + `git log --oneline -5` before editing.

## File map (line numbers drift — grep instead)

| File | Lines | Contents |
| --- | --- | --- |
| `main.js` | 86 | Electron bootstrap, `media://` scheme registration, window |
| `preload.js` | 85 | `window.api` surface |
| `panel-preload.js` | 36 | `window.panelAPI` for detached panel windows |
| `lib/ipc.js` | 681 | all IPC handlers, settings, export orchestration, cancel, NSFW scan |
| `lib/panels.js` | 248 | detached side panel / control center OS windows (lifecycle, bounds, relay) |
| `lib/menu.js` | 220 | native File/Edit/View/Help menu + `menu:state`/`menu:command` sync |
| `lib/i18n-main.js` | 83 | evaluates the renderer dictionaries in the main process (menu + notifications) |
| `lib/exporter.js` | 99 | pure ffmpeg filtergraph/encoder builders (`buildFilterGraph`, `buildEncoderArgs`) |
| `lib/formats.js` | 105 | export containers → encoders/muxer/audio (mirrored in `src/app.js`) |
| `lib/media-protocol.js` | 130 | seekable `media://` with HTTP Range (206) |
| `lib/ffmpeg-locate.js` | 186 | custom → env → system → bundled resolution |
| `lib/nsfw.js` | 389 | ONNX NSFW scanning (sampling, inference, `groupDetections`) |
| `src/app.js` | 4044 | all renderer logic |
| `src/panel.html` | 177 | detached panel window markup (side panel + control center + timeline) |
| `src/panel.js` | 622 | thin panel view: renders snapshots, forwards commands |
| `src/panel.css` | 119 | panel window chrome |
| `src/job.js` | 380 | delete-job codec + **untrusted-input** validation (`sanitizeJob`) |
| `src/i18n.js` | 1623 | 14-language UI dictionary, detection, `<html dir>` switching, `CU.i18n.extend` |
| `src/guide-i18n.js` | 836 | user-guide strings (14 languages) |
| `src/messages-i18n.js` | 700 | settings-page + notification strings (14 languages) |
| `src/menu-i18n.js` | 92 | native menu labels (14 languages) |
| `src/errors-i18n.js` | 573 | error/status strings (14 languages) |
| `src/srt.js` | 157 | subtitle parse/serialise/remap + SRT text cleaning |
| `src/util.js` | 46 | time formatting helpers |
| `src/index.html` | 713 | UI markup (all modals incl. guide + import confirm, timeline, transport) |
| `src/styles.css` | 2352 | theme (dark + light), RTL, timeline, modals, guide, status bar |
| `build.ps1` | 248 | release script: version bump → tests → obfuscate+verify → builder/MSIX/APPX → signing |
| `scripts/obfuscate.mjs` | 178 | stage `.build/app` with the renderer obfuscated |
| `scripts/verify-build.cjs` | 162 | boot the staged app in Electron and assert it works (11 checks) |
| `scripts/msix-tools.mjs` | 175 | locate/provision makeappx + signtool (SDK, PATH or NuGet BuildTools) |
| `scripts/fetch-ffmpeg.mjs` | 196 | resumable ffmpeg download into `vendor/ffmpeg` (postinstall) |
| `scripts/build-msix.mjs` | 247 | MSIX/APPX staging + `makeappx` packing + unpack round-trip |
| `scripts/make-store-assets.mjs` | 106 | MSIX/listing artwork + multi-size `build/icon.ico` from `icons/logo.png` |

Tests: `lib/selftest.js` (export graph, every format), `lib/test-locate.js`, `lib/test-job.js`,
`lib/test-nsfw.js`, `lib/smoke.js`, `lib/e2e.js`, `lib/test-cancel.js`.

## Key functions in `src/app.js`

| Area | Functions (approx. line) |
| --- | --- |
| Ranges | `keptRanges` 180 · `programRanges` 193 · `clipBaseOffset` 222 |
| Subtitles | `activeSubtitleTrack` 212 · `remapTrack` 232 · `computeRemaps` 236 · `remapAllTracks` 257 · `applySubEventsState` 148 · `autoOpenSubEvents` 158 · `loadSubtitlesFromPaths` 589 |
| Status/toast | `toast` 300 · `pushStatusHistory` 324 · `setStatus` 343 |
| Media | `addVideos` 466 · `loadSubtitlesFromPaths` 574 · `loadSubtitleFromPath` 620 |
| Rendering | `renderTimeline` 712 · `buildBase` 731 · `renderOverlays` 809 · `updateSubPanel` 969 · `updateSubtitleOverlay` 1088 |
| Timeline input | `showContextMenu` 1268 · `onPointerDown` 1468 · `onPointerMove` 1523 · `onPointerUp` 1570 |
| Jobs | `buildJob` 1599 · `applyJob` 1676 · `finishJobApply` 1731 · `setJobFilePath` 1824 · `rememberedJobFile` 1840 · `saveJobFile` 1850 · `openJobFile` 1872 · `requestJobImport` 1982 · `selectJobTab` 2019 · `openJobModal` 2029 |
| Guide | `openGuide` 1844 (topbar `?` / F1) |
| NSFW | `openNsfwModal` 2002 · `startNsfwScan` 2025 |
| Export | `EXPORT_FORMATS` 2133 · `currentSetup` 2198 · `updateExportSummary` 2245 · `openExportModal` 2283 · `startExport` 2296 |
| Settings/tools | `renderToolStatus` 2402 · `persistSettings` 2438 · `refreshInfo` 2477 · `openSettings` 2512 |
| Layout | `wirePeek` 2692 · `setPanelPinned` 2743 · `setPanelDetached` 2764 · `wireLayout` 3190 · `applyTimelineHeight` 3209 · `wireSplitter` 3226 |
| Menu | `sendMenuState` 3117 · `onMenuCommand` 3143 |
| Appearance/i18n | `migrateStorage` 46 · `applyTheme` 78 · `CU.i18n.apply` |
| Boot | `wire` 3270 · `init` 3873 (debug handle at 3906) |

IPC channels (`lib/ipc.js`): `app:info`, `settings:set`, `dialog:openVideos|openSubtitles|openFile|saveFile`,
`fs:readText|writeText`, `media:probe|thumbs|proxy`, `nsfw:status|scan|cancel`,
`export:start|cancel`, `clipboard:read|write`, `shell:showItem`.
Push events: `export:progress`, `thumbs:progress`, `nsfw:progress`, `proxy:log`.
Renderer↔main menu sync: `menu:command` (push), `menu:state` (renderer → main).
Renderer↔panel windows: `panel:state` (snapshot, `kind: main | timeline`), `panel:cmd` (validated).

## Data model

```js
state = {
  clips: [{
    id, path, name, fileSize, durationMs, fps, width, height, hasAudio,
    deletes: [{ id, start, end }],                              // ms, removed ranges
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
   **Job imports are confirmed first**: `requestJobImport()` decodes with
   `parseJobText`/`sanitizeJob`, then shows `#confirmModal` (description, clips, deletes, subtitle
   tracks, found/missing clips, format) and only calls `applyJob` after the user confirms.
   Dialog values use `textContent`, never innerHTML.
6. **Timeline geometry** uses `--timeline-h`; the splitter handle is `#playerSplitter`; the
   height persists in `localStorage["cuci.timelineHeight"]`.
7. **Export guard**: exporting with 0 deletes requires a second click (prevents accidental
   full-length re-encodes).
8. **Detached panels are real OS windows** (`lib/panels.js` + `src/panel.*`). The main
   renderer is the only source of truth: panels get snapshots (`panel:state`, `kind: main |
   timeline`) and reply with validated commands (`panel:cmd`). They use `panel-preload.js`,
   never `window.api`. The timeline is part of the control center pane and is rendered inside
   that window (`#ptlTimeline`). Do not add app logic to `src/panel.js` — extend the
   snapshot/command maps in `src/app.js`. **Panels follow the main theme, not the OS**: `panel:open`
   carries `theme`, every `main` snapshot repeats it, and `src/panel.js` writes it to
   `<html data-theme>` (`applyPanelTheme`).
9. **Export formats are a table**: `lib/formats.js` (muxer/audio/legal encoders) and the
   `EXPORT_FORMATS` mirror in `src/app.js` (dropdowns, extensions). Change both together;
   `lib/selftest.js` muxes every format.
10. **Classic scripts, ordered**: `util.js`, `srt.js`, `job.js`, `i18n.js`, `guide-i18n.js`,
    `messages-i18n.js`, `menu-i18n.js`, `errors-i18n.js`, `app.js`. No ES modules.
11. **Job-derived strings** are always rendered via `textContent` or `CU.escapeHtml()`.
12. Transport uses a CSS grid with named areas; breakpoint at 1250 px moves the right-hand
    controls to their own row.
13. Delete tools are inline SVG (no icon library).
14. Electron-builder must be spawned via `node .../cli.js`, not the `.cmd` shim (EINVAL).
15. **Never package the working tree**: `build.ps1` and the `dist`/`store:*` npm scripts run
    `scripts/obfuscate.mjs` first and build from `.build/app`. After changing renderer code,
    re-run `npm run obfuscate` + `npm run verify:build` before trusting a package (verify
    boots the obfuscated stage: globals, preload, i18n, theme, media probe, subtitle+delete).
16. MSIX/APPX must be packed with **makeappx** and round-tripped with `makeappx unpack`
    (`build-msix.mjs`). `msix-tools.mjs` finds the Windows SDK copy or downloads
    `Microsoft.Windows.SDK.BuildTools` from NuGet into `vendor/msix-tools/`. Do not hand-roll
    a package writer.
17. **New UI text must be translatable**: add a key to `DICT.en` in `src/i18n.js` (or
    `guide-i18n.js` / `messages-i18n.js` / `menu-i18n.js` / `errors-i18n.js`), the other 13
    languages, and bind it with `data-i18n*` (static) or `t('key')` / `tf('key', {vars})`
    (renderer) — main-process code uses `lib/i18n-main.js`. No hardcoded user-facing strings.
18. **Settings apply immediately** — no Save button; use `persistSettings()` and keep
    `state.settings` in sync (it refreshes `app:info`). The subtitle text list is collapsible
    (`localStorage["cuci.subEvents"]`, **default collapsed**; `autoOpenSubEvents()` compares
    `clip.subtitles.length` with a per-clip `subTrackCounts[clip.id]` from the previous render,
    so it opens on first load / an extra track / switching to a clip that has one, a manual
    collapse sticks, and clicking a track row reveals its text) in both the sidebar and the
    panel window. `clip.activeSubtitleId` defaults to `subtitles[0].id`.
19. **`Ctrl+S` reuses the remembered job file** (`localStorage["cuci.jobFile"]`, scoped to the
    first clip's path); only the Job panel's *Save job file…* button (`saveJobFile({ask:true})`)
    always shows the dialog. `Ctrl+C`/`Ctrl+V` are renderer `onKeyDown` handlers outside text
    fields; `Ctrl+V` goes through `requestJobImport()` (preview + confirmation).
20. **The native menu is translated and state-driven**: add actions in `lib/menu.js`, handle
    them in `onMenuCommand` (`src/app.js`), and keep `sendMenuState()` after any change to
    snap/mode/pins/detach/theme/language. Never register accelerators for text-editing keys;
    DevTools/Reload stay out of production menus.
21. **Theme colours come from CSS variables** (`:root` dark + `:root[data-theme='light']`).
    Hard-coded hex values break the light theme — check it in Settings before shipping.
22. **Sidebar sizing is delicate**: the subtitle panel is `.panel.grow` and may overflow at
    800 px height. A compacting fix (commit `573f50a`: leftover-height panel, `.srt` export as
    a header icon, single-line summary) was **reverted at the user's request** (`91288da`). Do
    not re-apply it unless asked. Actions sits **above** Media in the sidebar (`src/index.html`)
    and in `src/panel.html` — keep that order.
23. **The ffmpeg chip only speaks when something is wrong** (`refreshInfo()`): healthy sets
    `hidden = true`, failure shows `ffmpeg ✗ not found` + `msgFfmpegMissing`. It starts
    `hidden` in the markup. Settings still lists the full version/path.
24. **Every dictionary must stay key-complete**: `src/i18n.js` (chrome), `guide-i18n.js`
    (guide + import confirm), `messages-i18n.js` (settings + toasts), `menu-i18n.js` (native
    menu), `errors-i18n.js` (errors/status) — 14 languages each, identical key sets per file
    and no English fallbacks for new keys. `t()` returns the literal key for an unknown one
    (that is how a missing `msgThumbsLoading` once leaked into the status bar), so after adding
    UI text audit key parity across all five files and both markup files.

25. **The first-run tour and the rating prompt are renderer-only.** State lives in 
    `localStorage["cuci.tour"]` (dismissed), `cuci.launches` (boot counter) and `cuci.rated`;
    the steps are `TOUR_STEPS` in `src/app.js` (section *product tour*) and the copy is in
    `src/i18n.js` (`tour*`, `rate*`, `msgStore*`). The first step is the welcome card (`sel: null`,
    dims the whole window, never skipped). Render the first card **synchronously** (hidden windows
    never fire `requestAnimationFrame`, so an empty card would show) and never clamp the spotlight
    rect. The Store link goes through IPC `store:open` — the renderer must not build URLs.
    The rating prompt is a modal with **no backdrop/Escape dismissal**, opens 5 s after load, and
    only *I already rated it* sets `cuci.rated`: opening the Store page must not stop the prompt.

## Commands

```bash
npm start                 # run
npm run dev               # devtools + renderer logs
npm test                  # locate → job → nsfw → export → smoke → e2e → cancel  (~6 min)
npm run test:job          # fast: job trust boundary (run when touching job.js/srt.js)
npm run test:e2e          # full UI flow (~4-5 min)
npm run test:cancel       # verifies cancel kills ffmpeg + cleans residue
npm run obfuscate         # stage + obfuscate .build/app (renderer only)
npm run verify:build      # boot the obfuscated stage, 11 assertions
npm run store:assets      # regenerate MSIX/listing artwork + build/icon.ico from icons/logo.png
npm run store:stage       # build + lay out dist/msix (no makeappx needed)
npm run store:package     # stage + pack .msix (provisions makeappx if missing)
npm run store:appx        # same, .appx output
npm run dist              # obfuscated NSIS/portable/dmg/AppImage
.\build.ps1 -Store -Appx  # full release: tests, obfuscate, verify, nsis, msix+appx
```

Do **not** `npm install` for no reason — `postinstall` fetches ~110 MB ffmpeg (it skips when
`vendor/ffmpeg` exists). `node_modules` is already populated, including `electron-builder` and
`javascript-obfuscator`.

## Testing notes

- `lib/e2e.js` drives the real renderer with `window.__cuciApp` and prints structured JSON;
  it uses an isolated temp `userData` (never touches real settings). It also opens the
  detached side panel / control center as real windows and checks the state/command relay,
  the guide modal (button + F1, 10 sections, 17 shortcut rows, translated title), the import
  confirmation (description shown, `<img onerror>` escaped, no injected nodes), theme
  switching, language switching (15 entries incl. auto, Arabic RTL), the native menu state, and
  that a detached window flips to `data-theme="light"` with the main theme.
- `lib/e2e.js` also checks the subtitle list (`evOpenByDefault`, `evCollapsed`, `evReopened`)
  and `subEventsEmpty` after `loadInfo` — keep both when touching the collapse logic.
- `scripts/verify-build.cjs` runs against the obfuscated `.build/app` stage and its own
  preload/lib/ipc, so obfuscation breakage is caught before packaging.
- Debug handle exposes: `state`, `api`, `CU`, `addVideos`, `addSubtitleToClip`,
  `loadSubtitleFromPath`, `keptRanges`, `programRanges`, `remapAll`, `remapAllTracks`,
  `applyThumbSetting`, `applyNsfwSegments`, `buildJob`, `applyJob`, `encodeShareCode`,
  `decodeShareCode`, `addDelete`, `removeDelete`, `renderAll`, `seekTo`, `currentSetup`,
  `setPanelPinned`, `setPanelDetached`.
- Prefer DOM/state assertions over screenshots. If a screenshot is needed, call
  `win.show(); win.focus()` first — `capturePage()` returns an empty image for an unpainted
  window (retry a few times).
- When embedding renderer code in a Node template literal, avoid nested `\n`/regex escapes —
  build newlines with `String.fromCharCode(10)` (this caused a silent e2e hang once).
- **Translation audit** (after touching any UI text): run `util.js` + `i18n.js` +
  `guide-i18n.js`/`messages-i18n.js`/`menu-i18n.js`/`errors-i18n.js` inside `vm.runInContext`
  with a stub `window`/`document`/`localStorage`, then (a) diff every language's key set
  against `DICT.en` (must be empty both ways), (b) collect `t('…')`/`tf('…')` literals from
  `src/app.js` + `src/panel.js` and `data-i18n*` keys from `index.html`/`panel.html` and check
  each exists, (c) at runtime call `CU.i18n.apply(code)` + `renderAll()` per language and read
  the strings back. Delete the throwaway script afterwards (they live at the repo root).

## Current status

Implemented and tested: timeline editing (drag select, I/O marks, double-click In/Out,
right-click delete menu, delete-edge drag, undo/redo), multi-clip merge, frame-accurate export with
progress + cancel, **8 export containers** (mp4/mov/mkv/webm/avi/wmv/flv/ts), subtitle sync
with **multiple tracks per clip** (enable/remove, per-track `.srt` export, "track to burn",
collapsible text list that opens when a track appears), Parent Assist (NSFW) scanning, delete jobs
(file + compact share code, Export/Import tabs, description, **remembered job file** so `Ctrl+S`
re-saves silently after the first save, `Ctrl+C`/`Ctrl+V` share-code shortcuts) with **safe
import preview + confirmation**, status bar with
history, player/timeline splitter, context menu, **native translated menu** (File/Edit/View/Help
mirroring the UI state), keyboard shortcuts, dark/light/system theme, **14-language UI** with
system detection (all five dictionaries key-complete), translated notifications/errors,
**internal user guide** (`?` / F1) with a *Show tour* button, a **first-run product tour**
(welcome card + 5 workflow steps, *Skip tour* persists, never shown again unless asked) and a **Store rating
prompt every fifth launch**,
workspace layout (per-pane **pin/peek/detach**: auto-hide + hover chevrons open a temporary
peek drawer, the side panel / control center detach into their own OS windows, the timeline
travels inside the control center window), obfuscated packaging, MSIX **and** APPX.

Local-only (gitignored): `vendor/ffmpeg` (ffmpeg/ffprobe 9.0.2), `vendor/nsfw/model_quantized.onnx`,
`vendor/msix-tools/` (provisioned makeappx), `Sample/`.

Known limitations / likely next work:

- **No ONNX gore model** exists on HF (violence detection was prototyped and reverted at the
  user's request — it is not in the codebase).
- Preview is limited to Chromium codecs; the proxy fallback covers the rest.
- `makeappx.exe` is not in PATH on this machine; `msix-tools.mjs` downloads it from NuGet on
  demand (`vendor/msix-tools/`). `signtool.exe` is installed (Windows Kits 10.0.28000.0).
  `store/identity.json` is gitignored (`store/identity.example.json` is the template).
- Release scripts are Windows-only (`build.ps1`, taskkill-based cancel, makeappx).
- Bundled ffmpeg is GPLv3 — the licensing decision is documented in `docs/STORE-SUBMISSION.md`.
- `docs/DEVELOPMENT.md` is the source of truth for schema/IPC changes — update it with this file.
- The native *File ▸ Save job file…* label still has an ellipsis although `Ctrl+S` only prompts
  the first time (or after the first clip changes); only the Job panel button always prompts.

## Renderer state kept outside `state`

- `localStorage` keys outside `state`: `cuci.timelineHeight`, `cuci.theme`, `cuci.lang`,
  `cuci.subEvents` (subtitle list toggle), `cuci.tour` (tour dismissed), `cuci.launches`,
`cuci.rated` and **`cuci.jobFile`** = `{ path, clip }` — the
  remembered job file; `rememberedJobFile()` returns it only while
  `state.clips[0].path === clip`.
- Debug handle (`window.__cuciApp`) exposes the renderer functions listed under *Testing notes*;
  probes should drive it instead of clicking pixels.

## Conventions & cost-saving rules

- 2-space indent, single quotes, semicolons; small functions over classes; no new frameworks.
- ffmpeg args are always `spawn` arrays; escape filter paths with `escapeFilterPath()`.
- Use `setStatus()` for anything longer than a moment; route errors through `toast(...,'error')`.
- Update `docs/DEVELOPMENT.md` when changing IPC, the job schema, or the data model.
- Keep commits scoped with a descriptive message, then `git push` (remote is already configured).
- Don't re-read whole files or the whole git history; grep and read the relevant block.
- Ask before adding heavy dependencies; most needs are already covered.
