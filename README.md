# ✂ CUCI² — Video Cut & Merge Studio

A small desktop app (Electron) for **trimming unwanted scenes out of a video with
millisecond precision**, **joining clips together**, and **automatically re-syncing
subtitles** to the new length. Everything is powered by `ffmpeg`.

```
┌───────────────────────────────────────────────────────────────────────┐
│  ✂ CUCI²  cut & merge studio        ffmpeg ✓   [Job] [+ Sub] [+ Video]  │
├────────────┬──────────────────────────────────────────────────────────┤
│ Media      │                     video preview                        │
│ Cuts       ├──────────────────────────────────────────────────────────┤
│ Subtitles  │  ◀◀ ‹ ▶ › ▶▶  0:04.250 / 0:32.800  ──●──── [Source|Result]│
│            ├──────────────────────────────────────────────────────────┤
│            │  ┃────┃████████┃──────┃████┃────────────────  filmstrip  │
│            │  ░░░░░ subtitle track ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
├────────────┴──────────────────────────────────────────────────────────┤
│ ● Loaded 170 keyframe snapshots          1/1 · bbb.mp4 · 1920×1080 …  │
└───────────────────────────────────────────────────────────────────────┘
```

> **Packaging for the Microsoft Store?** See **[docs/STORE-SUBMISSION.md](docs/STORE-SUBMISSION.md)**
> — MSIX packaging, the WACK/manual test plan, and ready-to-paste listing copy.
>
> **Development / contributing?** See **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** for the
> architecture, IPC reference, data formats and test guide.

---

## Features

- **Millisecond precision** — edit points are stored and exported to the millisecond
  (`trim=start=1.234:end=5.678`). Optional **frame snapping** using the real source fps.
- **Cut & merge** — remove as many ranges as you like from each clip, reorder clips, and
  CUCI² joins the kept segments into one continuous output (sources with different
  resolutions/fps, or missing audio, are normalised automatically).
- **Subtitle auto-sync** — load an `.srt` / `.vtt` next to a clip and CUCI² remaps every
  event through the cut list:
  - events after a cut shift earlier by exactly the removed duration,
  - events spanning a cut boundary are trimmed/split,
  - events fully inside a cut are dropped,
  - a global manual **offset (ms)** is available for nudging.
  Export the remapped subtitles as `.srt`, and/or **burn them into the video**.
- **Source / Result preview** — watch the untouched source while editing, or switch to
  *Result* to play back the cut timeline seamlessly (skipping removed ranges).
- **Fast timeline tools** — drag to select, `I`/`O` marks, **double-click the ruler or
  filmstrip** to set In then Out, and a **right-click context menu** with all cut actions.
- **Save & share cut jobs** — store your cut list + subtitles + export settings as a
  `.cuci2.json` file, or as a compact one-line code you can paste into chat/email/social.
- **Status bar** — live progress (*analyzing*, *loading keyframe snapshots*, *exporting*),
  sticky errors/warnings, active-clip info, and a click-to-open message history.
- **Auto-detect NSFW scenes** — scan the active clip with an on-device image classifier and
  turn flagged scenes into cuts in one click. Everything runs locally; no frames are
  uploaded.
- **Preview proxy** — if Chromium can't decode a container/codec (e.g. MKV/HEVC), generate a
  low-res H.264 proxy for previewing; exports still use the original files.
- **Sensible encode presets** — x264 / x265 / NVENC, CRF quality, resolution/fps
  normalisation, AAC audio, `+faststart`, live progress with ETA, and cancellable exports.
- Undo/redo and keyboard shortcuts throughout.

---

## Requirements

- **Node.js 18+** to run from source (developed on Node 25)
- Windows, macOS or Linux
- **ffmpeg / ffprobe — optional.** CUCI² prefers your own install and falls back to a
  bundled copy when you don't have one (see below).

### Where ffmpeg comes from

CUCI² uses the first of these that actually runs:

1. an explicit path you set in ⚙ Settings,
2. the `FFMPEG_PATH` / `FFPROBE_PATH` environment variables,
3. a **system** install found on your `PATH`,
4. the **bundled** copy — only used when none of the above exist.

The bundled build is fetched into `vendor/ffmpeg/` on `npm install` (or manually with
`npm run fetch:ffmpeg`) and is copied into the packaged app. The ⚙ Settings panel shows
which binary is in use and where it came from (`custom` / `env var` / `system` /
`bundled`). A **Prefer bundled** toggle swaps the priority of 3 and 4 if you want
reproducible rendering. The bundled build includes `libass`, so subtitle burn-in works
without a system ffmpeg.

---

## Install & run

```bash
git clone https://github.com/abahkool/cuci2.git
cd cuci2
npm install     # also fetches the bundled ffmpeg into vendor/ffmpeg (skippable)
npm start
```

`npm install` downloads the bundled ffmpeg (~110 MB). Set `CUCI2_SKIP_FFMPEG_FETCH=1` to
skip it, or set full ffmpeg paths in ⚙ Settings to use your own.

`npm run dev` starts the app with DevTools open and renderer console logs forwarded to the
terminal — handy when developing.

---

## Quick start

1. **Add Video** — pick one or more files. They appear under *Media* in join order.
2. **Make a cut** — any of:
   - **double-click** the ruler or filmstrip to drop an **In** point, double-click again
     for the **Out** point (a third double-click starts a new range), then press **Cut**, or
   - drag across the filmstrip to select a range and press **Cut**, or
   - position the playhead and press `I` / `O`, then **Cut**, or
   - **right-click the timeline** for a context menu: *Set In here*, *Set Out here*,
     *Cut In → Out*, *Cut from In to here*, *Cut from here to Out*, *Remove this cut*,
     *Clear marks*, *Clear cuts*.
   Removed ranges show as red striped blocks — drag their edges to fine-tune.
3. **Merge** — use ↑ / ↓ on each clip card to set output order. Each card shows the trimmed
   duration.
4. **Add Subtitle** — select a clip and load its `.srt`/`.vtt`. The *Subtitles* panel shows
   each event's original time → new time, and the timeline lane colour-codes them.
5. **Export** — choose the output file and options. The summary shows the output duration
   and exactly how much was **removed**; if that is 0, Export asks you to confirm, so a
   full-length re-encode can't happen by accident.

---

## Settings

The ⚙ button opens Settings:

- **ffmpeg / ffprobe paths** — leave empty to auto-detect (system, then bundled); use
  **Browse…** to point at a specific install (common for Chocolatey/Scoop shims or portable
  builds), or **Fill bundled paths** to use the shipped build explicitly.
- **Prefer the bundled ffmpeg over a system install** — for reproducible output.
- **Load keyframe snapshots into the timeline** — **off by default**. When enabled, CUCI²
  samples frames with ffmpeg to draw the filmstrip. On long videos this decodes the whole
  file, so it can take a while; the status bar shows progress. When off, the timeline shows
  a placeholder instead.

Settings are stored in your Electron user-data folder (`settings.json`).

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Step one frame |
| `Shift` + `←` / `→` | Step one second |
| `I` / `O` | Set in / out point |
| `X` | Cut the current selection |
| `Home` / `End` | Jump to clip start / end |
| `+` / `-` | Zoom the timeline |
| `Ctrl` + `Z` | Undo |
| `Ctrl` + `Shift` + `Z` / `Ctrl` + `Y` | Redo |
| Right-click | Cut context menu at the pointer |
| Double-click ruler / filmstrip | Set In, then Out, then start a new range |
| Double-click In/Out marker | Remove that marker |

---

## Cut jobs (save / reopen / share)

The **Job** button opens the cut-job panel:

- **Save job file…** writes a readable `<name>.cuci2.json` you can reopen later.
- **Open job file…** loads a job file, or a `.txt` that just contains a share code.
- **Copy code / Import code** move the job as one compact text line.

A job stores the cut list, subtitle offset, export settings, an optional **description**
(up to 200 characters) written by the creator, and a source fingerprint (file name + byte
size + duration). Subtitles can optionally be embedded so a share is fully self-contained.

### Share code format

```
CUCI2-1z.<base64url( deflate-raw( JSON ) )>
```

- `CUCI2-1` — app + format version; `z` = deflate-raw (`p` = plain, automatic fallback).
- **base64url** (no `+ / =`) survives chat, email and URLs unchanged.
- A compact key schema keeps it small: a single-clip job with two cuts is **~230
  characters** (fits a tweet); a description and embedded subtitles make it larger.

On import, clips are matched by file name, byte size and duration. If a source video isn't
loaded yet, CUCI² remembers the job and applies it automatically once you add the missing
file(s).

---

## Auto-detect NSFW scenes

The **Scan NSFW** button extracts frames from the active clip at a configurable interval
(default: one every 2 seconds), classifies each one, and turns consecutive flagged samples
into cut ranges you review before applying.

A shorter interval catches shorter scenes at a proportional time cost — the modal shows the
frame count and an estimate before you start.

- **Model** — `AdamCodd/vit-base-nsfw-detector`, a ViT-base binary `sfw`/`nsfw` classifier.
  This is the closest ONNX equivalent of `Falconsai/nsfw_image_detection`; the Falconsai repo
  only publishes PyTorch/safetensors weights, which a JS/Electron app can't execute, so a
  model with the same architecture and task is used instead.
- **Local only** — inference runs through `onnxruntime-node`; no frames leave your machine.
  The ~84 MB model is downloaded once from Hugging Face and cached in your user-data folder.
  If `vendor/nsfw/` already contains it (as in a dev checkout), that copy is used and nothing
  is downloaded.
- **Controls** — *Sensitivity* (default `0.30`, the most aggressive; raise it to reduce false
  positives), *Sample every* (`0.25`–`60` seconds, default 2) and *Minimum cut length*
  (default 5 s). The modal shows how many frames that means and a rough processing estimate.
  Expect roughly 5 frames/second of analysis on a typical CPU.
- **Fresh frames, not the filmstrip** — the scanner extracts new frames at the chosen interval
  (`fps=1/<interval>` in ffmpeg). It does **not** reuse the timeline keyframe snapshots, which
  are far too small (64 px tall) and too sparse to classify reliably.
- **Review first** — detected ranges are listed with their peak score; **Apply as cuts** adds
  them (undo with `Ctrl`+`Z`). Nothing is marked automatically until you confirm.

> Detection quality depends entirely on the model. Treat the result as a first pass and
> review the timeline before exporting.

## Preview codecs & proxies

The built-in player only decodes what Chromium supports (typically H.264/VP8/VP9/AV1 with
AAC/Opus). MKV/HEVC/ProRes and similar may not preview. In that case CUCI² offers
**Create preview proxy** — it generates a small H.264 version for the player. **Cutting and
exporting always use the original files**, so output quality is never affected.

Export always re-encodes (needed for frame-accurate cuts and joining sources with different
resolutions/fps/audio). Choose a CRF you're happy with.

---

## Troubleshooting

- **`[pid:...:ERROR:ffmpeg_common.cc] Unsupported pixel format: -1` on exit** — harmless.
  That is Chromium's *bundled* media library (not CUCI²'s `ffmpeg` CLI) tearing down the
  `<video>` decoder as the window closes. It does not affect cutting, matching or exports.
- **`ffmpeg ✗ not found`** — the bundled build is probably missing too. Run
  `npm run fetch:ffmpeg`, or install ffmpeg / set its full path in ⚙ Settings.
- **Export fails with "No such filter: subtitles"** — your ffmpeg build lacks libass; turn
  off *Burn subtitles* (or use a full ffmpeg build).
- **Preview shows a black frame / refuses to play** — the codec isn't decodable by Chromium;
  use *Create preview proxy*.
- **NSFW scan fails to start** — the model needs a one-time ~84 MB download; if you are
  offline, place `model_quantized.onnx` in `vendor/nsfw/` (or set `CUCI2_NSFW_MODEL_DIR` to a
  folder containing it) and it will be used directly.
- **Nothing was cut out of the export** — open Export and check the `removed` line; if it is
  `0:00.000` the cut list is empty and Export will ask you to confirm.

---

## Packaging

Desktop installers (Windows NSIS + portable, macOS dmg, Linux AppImage):

```bash
npm run dist
```

Microsoft Store (MSIX):

```bash
cp store/identity.example.json store/identity.json   # fill in from Partner Center
npm run store:assets                                 # placeholder artwork (replace with branding)
npm run store:package                                # -> dist/CUCI2_<version>_x64.msix
```

Full walkthrough — identity, WACK, test plan, listing copy, age rating — is in
[docs/STORE-SUBMISSION.md](docs/STORE-SUBMISSION.md).

## License

[MIT](LICENSE) © 2025 AbahKool

Big Buck Bunny (if you use the sample) is © Blender Foundation, CC-BY 3.0 — not part of this
repository.
