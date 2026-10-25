# CUCI — Development Reference

Technical guide for working on CUCI. For the user-facing guide see
[../README.md](../README.md).

- [Stack](#stack)
- [Repo layout](#repo-layout)
- [Process model & security](#process-model--security)
- [Main process](#main-process)
- [IPC reference](#ipc-reference)
- [preload API](#preload-api)
- [Media protocol (`media://`)](#media-protocol-media)
- [Export pipeline (`lib/exporter.js` + `lib/ipc.js`)](#export-pipeline)
- [Renderer architecture (`src/app.js`)](#renderer-architecture)
- [Subtitle model (`src/srt.js`)](#subtitle-model)
- [Data formats](#data-formats)
- [Status bar API](#status-bar-api)
- [Testing](#testing)
- [Packaging](#packaging)
- [Common recipes](#common-recipes)
- [Conventions](#conventions)
- [Known constraints](#known-constraints)

---

## Stack

| Piece | Choice |
| --- | --- |
| Shell | Electron (pinned in `devDependencies`, currently `^33`) |
| Renderer | Vanilla HTML/CSS/JS (classic scripts, no bundler, no framework) |
| Media | system `ffmpeg` / `ffprobe` (CLI) + Chromium's built-in `<video>` for preview |
| Inference | `onnxruntime-node` (NSFW scene detection) |
| Tests | custom Electron harnesses in `lib/` (no test runner dependency) |

There is **no build step**. `main.js` loads `src/index.html` straight from disk.

---

## Repo layout

```
main.js                 Electron bootstrap: window, media:// scheme registration
preload.js              contextBridge API surface (window.api)
panel-preload.js        contextBridge for detached panel windows (window.panelAPI)
src/
  panel.html            detached side panel / control center window markup
  panel.js              thin view: renders snapshots, forwards commands
  panel.css             window chrome for the detached panels
lib/
  ipc.js                all ipcMain handlers, settings, export orchestration
  panels.js             detached panel windows: lifecycle, bounds, message relay
  formats.js            export containers: encoders, audio codec, muxer  ← shared
  exporter.js           pure ffmpeg filtergraph/encoder builders  ← unit-testable
  ffmpeg-locate.js      resolves custom/env/system/bundled ffmpeg+ffprobe
  nsfw.js               ONNX NSFW scene detection (sampling + inference + grouping)
  media-protocol.js     seekable media:// handler (HTTP range support)
src/i18n.js             UI translations (14 languages) + language detection
src/guide-i18n.js       user-guide + import-confirmation strings (merged via CU.i18n.extend)
src/messages-i18n.js    settings-page + notification strings (14 languages)
  selftest.js           export-pipeline test against real ffmpeg   (node)
  test-locate.js        verifies the tool resolution chain         (node)
  test-job.js           cut-job trust boundary: caps, bombs, XSS, SRT injection (node)
  test-nsfw.js          NSFW tensor/grouping unit tests + live scan (node)
  smoke.js              boots the real renderer, fails on console errors
  e2e.js                full UI flow test (load → subtitle → cut → seek → export → job)
  test-cancel.js        verifies cancel kills ffmpeg + removes residue
scripts/
  obfuscate.mjs         stages .build/app with the renderer obfuscated (build.ps1 default)
  verify-build.cjs      boots the staged app (Electron) and asserts it still works
  msix-tools.mjs        find/provision makeappx + signtool (Windows SDK or NuGet)
  fetch-ffmpeg.mjs      downloads a recent ffmpeg into vendor/ (postinstall)
vendor/
  ffmpeg/               bundled binaries (gitignored — npm run fetch:ffmpeg)
src/
  index.html            UI markup
  styles.css            dark theme, timeline, modals, status bar, context menu
  util.js               window.CUCI: time formatting + small helpers
  srt.js                window.CUCI: subtitle parse / serialise / remap
  job.js                window.CUCI: cut-job codec + untrusted-input validation
  app.js                renderer application logic (the bulk of the UI)
Sample/                 local scratch media for manual testing (entirely gitignored)
docs/DEVELOPMENT.md     this file
```

`Sample/` is a **local-only** folder for manual testing (source videos, dummy subtitles,
scratch images). It is fully gitignored — nothing in it is committed. See
[Sample media](#sample-media) for how to set it up.

---

## Process model & security

- `BrowserWindow` uses `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: false`, `backgroundThrottling: false`.
- The renderer has **no Node access**. Everything goes through `window.api` defined in
  `preload.js` with `contextBridge`.
- A **Content-Security-Policy** meta tag in `src/index.html` restricts sources; the
  `media:` scheme is explicitly allowed for `img`/`media`.
- Only standard Windows utilities are used for process control (`tasklist` / `taskkill`).
  **Do not introduce PowerShell / WMI process enumeration** — it trips endpoint-protection
  heuristics (see cancellation section).

---

## Main process

`main.js` is deliberately tiny:

1. `protocol.registerSchemesAsPrivileged(MEDIA_PRIVILEGES)` **before** app ready.
2. On `whenReady`: `registerIpc({ getWindow })`, `registerMediaProtocol()`, `createWindow()`.
3. On `window-all-closed`: `killCurrentJob()` then quit (except darwin).
4. `--dev` flag: opens DevTools and forwards renderer console messages to stdout.

---

## Tool resolution & bundled ffmpeg

`lib/ffmpeg-locate.js` owns every decision about which binary to run. Everything else asks
it via `ffmpegPath(settings)` / `ffprobePath(settings)` (wrapped as `ffmpegBin()` /
`ffprobeBin()` in `lib/ipc.js`).

Resolution order — the first candidate that successfully runs `-version` wins:

| Tier | Source tag | Notes |
| --- | --- | --- |
| 1 | `custom` | `settings.ffmpegPath` / `settings.ffprobePath` |
| 2 | `env` | `FFMPEG_PATH` / `FFPROBE_PATH` |
| — | `sibling` | ffprobe next to the resolved ffmpeg (before `system`) |
| 3 | `system` | `ffmpeg` / `ffprobe` on `PATH` |
| 4 | `bundled` | vendored build or the `ffmpeg-static` / `ffprobe-static` npm packages |

`settings.preferBundled` swaps tiers 3 and 4. A non-runnable candidate is skipped and
recorded in `warnings`, so a stale custom path falls back gracefully instead of breaking
the app.

A failed probe is never fatal — the resolver keeps going and `resolve()` returns
`{ ok, path, source, version, banner, libass, warnings }` per tool plus combined
`warnings`. `libass` is detected from the full `-version` output (the `--enable-libass`
flag is on the configuration line, not the first line) and is surfaced in Settings because
it gates subtitle burn-in.

Bundled lookup order (`bundledBin`):

1. `<process.resourcesPath>/ffmpeg/` — packaged app (electron-builder `extraResources`),
2. `<appRoot>/vendor/ffmpeg/` — dev checkout,
3. the optional `ffmpeg-static` / `ffprobe-static` packages if installed.

### Fetching the bundled build

`scripts/fetch-ffmpeg.mjs` downloads a recent release for the current platform into
`vendor/ffmpeg/`:

| Platform | Source |
| --- | --- |
| win32 | gyan.dev `ffmpeg-release-essentials.zip` (ffmpeg + ffprobe, libass) |
| linux-x64 / arm64 | johnvansickle.com static builds |
| darwin | evermeet.cx (ffmpeg and ffprobe separately) |

It is **resumable** (downloads into `vendor/.cache/` and continues partial files with
`curl -C -`), skips when the binaries already exist, and is run automatically by
`npm install` via `postinstall`. Flags:

- `--force` — re-download even if present (`npm run fetch:ffmpeg`),
- `--strict` — non-zero exit on failure (`predist`, so `npm run dist` fails loudly),
- `CUCI_SKIP_FFMPEG_FETCH=1` — skip entirely (useful in CI; the old `CUCI2_` name still works).

Without `--strict` the script always exits 0, so a failed download never breaks
`npm install` — the app simply falls back to a system ffmpeg.

Extraction uses whatever is available: `unzip`, Windows `tar.exe` (bsdtar reads zips),
GNU `tar -xJf` for `.tar.xz`, or `7z`.

`vendor/` is gitignored. Binaries are ~105 MB each, so they are shipped via
`extraResources` rather than committed.

## IPC reference

All channels are `ipcMain.handle` (request/response) except the `*:progress` events which
are `webContents.send` pushes. Channels live in `lib/ipc.js`; the renderer reaches them via
`window.api` (`preload.js`).

| Channel | Request | Response |
| --- | --- | --- |
| `app:info` | — | `{ version, platform, home, userData, ffmpeg:{ok,bin,version,error}, settings }` |
| `settings:set` | `{ ffmpegPath?, ffprobePath?, loadThumbs? }` | merged settings |
| `dialog:openVideos` | — | `string[]` paths |
| `dialog:openSubtitle` | — | `string \| null` |
| `dialog:openFile` | `{ title?, filters? }` | `string \| null` |
| `dialog:saveFile` | `{ title?, defaultPath?, filters? }` | `string \| null` |
| `fs:readText` | `path` | file contents |
| `fs:writeText` | `path, content` | `true` |
| `shell:showItem` | `path` | `true` |
| `clipboard:write` | `text` | `true` |
| `clipboard:read` | — | `string` |
| `media:probe` | `path` | `{ name, size, durationMs, fps, width, height, hasVideo, hasAudio, videoCodec, audioCodec, rotation }` |
| `media:thumbs` | `path, { durationMs, height, maxCount }` | `{ dir, files[], stepMs }` |
| `media:proxy` | `path` | proxy file path (movie) |
| `nsfw:status` | — | `{ installed, path, repo, file, approxBytes, inputSize, labels }` |
| `nsfw:scan` | `{ videoPath, durationMs, intervalMs?, threshold?, minDurationMs?, padMs? }` | `{ ok, segments, scannedFrames, positives, cancelled, … }` |
| `nsfw:cancel` | — | `true` |
| `export:start` | `ExportRequest` (below) | `{ ok, outputPath, srtPath }` \| `{ ok:false, error }` \| `{ ok:false, cancelled:true }` |
| `export:cancel` | — | `boolean` |
| `panel:open` | `{ name: 'sidebar' \| 'transport' }` | `{ ok, reused? }` |
| `panel:close` | `name` | `{ ok }` |
| `panel:info` | — | `{ name, labels }` (panel windows) |

**Panel window channels** (`lib/panels.js`, `panel-preload.js`):

| Channel | Direction | Payload |
| --- | --- | --- |
| `panel:ready` | panel → main → renderer | asks the main renderer for a first snapshot |
| `panel:close-self` | panel → main | the panel's own Dock button |
| `panel:state` | renderer → main → panel | `{ panel, data }` (snapshot, see `sidebarSnapshot()`/`transportSnapshot()`) |
| `panel:cmd` | panel → main → renderer | `{ panel, action, … }` (routed by `onPanelCommand`) |
| `panel:closed` | main → renderer | `{ panel }` — title-bar close, docks the pane back |

**Push events** (subscribe via preload):

| Event | Payload |
| --- | --- |
| `export:progress` | `{ percent, timeSec, totalSec, speed, fps }` |
| `thumbs:progress` | `{ path, percent, frame, count }` |
| `proxy:log` | ffmpeg stderr chunk |
| `nsfw:progress` | `{ phase: 'model'\|'download'\|'loading'\|'scan', percent, message, index, expected, score, flag }` |

### `ExportRequest`

```js
{
  outputPath, container,           // FORMATS key (lib/formats.js)
  segments: [{ path, start, end, hasAudio }],  // ms, in output order
  width, height, fps,              // target normalised format
  videoCodec, crf, preset, audioBitrate,
  burnSubtitles: boolean,
  subtitleSrt: string              // remapped SRT text, only when burning
}
```

`container` is one of `mp4 · mov · mkv · webm · avi · wmv · flv · ts` (`lib/formats.js`).
That table decides the muxer (`-f`), the audio encoder (`aac`, `libopus`, `libmp3lame`,
`wmav2`), the sample rate, whether `+faststart` applies, and which video encoders are legal.
`buildEncoderArgs()` silently falls back to the container's default encoder so a hand-edited
job can never pair WebM with x264. The renderer mirrors the table in `EXPORT_FORMATS`
(`src/app.js`) to build the Format → Video codec dropdowns and the save-dialog filters —
**edit both lists together**. `lib/selftest.js` muxes one clip in every format.

---

## preload API

`window.api` (see `preload.js`):

```
getInfo, setSettings
openVideos, openSubtitle, openFile, saveFile
probe, thumbs, proxy
readText, writeText
clipboardWrite, clipboardRead
exportVideo, cancelExport
showItem
mediaUrl(path)                    // -> 'media://local/<encodeURIComponent(path)>'
onExportProgress(cb), onThumbsProgress(cb), onProxyLog(cb)   // return unsubscribe fn
panelOpen({name}), panelClose(name), sendPanelState({panel,data})
onPanelReady(cb), onPanelClosed(cb), onPanelCommand(cb)
```

`window.panelAPI` (`panel-preload.js`, detached windows only):

```
info(), ready(), onState(cb), send(action, data), close()
```

---

## Media protocol (`media://`)

`lib/media-protocol.js` registers a privileged scheme
(`standard, secure, supportFetchAPI, corsEnabled, stream, bypassCSP`).

URL shape: `media://local/<encodeURIComponent(absolutePath)>`.

The handler implements **HTTP range requests** itself. This matters: Chromium only allows
seeking inside a `<video>` when the source advertises `Accept-Ranges: bytes` and answers
`Range:` with `206 Partial Content`. (Using `net.fetch('file://…')` alone left the video
unseekable — every seek snapped back to 0.)

Behaviour:

- parses `Range: bytes=start-end` (open-ended and suffix `bytes=-N` supported),
- returns `206` with `Content-Range`, `Content-Length`, `Accept-Ranges`,
- `416` for unsatisfiable ranges,
- streams via `Readable.toWeb(fs.createReadStream(...))`,
- MIME table for video/audio/image/subtitle extensions.

---

## Export pipeline

### `lib/exporter.js` (pure, unit-testable)

`buildFilterGraph(req, uniquePaths, pathIndex)` builds a normalise-and-concat graph:

```
[i:v]trim=start=..:end=..,setpts=PTS-STARTPTS,scale/pad/setsar/fps,format=yuv420p[vN]
[i:a]atrim=start=..:end=..,asetpts=PTS-STARTPTS,aresample/aformat[aN]
[v0][a0][v1][a1]…concat=n=K:v=1:a=1[vc][ac]
[vc]subtitles='<escaped path>'[vb]        # only when burning
```

- Every video leg is forced to the same `W×H`, SAR 1 and fps so `concat` accepts it
  (`force_original_aspect_ratio=decrease` + `pad`).
- Every audio leg is forced to 48 kHz / stereo / `fltp`.
- Segments from a source **without audio** pull from an `anullsrc` lavfi input trimmed to
  the segment length, so concat always has matching audio.
- `escapeFilterPath()` handles Windows drive colons and quotes inside the filtergraph.

`buildEncoderArgs(req)` returns codec/quality/audio args (`libx264`, `libx265` + `hvc1` tag,
`h264_nvenc` / `hevc_nvenc` with `-rc vbr -cq …`), plus `-pix_fmt yuv420p` and AAC audio.

Also exported: `even` (round to even, H.264 requirement), `parseRate` (`"30000/1001"` → number).

### Orchestration (`lib/ipc.js` → `doExport`)

Arg order: `-hide_banner -loglevel warning -nostdin -y`, one `-i` per **unique** source,
optional `-f lavfi -i anullsrc=…`, `-filter_complex`, `-map [v] -map [a]`, encoder args,
`-movflags +faststart` (mp4/mov), container `-f`, then `-progress pipe:1 -nostats <out>`.

Progress is parsed from ffmpeg's `-progress` stream: `out_time_us` (or `out_time_ms`, which
is **also microseconds** in ffmpeg) divided by `1e6`, throttled to ~80 ms, and emitted as
`export:progress`.

### Cancellation (Windows-safe)

Package-manager ffmpeg installs (Chocolatey, Scoop, winget) are **shims** that launch the
real `ffmpeg.exe` as a child, so `child.kill()` only kills the shim. Cancellation therefore:

1. `taskkill /pid <pid> /T /F` — kills the shim **and** its tree,
2. `killNewFfmpeg(preexisting)` — a `tasklist` snapshot taken at export start, then
   `taskkill` any `ffmpeg.exe` PID that appeared afterwards (catches re-parented encoders).
   Pre-existing ffmpeg processes belong to other apps and are never touched,
3. deletes the half-written output file,
4. removes temp subtitle directories in a `finally`.

`export:cancel` also stops concurrent thumbnail/proxy jobs so no ffmpeg keeps running.

---

## NSFW scene detection (`lib/nsfw.js`)

The **Parental AI** button (NSFW detector) samples the active clip's source and turns flagged
frames into cut ranges. It is entirely local — inference runs in the main process via
`onnxruntime-node`.

### Model choice

The task named `Falconsai/nsfw_image_detection`, but that repo publishes **only PyTorch /
safetensors weights** and no ONNX export, so Transformers.js / onnxruntime cannot load it. A
Hugging Face search for ONNX NSFW classifiers returns exactly two models; CUCI uses
`AdamCodd/vit-base-nsfw-detector` (ViT-base, binary `{0: sfw, 1: nsfw}`, ~790k downloads).

| | |
| --- | --- |
| file | `onnx/model_quantized.onnx` (int8, ~84 MB) |
| input | `pixel_values` `float32[1,3,384,384]` (note: **384**, not 224) |
| output | `logits` `float32[1,2]` |
| norm | mean/std `[0.5,0.5,0.5]`, scale `1/255` |

Model lookup order: `CUCI_NSFW_MODEL_DIR` (legacy `CUCI2_` accepted) → `vendor/nsfw/` → `<userData>/models/nsfw/`
(downloaded there on first use, resumable via `curl -C -` with a `fetch` fallback).

### Pipeline

1. ffmpeg emits raw frames directly at the model's input size —
   `-vf fps=1/<interval>,scale=384:384:force_original_aspect_ratio=decrease,pad=…,format=rgb24
   -f rawvideo -` — so there is **no image-decoding dependency** (no sharp/canvas). The 384²×3
   byte frames arrive on stdout and are classified one by one as they stream in (natural
   backpressure via `for await` on the child stream).

   The sampling is purely interval-based (`fps=1/<interval>`): **the timeline keyframe
   snapshots are never reused** — they are 64 px tall and only sampled ~170 times across the
   whole clip, which is far too sparse/low-res for classification. Interval is configurable
   from 0.25 s to 60 s (`nsfwIntervalMs`), clamped in the renderer (`nsfwIntervalSeconds()`)
   and again in `settings:set`. Frame counts scale exactly with the interval.
2. `frameToTensor()` converts each RGB frame to planar, normalised CHW `Float32Array`.
3. `classifyFrame()` runs the session and softmaxes the logits; the `nsfw` probability is the
   score.
4. `groupDetections(samples, intervalMs, durationMs, { threshold, minDurationMs, padMs })`
   merges **consecutive** above-threshold samples into ranges. A sample at index `i` covers
   `[i*interval, i*interval + interval)`; ranges are padded, clamped to the duration, and
   filtered by minimum length. This function is pure and unit-tested.

The scan is cancellable (`nsfw:cancel` sets a flag; the ffmpeg child is killed) and streams
`nsfw:progress` for the status bar and the modal's progress bar.

The renderer only *reviews* results: `applyNsfwSegments(ranges)` pushes an undo entry, adds the
cuts, normalises/merges them and re-renders.

## Job trust boundary (`src/job.js`)

Job files, share codes and clipboard payloads are **untrusted input**. `src/job.js` is the only
code that turns them into data the app acts on, and it is deliberately paranoid:

| Threat | Mitigation |
| --- | --- |
| Oversized input / memory exhaustion | code ≤ 1 MB · compressed ≤ 1 MB · decompressed ≤ 4 MB · `.json` files read with a 4 MB `maxBytes` cap (`fs:readText`) |
| Decompression bomb | the deflate stream is read incrementally and cancelled the moment output exceeds 4 MB |
| Script execution | no `eval`, `Function` or dynamic import anywhere on the path — only `JSON.parse` |
| Prototype pollution | `JSON.parse` reviver drops `__proto__` / `constructor` / `prototype`; `fromCompact()` and `sanitizeJob()` construct fresh objects containing only known fields |
| Type confusion / injection | every field is type-checked and coerced; numbers must be finite and are clamped; export enums (container, codec, preset, resolution, fps, bitrate) are whitelisted |
| Resource exhaustion via UI | arrays and totals are capped: 200 clips, 5 000 cuts/clip (50 000 total), 100 000 events/clip (500 000 total) |
| Control characters | stripped from all strings; names collapsed to one line; description ≤ 200 chars; subtitle text ≤ 2 000 chars |
| SRT/VTT cue injection | blank lines are collapsed and `-->` is replaced with `→`, so body text can never terminate a cue or create a new one. The same cleaning runs in `serializeSrt()` / `serializeVtt()`, covering subtitle files too |
| HTML/XSS in the UI | every job-derived string is rendered with `textContent` or `CU.escapeHtml()`; job data is never interpolated into `innerHTML` |

`applyJob()` calls `sanitizeJob()` again (defence in depth), so any future caller is safe even if
it forgets to validate first. The renderer only ever applies cuts, a subtitle offset and export
*options* — job data cannot select a file path, spawn a process or reach the filesystem.

Covered by `lib/test-job.js` (unit) and the e2e `job xss guard` step, which imports a hostile
plain share code through the real UI and asserts no script ran, no markup was injected and no
extra subtitle cue was created.

### Multiple subtitle tracks

Each clip holds `subtitles: [{id, path, name, format, events, enabled}]` and an
`activeSubtitleId` (the track shown in the panel, timeline lane and preview). The subtitle
dialog uses `multiSelections`, so one pick can add several files at once.

- `remapTrack(clip, track)` remaps one track using that clip's base offset.
- `computeRemaps()` (cached until `invalidate()`) produces `{ tracks, all }`; `remapAllTracks()`
  returns one entry per **enabled** track in clip order, and `remapAll()` is the flattened list.
- Export writes one `.srt` per enabled track (`<output>.srt` for a single track, otherwise
  `<output>.<track-name>.srt`) and burns only the track selected in the export dialog.
- Disabled tracks are skipped by remapping/export but keep their events for re-enabling.

## Renderer architecture

`src/app.js` is one IIFE with three layers:

```
state          mutable app state (clips, selection, in/out, playhead, settings, …)
render*        renderAll() / renderTimeline() (base) / renderOverlays() (cheap)
wire()         DOM event wiring, IPC subscriptions, keyboard shortcuts
```

### Key state

```js
state = {
  clips: [ { id, path, name, fileSize, durationMs, fps, width, height, hasAudio,
             cuts:[{id,start,end}],
             subtitles:[{id,path,name,format,events,enabled}], activeSubtitleId,
             thumbs, proxyPath } ],
  activeClipId, selection:{clipId,start,end}|null, inPoint, outPoint,
  playhead, resultTime, playMode:'source'|'result', snap, zoom, pxPerMs,
  globalSubOffset, settings:{loadThumbs}, jobDescription, pendingJob,
  scrubbing, undo[], redo[], exporting
}
```

Derived helpers: `keptRanges(clip)` (duration minus cuts), `programRanges()` (all clips in
order → flat list of `{clipId, srcStart, srcEnd, outStart, outEnd}`), `remapAll()` (cached
merged subtitle list).

### Layout: player / timeline splitter

`.timeline-wrap` height comes from the `--timeline-h` CSS variable (default 260px). The thin
handle at the top of the transport (`#playerSplitter`) drags it: dragging **down** grows the
player and shrinks the timeline, and vice versa. The transport bar's empty background works
as a handle too. The value is clamped so the player keeps at least 120px, persisted in
`localStorage["cuci.timelineHeight"]`, re-clamped on window resize, and reset to 260 on
double-click.

The timeline's internal bands are height-relative: the filmstrip runs from the 26px ruler to
`calc(var(--subs-h) + 4px)` above the bottom, and the subtitle lane is pinned to the bottom
(62px). Nothing inside needs re-rendering when the split changes.

### Layout: pin (auto-hide) / detach panes

Each pane carries a flat `[pin][detach]` pair in its own header — side panel
(`#btnPinSidebar`/`#btnDetachSidebar`) and control center
(`#btnPinTransport`/`#btnDetachTransport`). There is no global layout toolbar.

- **pinned** (default) → `layout.<pane>.pinned = true`, docked and always visible.
- **unpinned** → the pane is `display: none` (`body.hide-<pane>`) and the player takes the
  space. Moving the pointer over `.player-wrap` fades in `.reveal-bar` chevrons (`›` on the
  left edge, `^` at the bottom).
- **peek** → clicking a chevron opens the pane as a **temporary slide-over drawer**
  (`body.peek-<pane>`, `position: fixed`, z-index 45) — it is *not* a pin. It closes when the
  pointer leaves it (260 ms grace, deferred while a mouse button is held), when the player is
  clicked, when the window loses focus, or on `Escape`. Only the pin button makes it stay.
- **detached** → `body.detach-<pane>`; the pane moves into its own OS window (see below).
  Detaching pins implicitly.
- **The timeline belongs to the control center** (`paneState('timeline')` mirrors
  `layout.transport`): it is pinned/hidden/peeked with it and it is **rendered inside the
  control center window** when detached, so the two are always one pane.
- Hidden/detached/peeked panes leave the CSS grid, so `.main`'s `1fr` player row absorbs the
  space (`body.hide-sidebar`/`detach-sidebar`/`peek-sidebar` collapse `.layout` to one
  column). The peek drawers are sized from `--topbar-h`, `--status-h` and (for the controls)
  `--transport-h`, set by `measureChrome()`.
- State persists in `localStorage["cuci.layout"]` as
  `{ sidebar|transport: { pinned, detached } }` (legacy `hidden` entries are still read); a
  peek is never persisted. Windowed panes reopen on the next launch.
- Shortcuts: `Ctrl+1`/`Ctrl+2` pin-toggle sidebar/controls, `Ctrl+Shift+1`/`Ctrl+Shift+2`
  detach-toggle them. The splitter is disabled while the controls are hidden/detached.

### Detached panel windows

`lib/panels.js` owns the windows; `src/panel.html` + `src/panel.js` + `src/panel.css` render
them (same `styles.css` widgets, so they look identical to the docked panes). Each panel is a
**thin view over the main renderer** — the main renderer stays the single source of truth
for state, ffmpeg and export:

```
main renderer --api.sendPanelState--> panels.js --'panel:state'--> panel window
panel window --'panel:cmd'--> panels.js --'panel:cmd'--> main renderer (onPanelCommand)
```

- The panel preload is `panel-preload.js` (exposes `window.panelAPI`: `info`, `ready`,
  `onState`, `send`, `close`) — deliberately tiny; panels never get `api.*`.
- `panel:ready` is the handshake: a fresh window asks for a snapshot; `app.js` answers with
  `pushPanelState(name)`. `panel:closed` (title-bar X) docks the pane back into the main
  window; the panel's own **Dock** button sends `panel:close-self`.
- Snapshots carry a `kind`: `main` (per-pane view model) or `timeline`.
  `sidebarSnapshot()` (clips, cuts, subtitle tracks/rows) and `transportSnapshot()`
  (timecodes, seek ratio, mode, in/out, selection, zoom) are coalesced through
  `scheduleSidebarSync()` (40 ms) / `scheduleTransportSync()` (60 ms); `timelineSnapshot()`
  (duration, cuts, subtitle blocks, filmstrip) goes through `scheduleTimelineSync()` (120 ms,
  triggered from `renderTimeline()`). Only built while the matching window is open.
- Commands (`onPanelCommand`) are validated then routed into the existing handlers:
  `click` with an id from `PANEL_CLICK_IDS` → `els[id].click()`; plus `seek`, `zoom`, `snap`,
  `activate`, `clip`, `cutDelete`, `cutHover`, `seekTo`, `subOffset`, `subToggle`,
  `subActivate`, `subRemove`. Cut/track/clip ids are checked against current state first.
- The control center window also renders the timeline (`#ptlTimeline`, reusing the `.tl-*`
  widgets): `src/panel.js` draws the ruler/filmstrip/cuts/subtitle lane and sends `select`
  (drag), `seekTo` (click / playhead drag) and `mark` (double-click → In then Out). Zoom comes
  from the transport snapshot; the view auto-scrolls with the playhead while playing.
- Bounds live in `settings.json` under `panels.<name>` (`panel:open` falls back to defaults
  beside the main window; off-screen bounds are rejected so an unplugged monitor cannot hide
  a panel). Panels are not parented, so they are free to move to another display.

### Rendering

- `renderTimeline()` → `buildBase()` (ruler ticks, filmstrip `<img>`, cut blocks, subtitle
  lane, filmstrip placeholder) **plus** `renderOverlays()` (selection, In/Out markers,
  playhead). Split so drags only repaint the cheap overlay.
- `postTick()` runs on `timeupdate` (playhead, transport, subtitle overlay, autoscroll).
- Timeline is source-time based; the playhead jumps across removed ranges in *Result* mode.

### Preview modes

- **source** — the `<video>` plays the raw file.
- **Preview** (internally `playMode: 'result'`, the template button is `#modeResult`) —
  `program.ranges` is played back by seeking between kept segments; crossing a
  segment boundary advances `program.idx` (and switches `src` if the next segment is another
  clip). `state.resultTime` tracks output time.

Seeking in result mode:
- the scrubber calls `seekResult(outputMs)`, which pauses, finds the range containing that
  output time and seeks the `<video>` to `srcStart + (outputMs - outStart)`.
- the timeline is **source-time** based, so a click/scrub there goes through
  `sourceToResultMs(clipId, srcMs)` first (inside a cut it snaps to the next kept frame).
  `seekTo()` branches to `seekResult()` in result mode; without that the playhead moved but
  the preview stayed put.
- `programPlay(fromResultMs)` must **keep** the requested output position inside the found
  range (`resultTime = clamp(target, outStart, outEnd)`). It used to snap to `outStart`, which
  made every seek restart from 0:00 — the e2e "result seek" case guards this.

### Appearance: theme & language

**Theme** (`src/app.js`): `applyTheme('system' | 'dark' | 'light')` writes
`<html data-theme="dark|light">` (system is resolved through
`matchMedia('(prefers-color-scheme: dark)')`, with a `change` listener so Windows theme
switches apply live). The palette lives in `:root` (dark) and `:root[data-theme='light']`
in `styles.css` — components read `var(--panel)`, `var(--text)`, … so a new surface should
use those variables instead of hard-coded colours. Persisted in
`localStorage["cuci.theme"]` **and** `settings.json` (`theme`).

**Language** (`src/i18n.js`, loaded before `app.js` / `panel.js`):

- `CU.i18n.DICT[lang][key]` holds the strings; `en` is the fallback for any missing key.
- Markup uses `data-i18n` (textContent), `data-i18n-title`, `data-i18n-placeholder` and
  `data-i18n-aria`; `apply(lang)` rewrites them and sets `<html lang|dir>` (`ar` → RTL).
- Strings the renderer generates use `CU.i18n.t('key')` (aliased as `t()` in `app.js`);
  the sidebar/cut/subtitle empty states, the In/Out readout and the idle status are the
  ones that matter.
- `resolve(preferred)` uses the explicit choice, else the system locale
  (`navigator.languages`), else English. `localStorage["cuci.lang"]` gives an instant boot;
  `settings.json` (`language`) is the durable value shown in Settings.
- Detached panel windows apply `localStorage` on boot and follow the `lang` field that the
  main window includes in every `panel:state` snapshot.
- Adding a language: add it to `LANGS` + a `DICT` entry with all keys (the key set is
  `Object.keys(DICT.en)`), and add the code to the e2e appearance check if it is a big one.
- `src/guide-i18n.js` adds the user-guide and import-dialog keys and `src/messages-i18n.js`
  adds the settings-page/notification keys, both through `CU.i18n.extend({...})` (loaded after
  `i18n.js`); keep their key sets in sync across all 14 languages too.
- Renderer messages use `t('msg…')`; strings with values use `tf('msg…', { n, name })`
  (`{placeholder}` substitution). Missing keys fall back to English.

### Build script

`build.ps1` (repo root) wraps the release flow: Node check → `npm install` when
`node_modules` is missing → SHA-256 source hash → patch-version bump + `.last-build-hash`
→ `npm test` → clean `dist/` and `.build/` → **`scripts/obfuscate.mjs`** stages `.build/app`
(renderer JS obfuscated; `node_modules` + `vendor` junctioned so deps and `extraResources`
resolve) → **`scripts/verify-build.cjs`** boots that stage in Electron and checks CUCI
helpers, preload API, i18n switching, theme, media probing and a cut → `node
node_modules/electron-builder/cli.js` for `-Installer`/`-Portable` with
`--config.directories.app=.build/app` (never the `.cmd` shim → EINVAL) → `node
scripts/build-msix.mjs [--appx] --app-dir .build/app` for `-Store`/`-Appx` → optional `-Sign`
via `signtool.exe` and a self-signed `certs/code-signing.pfx`.

`npm run dist`, `npm run store:package`, `npm run store:appx` and `npm run store:stage`
obfuscate first as well, so no packaging path ships readable renderer code. Use
`-NoObfuscate` only for debugging.

`scripts/msix-tools.mjs` locates `makeappx.exe` (vendor copy → Windows SDK → PATH) and, when
missing, downloads the Microsoft Windows SDK BuildTools NuGet package once into
`vendor/msix-tools/` and extracts it with a small zip reader (no extra npm dependency).
`build-msix.mjs` packs with it and then verifies the archive with `makeappx unpack`.

### Settings (auto-applied)

`#settingsModal` is grouped into **Appearance** (theme, language), **Editor** (filmstrip
thumbnails + hint) and **ffmpeg** (hint, paths, prefer-bundled, Re-detect/Fill, and a
translated `ffmpeg`/`ffprobe`/`bundled` status table). There is **no Save button**:
`persistSettings()` debounces 150 ms, calls `settings:set`, flashes `#setSaved` and refreshes
`app:info` so `state.settings` stays current. Theme/language are applied instantly by their
change handlers; the stored appearance is applied once in `refreshInfo()` (guarded by
`appearanceApplied`) so a background refresh cannot undo a fresh choice.

### Subtitle text list

`#btnToggleSubEvents` collapses `#subEventList` (default expanded, persisted in
`localStorage["cuci.subEvents"]`); the button carries `aria-expanded` and a translated
Collapse/Expand title. The detached side panel has the same control (`panel.js`).

### User guide + job import confirmation

- **User guide** (`#guideModal`, topbar **?** or **F1**): static markup with `data-i18n`
  attributes — sections for getting started, cutting, preview, subtitles, Parent Assist,
  export, jobs, workspace, a shortcut table (`<kbd>`) and tips. It is translated by the same
  `CU.i18n.apply()` pass, so no JS rendering is involved.
- **Import confirmation**: `openJobFile()` / `importShareCode()` never apply a payload
  directly. `requestJobImport(text, label)` runs `CU.parseJobText()` (byte caps + bounded
  inflate) and `CU.sanitizeJob()` (whitelists, length caps, plain strings), builds a preview
  with `findClipForEntry()`, then shows `#confirmModal` — description, clips, cuts, subtitle
  tracks, matched/missing videos and the export format — and only calls `applyJob()` when the
  user confirms. Every value in the dialog is written with `textContent`; job text is never
  passed to `innerHTML`.

### Debug handle

`init()` exposes `window.__cuciApp = { state, api, CU, addVideos, loadSubtitleFromPath,
keptRanges, programRanges, remapAll, applyThumbSetting, buildJob, applyJob,
encodeShareCode, decodeShareCode, addCut, removeCut, renderAll, seekTo, currentSetup,
setPanelPinned, setPanelDetached }`.
Used by `lib/e2e.js` and handy in DevTools.

---

## Subtitle model

`src/srt.js` (attached to `window.CUCI`):

| Function | Purpose |
| --- | --- |
| `parseSubtitles(text)` | parses SRT **and** WebVTT into `{ format, events:[{start,end,text}] }` (ms) |
| `serializeSrt(events)` | events → SRT text |
| `serializeVtt(events)` | events → VTT text |
| `rangeOutputOffsets(ranges)` | cumulative output start of each kept range |
| `remapEvents(events, ranges, baseOffset, globalOffset)` | source→output mapping (below) |
| `droppedEvents(events, ranges)` | events fully inside cuts (for UI colouring) |

### The remap formula

For kept ranges `r_0..r_{n-1}` (source ms), the output start of range `i` is the cumulative
kept length before it:

```
rangeOutputOffsets[i] = Σ_{j<i} (r_j.end - r_j.start)
```

An event overlapping range `i` maps its overlap `[s,e]` (where `s = max(ev.start, r_i.start)`)
to:

```
outStart = baseOffset + rangeOutputOffsets[i] + (s - r_i.start) + globalOffset
outEnd   = baseOffset + rangeOutputOffsets[i] + (e - r_i.start) + globalOffset
```

`baseOffset` is the total kept length of all **previous clips** in the join order (0 for a
single clip). An event spanning a boundary produces one output event per overlapped range.

> **Regression note:** an early version omitted `rangeOutputOffsets[i]`, which shifted every
> post-cut subtitle too far left. Keep the e2e `subtitle remap` assertion green
> (`DUMMY 07` at source 2:30 must land at output 0:45).

---

## Data formats

### Settings (`<userData>/settings.json`)

```json
{
  "ffmpegPath": "", "ffprobePath": "", "loadThumbs": false, "preferBundled": false,
  "nsfwThreshold": 0.3, "nsfwIntervalMs": 2000, "nsfwMinDurationMs": 5000
}
```

Empty paths mean "auto-detect" (system, then bundled). `loadThumbs` and `preferBundled`
default to `false`; the `nsfw*` keys remember the last scan settings.

NSFW defaults are deliberately aggressive — sensitivity `0.3` (the slider minimum) and a
5 s minimum cut length — so brief scenes are not missed. Raise the threshold if the first
pass produces too many false positives.

### Cut job — verbose (`.cuci.json`; old `.cuci2.json` files still load)

```json
{
  "app": "CUCI", "kind": "cut-job", "version": 1,
  "created": "2025-01-01T00:00:00.000Z",
  "description": "Remove the intro and the sponsor break.",
  "subOffsetMs": -250,
  "export": { "container":"mp4", "videoCodec":"libx264", "crf":20, "preset":"medium",
              "resolution":"source", "fps":"source", "audioBitrate":"192k",
              "burnSubtitles":false, "writeSrt":true },
  "clips": [
    { "name":"bbb.mp4", "size":276134947, "durationMs":634600, "fps":30,
      "width":1920, "height":1080, "hasAudio":true,
      "cuts": [[60000,154000]],
      "subtitles": [
        { "name":"bbb.en.srt", "format":"srt", "events": [[1000,4000,"Hello"]] },
        { "name":"bbb.id.srt", "format":"srt", "events": [[1000,4000,"Halo"]] }
      ] }
  ]
}
```

`subtitles` is an array (one entry per track). Jobs produced by older versions used a
singular `"subtitle": {...}`; `sanitizeJob()` still accepts that and normalises it to a
one-element array.

`subtitle.events` is `null` unless the user chose to embed subtitles.

### Cut job — compact (share code payload)

Short keys, used **only** inside the share code:

| Verbose | Compact |
| --- | --- |
| `app` | `a` |
| `version` | `v` |
| `created` | `t` |
| `description` | `D` |
| `subOffsetMs` | `o` |
| `export` | `e` = `[container, videoCodec, crf, preset, resolution, fps, audioBitrate, burn?1:0, writeSrt?1:0]` |
| `clips` | `c` = `[{ n, z(size), d(durationMs), f(fps), w, h, A(hasAudio 1/0), x:[[s,e]], u }]` — `u` is `{n,f,v}` for one track (legacy-compatible) or an array of those for multiple tracks |

### Share code

```
CUCI-1<z|p>.<base64url(bytes)>   (legacy CUCI2-1 codes still import)
  z = deflate-raw(JSON)   (CompressionStream)
  p = plain JSON          (fallback if CompressionStream is unavailable)
```

`encodeShareCode` / `decodeShareCode` in `src/app.js`. `fromCompact` also accepts the verbose
form, so `.json` files and share codes both flow through `applyJob`.

---

## Status bar API

`src/app.js` exposes one entry point:

```js
setStatus(text, level = 'info', { progress, timeout, log })
// level: 'idle' | 'info' | 'busy' | 'ok' | 'warn' | 'error'
// progress: 0..1  -> shows the thin progress bar
// timeout: ms before reverting to 'Ready' (defaults: ok 4s, info 6s)
// log: false      -> don't add to the click-to-open history
```

- `error` / `warn` are **sticky** (cleared by the ✕ or a new status).
- `busy` shows a spinner.
- `updateStatusInfo()` prints the active clip on the right (`index/total · name · WxH · fps ·
  kept/total`).
- `toast(msg, 'error'|'warn')` also routes into the status bar.

Progress sources: thumbnails (`thumbs:progress`), export (`export:progress`), and proxy
generation (busy status with a spinner).

---

## Testing

```bash
npm test            # all four suites, in order
npm run test:export # node lib/selftest.js
npm run test:smoke  # electron lib/smoke.js
npm run test:e2e    # electron lib/e2e.js
npm run test:cancel # electron lib/test-cancel.js
```

| Suite | What it covers |
| --- | --- |
| `test:locate` | the ffmpeg resolution chain: default finds *something*, a bogus custom path falls through, `preferBundled` selects the vendored build and it reports `libass` |
| `test:job` | cut-job trust boundary: round-trip, size caps, zip bomb, prototype pollution, numeric clamps, array caps, text sanitising, SRT injection, export whitelist |
| `test:nsfw` | tensor normalisation, softmax and range grouping (always); plus a real scan of a generated clip when the ONNX model is present |
| `selftest` | builds sample clips (mixed resolution, one silent), joins them with the production filtergraph, asserts output duration (~6 s) and streams |
| `smoke` | loads the real `src/index.html` in a hidden window; fails on any renderer console error |
| `e2e` | loads a generated video, checks snapshots are **off** by default then enables them, verifies filmstrip, double-click In/Out, subtitles + cut remap, seek/step, context menu, job codec round-trip, status bar, export guard, and a burn-in export (`5.000 s`) |
| `cancel` | starts a deliberately slow 4K `veryslow` export, cancels it, asserts **0** ffmpeg processes remain (immediately and after 3 s), the partial output is deleted and temp dirs are cleaned |

Notes:

- The e2e/cancel harnesses call `app.setPath('userData', <temp>)` so they never touch your
  real `settings.json`.
- The cancel test compares against a **baseline** ffmpeg process count, so it won't kill or
  count other applications' ffmpeg jobs.
- `lib/exporter.js` is pure and imported by both `lib/ipc.js` and `lib/selftest.js`, so the
  command-builder is exercised without spawning Electron.

### Sample media

The `Sample/` folder is **entirely gitignored** — it exists only on your machine for manual
testing. Nothing in it (videos, subtitles, scratch images, generated jobs) is committed.

The automated tests do **not** use it: `lib/e2e.js` generates its own short clip with
ffmpeg into a temp dir, so `npm test` works on a fresh clone with no fixtures.

To recreate a manual fixture, drop any ~10 minute 1080p clip in as `Sample/bbb.mp4` — e.g.
Big Buck Bunny (CC-BY, Blender Foundation):

```
https://download.blender.org/peach/bigbuckbunny_movies/
```

Then create `Sample/bbb.srt` with a dummy track (a handful of events, ideally including
some inside the ranges you plan to cut and one spanning a cut boundary) to exercise
subtitle remapping by hand.

---

## Packaging

`package.json` contains an `electron-builder` `build` block (Windows NSIS + portable, macOS
dmg, Linux AppImage). `predist` runs the ffmpeg fetcher with `--strict`, so a release build
always contains the bundled binaries.

The asar holds only `main.js`, `preload.js`, `lib/**`, `src/**` and `package.json`; the
vendored ffmpeg is shipped outside it via:

```json
"extraResources": [{ "from": "vendor/ffmpeg", "to": "ffmpeg" }]
```

which lands at `<resources>/ffmpeg/ffmpeg[.exe]` — exactly where `bundledBin()` looks first.

```bash
npm i -D electron-builder
npm run dist
```

---

## Common recipes

**Add an IPC channel**
1. `ipcMain.handle('ns:action', …)` in `lib/ipc.js` (inside `registerIpc`).
2. Expose it in `preload.js` (`ipcRenderer.invoke('ns:action', …)`).
3. Call `window.api.nsAction(…)` from `src/app.js`.

**Add a settings toggle**
1. Add the key to the `settings` defaults in `lib/ipc.js` and handle it in `settings:set`.
2. Add a control to `#settingsModal` in `src/index.html`.
3. Read it in `refreshInfo()` (`state.settings = …`) and apply it in the Save handler.

**Add a timeline context-menu item**
Extend `buildContextItems(t, cutId)` in `src/app.js`; it returns `{ label, hint, key,
disabled, danger, action }` entries (or `{ sep: true }`). The menu is rendered by
`showContextMenu()`.

**Add a cut action**
Reuse `getEditRange()`, `addCut(start, end)`, `clearMarks()`, `clearCuts()`,
`applyDoubleClickMark(t)` in `src/app.js`, and remember to `invalidate()` the `remapAll()`
cache after mutating cuts.

---

## Conventions

- No bundler / transpiler / framework. Keep renderer files loadable as classic scripts and
  attach shared helpers to `window.CUCI`.
- Times are **milliseconds**, integers or floats rounded to 3 decimals. Never pass seconds
  around the app; convert only at the ffmpeg boundary.
- All ffmpeg args are passed as `spawn` **arrays** (no shell) — never build a shell string.
- Escape filter paths with `escapeFilterPath()`; never interpolate raw Windows paths into a
  filtergraph.
- Prefer `setStatus` over silent work for anything that takes longer than a moment.
- Don't add PowerShell/WMI process enumeration (see cancellation).
- Keep user-facing docs in `README.md` and technical detail here.

---

## Known constraints

- Preview is limited to Chromium-supported codecs; use the proxy for MKV/HEVC/ProRes.
- Export always re-encodes (frame-accurate cuts + heterogeneous sources).
- `ass`/`ssa` are not fully parsed — only SRT-style timestamped lines; convert to SRT first.
- Burning subtitles requires an ffmpeg build with libass.
- The filmstrip decodes the whole file, hence it is opt-in (`loadThumbs`).
