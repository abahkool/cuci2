# CUCI² — Development Reference

Technical guide for working on CUCI². For the user-facing guide see
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
lib/
  ipc.js                all ipcMain handlers, settings, export orchestration
  exporter.js           pure ffmpeg filtergraph/encoder builders  ← unit-testable
  ffmpeg-locate.js      resolves custom/env/system/bundled ffmpeg+ffprobe
  nsfw.js               ONNX NSFW scene detection (sampling + inference + grouping)
  media-protocol.js     seekable media:// handler (HTTP range support)
  selftest.js           export-pipeline test against real ffmpeg   (node)
  test-locate.js        verifies the tool resolution chain         (node)
  test-nsfw.js          NSFW tensor/grouping unit tests + live scan (node)
  smoke.js              boots the real renderer, fails on console errors
  e2e.js                full UI flow test (load → subtitle → cut → seek → export → job)
  test-cancel.js        verifies cancel kills ffmpeg + removes residue
scripts/
  fetch-ffmpeg.mjs      downloads a recent ffmpeg into vendor/ (postinstall)
vendor/
  ffmpeg/               bundled binaries (gitignored — npm run fetch:ffmpeg)
src/
  index.html            UI markup
  styles.css            dark theme, timeline, modals, status bar, context menu
  util.js               window.CUCI: time formatting + small helpers
  srt.js                window.CUCI: subtitle parse / serialise / remap
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
- `CUCI2_SKIP_FFMPEG_FETCH=1` — skip entirely (useful in CI).

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
  outputPath, container,           // 'mp4' | 'mkv' | 'mov'
  segments: [{ path, start, end, hasAudio }],  // ms, in output order
  width, height, fps,              // target normalised format
  videoCodec, crf, preset, audioBitrate,
  burnSubtitles: boolean,
  subtitleSrt: string              // remapped SRT text, only when burning
}
```

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
Hugging Face search for ONNX NSFW classifiers returns exactly two models; CUCI² uses
`AdamCodd/vit-base-nsfw-detector` (ViT-base, binary `{0: sfw, 1: nsfw}`, ~790k downloads).

| | |
| --- | --- |
| file | `onnx/model_quantized.onnx` (int8, ~84 MB) |
| input | `pixel_values` `float32[1,3,384,384]` (note: **384**, not 224) |
| output | `logits` `float32[1,2]` |
| norm | mean/std `[0.5,0.5,0.5]`, scale `1/255` |

Model lookup order: `CUCI2_NSFW_MODEL_DIR` → `vendor/nsfw/` → `<userData>/models/nsfw/`
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
             cuts:[{id,start,end}], subtitle:{name,format,events}|null, thumbs, proxyPath } ],
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
`localStorage["cuci2.timelineHeight"]`, re-clamped on window resize, and reset to 260 on
double-click.

The timeline's internal bands are height-relative: the filmstrip runs from the 26px ruler to
`calc(var(--subs-h) + 4px)` above the bottom, and the subtitle lane is pinned to the bottom
(62px). Nothing inside needs re-rendering when the split changes.

### Rendering

- `renderTimeline()` → `buildBase()` (ruler ticks, filmstrip `<img>`, cut blocks, subtitle
  lane, filmstrip placeholder) **plus** `renderOverlays()` (selection, In/Out markers,
  playhead). Split so drags only repaint the cheap overlay.
- `postTick()` runs on `timeupdate` (playhead, transport, subtitle overlay, autoscroll).
- Timeline is source-time based; the playhead jumps across removed ranges in *Result* mode.

### Preview modes

- **source** — the `<video>` plays the raw file.
- **result** — `program.ranges` is played back by seeking between kept segments; crossing a
  segment boundary advances `program.idx` (and switches `src` if the next segment is another
  clip). `state.resultTime` tracks output time.

### Debug handle

`init()` exposes `window.__cuciApp = { state, api, CU, addVideos, loadSubtitleFromPath,
keptRanges, programRanges, remapAll, applyThumbSetting, buildJob, applyJob,
encodeShareCode, decodeShareCode, addCut, removeCut, renderAll, seekTo, currentSetup }`.
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

### Cut job — verbose (`.cuci2.json`)

```json
{
  "app": "CUCI2", "kind": "cut-job", "version": 1,
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
      "subtitle": { "name":"bbb.srt", "format":"srt", "events": [[1000,4000,"Hello"]] } }
  ]
}
```

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
| `clips` | `c` = `[{ n, z(size), d(durationMs), f(fps), w, h, A(hasAudio 1/0), x:[[s,e]], u:{n,f,v:[[s,e,text]]} }]` |

### Share code

```
CUCI2-1<z|p>.<base64url(bytes)>
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
