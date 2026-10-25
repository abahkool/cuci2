# ✂ CUCI — Cut Out Bad Scenes

A small desktop app (Electron) for **trimming unwanted scenes out of a video with
millisecond precision**, **joining clips together**, and **automatically re-syncing
subtitles** to the new length. Everything is powered by `ffmpeg`.

```
┌───────────────────────────────────────────────────────────────────────┐
│  ✂ CUCI   cut out bad scenes                     [+ Sub] [+ Video] [Export]│
├────────────┬──────────────────────────────────────────────────────────┤
│ Media      │                     video preview                        │
│ Cuts       ├──────────────────────────────────────────────────────────┤
│ Subtitles  │  ◀◀ ‹ ▶ › ▶▶  0:04.250 / 0:32.800  ──●──── [Source|Preview]│
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
  CUCI joins the kept segments into one continuous output (sources with different
  resolutions/fps, or missing audio, are normalised automatically).
- **Subtitle auto-sync, multiple tracks** — the subtitle text list collapses (expanded by
  default) so the sidebar stays short; load one or more `.srt` / `.vtt` files per clip
  and CUCI remaps every track through the cut list:
  - events after a cut shift earlier by exactly the removed duration,
  - events spanning a cut boundary are trimmed/split,
  - events fully inside a cut are dropped,
  - a global manual **offset (ms)** is available for nudging.
  Export the remapped subtitles as `.srt`, and/or **burn them into the video**.
- **Source / Preview** — watch the untouched source while editing, or switch to *Preview* to
  play back the cut timeline seamlessly (skipping removed ranges).
- **Fast timeline tools** — drag to select, `I`/`O` marks, **double-click the ruler or
  filmstrip** to set In then Out, and a **right-click context menu** with all cut actions.
- **Save & share cut jobs** — store your cut list + subtitles + export settings as a
  `.cuci.json` file, or as a compact one-line code you can paste into chat/email/social.
- **Status bar** — live progress (*analyzing*, *loading keyframe snapshots*, *exporting*),
  sticky errors/warnings, active-clip info, and a click-to-open message history.
- **Parent Assist** — scan the active clip with an on-device image classifier and turn flagged
  (non-child-friendly) scenes into cuts in one click. Everything runs locally; no frames are
  uploaded.
- **Preview proxy** — if Chromium can't decode a container/codec (e.g. MKV/HEVC), generate a
  low-res H.264 proxy for previewing; exports still use the original files.
- **Popular output formats** — MP4, MOV, MKV, WebM (VP9/Opus), AVI, WMV, FLV and MPEG-TS,
  with the codecs the container actually supports (x264 / x265 / NVENC, VP9, MPEG-4, WMV2).
  CRF quality, resolution/fps normalisation, `+faststart` for MP4/MOV, live progress with ETA,
  and cancellable exports.
- **Pin, peek, detach** — every pane has a flat pin + detach button. Pinned (default) keeps
  it docked; unpinned hides it, and hovering the player slides in a chevron that opens a
  temporary peek — it closes again as soon as you move away unless you click the pin. The
  side panel and the control center can be **popped out into their own windows** for a second
  monitor and stay in sync both ways. The timeline belongs to the control center: it hides,
  peeks and detaches together with it, timeline included inside the popped-out window.
- **14 UI languages** — English, Bahasa Melayu, Bahasa Indonesia, 简体中文, Español,
  Français, Deutsch, Português, Русский, 日本語, 한국어, العربية (RTL), हिन्दी and Türkçe.
  The language follows your system automatically and can be pinned in Settings.
- **Built-in user guide** — press **F1** (or the **?** button) for a translated walkthrough:
  cutting, preview, subtitles, Parent Assist, export, jobs, the workspace and every keyboard
  shortcut, plus a tips section.
- **Dark / Light / System theme** — the default follows Windows; pick one in Settings.
- Undo/redo and keyboard shortcuts throughout.

---

## Build & package

`build.ps1` is the one-stop Windows build script: toolchain check → patch-version bump from a
source hash → `npm test` → **obfuscate the renderer into `.build/app` and verify it boots** →
electron-builder (NSIS/portable) → Microsoft Store `.msix` / legacy `.appx` → optional signing.

```powershell
.\build.ps1                 # NSIS installer (obfuscated + verified)
.\build.ps1 -Portable       # portable .exe
.\build.ps1 -Store          # Microsoft Store .msix
.\build.ps1 -Appx           # legacy .appx container
.\build.ps1 -Installer -Portable -Store -Appx
.\build.ps1 -Sign           # sign the produced binaries
.\build.ps1 -NoObfuscate    # debug build with readable sources
.\build.ps1 -SkipTests -SkipVerify -SkipVersion   # quick packaging run
```

Renderer JavaScript is obfuscated with `javascript-obfuscator` before every package (also for
`npm run dist` / `npm run store:*`). Every artifact is built from the obfuscated stage, and
`scripts/verify-build.cjs` boots that stage first (i18n, media probe, cuts) so a broken
obfuscation never ships.

`makeappx.exe` is used from the installed Windows SDK when present; otherwise the Microsoft
*Windows SDK BuildTools* package is downloaded once into `vendor/msix-tools/` (pass
`-NoDownload` to forbid that). Store uploads do not need signing — Microsoft re-signs them.

Store submission details live in `docs/STORE-SUBMISSION.md`.

## Requirements

- **Node.js 18+** to run from source (developed on Node 25)
- Windows, macOS or Linux
- **ffmpeg / ffprobe — optional.** CUCI prefers your own install and falls back to a
  bundled copy when you don't have one (see below).

### Where ffmpeg comes from

CUCI uses the first of these that actually runs:

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

`npm install` downloads the bundled ffmpeg (~110 MB). Set `CUCI_SKIP_FFMPEG_FETCH=1` to
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
   The cut tools sit in the toolbar directly under the player — **`[`** set In, **`]`** set Out,
   **`✂`** cut, **eraser** clear marks, **trash** clear cuts (hover for tooltips) — with the
   current In/Out values on the right. The sidebar *Cuts* panel lists only the ranges you've
   removed.
   Drag the thin grip between the player and the toolbar to resize the player/timeline split
   (double-click it to reset).
   Removed ranges show as red striped blocks — drag their edges to fine-tune.
3. **Merge** — use ↑ / ↓ on each clip card to set output order. Each card shows the trimmed
   duration.
4. **Add Subtitles** — select a clip and pick **one or more** `.srt`/`.vtt` files (the dialog
   supports multi-select). Each file becomes a track: tick it to include it in exports, click
   it to show its events in the panel / timeline / preview, or ✕ to remove it. The *Subtitles*
   panel shows each event's original time → new time for the selected track, and the timeline
   lane colour-codes them.
5. **Export** — choose the output file and options. The summary shows the output duration
   and exactly how much was **removed**; if that is 0, Export asks you to confirm, so a
   full-length re-encode can't happen by accident. If you burn subtitles, pick which track to
   burn; a synced `.srt` is written for **every enabled track** (`movie.en.srt`, `movie.id.srt`, …).

---

## Settings

The ⚙ button opens Settings:

- **ffmpeg / ffprobe paths** — leave empty to auto-detect (system, then bundled); use
  **Browse…** to point at a specific install (common for Chocolatey/Scoop shims or portable
  builds), or **Fill bundled paths** to use the shipped build explicitly.
- **Prefer the bundled ffmpeg over a system install** — for reproducible output.
- **Theme** — System (follows Windows, default), Dark or Light.
- **Language** — System (auto-detect) or one of the 14 bundled languages.
- **Settings apply immediately** — there is no Save button; theme, language, thumbnails and
  the ffmpeg paths are written as you change them (a small “Saved” flash confirms it).
- **Load keyframe snapshots into the timeline** — **off by default**. When enabled, CUCI
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
| `Ctrl` + `1` / `2` | Pin (show) or auto-hide the side panel · control center (timeline follows) |
| `Ctrl` + `Shift` + `1` / `2` | Detach / re-dock the side panel · control center |
| Right-click | Cut context menu at the pointer |
| Double-click ruler / filmstrip | Set In, then Out, then start a new range |
| Double-click In/Out marker | Remove that marker |

---

## Cut jobs (save / reopen / share)

The **Job** button opens a two-tab panel:

**Export**

- **Save job file…** writes a readable `<name>.cuci.json` you can reopen later.
- **Copy code** copies the compact share code.
- **Importing asks first** — a job file or share code is decoded with the same hardened
  parser (size caps, bounded inflate, `sanitizeJob`), summarised in a confirmation dialog
  (description, clips, cuts, subtitles, matched/missing videos, format) and only applied when
  you confirm.
- Add an optional **description** and, if you like, embed the subtitle text.

**Import**

- **Open job file…** loads a job file, or a `.txt` that just contains a share code.
- **Import code / Paste from clipboard** applies a share code someone sent you.

> Imported jobs are treated as **untrusted data**: they are size-capped, schema-validated and
> never executed. A crafted code cannot run script, pollute prototypes, or inject extra
> subtitle cues into an exported `.srt`.

A job stores the cut list, subtitle offset, export settings, an optional **description**
(up to 200 characters) written by the creator, and a source fingerprint (file name + byte
size + duration). Subtitle tracks can optionally be embedded so a share is fully
self-contained.

### Share code format

```
CUCI-1z.<base64url( deflate-raw( JSON ) )>
```

- `CUCI-1` — app + format version; `z` = deflate-raw (`p` = plain, automatic fallback).
  Codes that start with the old `CUCI2-1` prefix (the app’s previous name) still import.
- **base64url** (no `+ / =`) survives chat, email and URLs unchanged.
- A compact key schema keeps it small: a single-clip job with two cuts is **~230
  characters** (fits a tweet); a description and embedded subtitles make it larger.

On import, clips are matched by file name, byte size and duration. If a source video isn't
loaded yet, CUCI remembers the job and applies it automatically once you add the missing
file(s).

---

## Parent Assist (NSFW detection)

The **Parent Assist** button extracts frames from the active clip at a configurable interval
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
AAC/Opus). MKV/HEVC/ProRes and similar may not preview. In that case CUCI offers
**Create preview proxy** — it generates a small H.264 version for the player. **Cutting and
exporting always use the original files**, so output quality is never affected.

Export always re-encodes (needed for frame-accurate cuts and joining sources with different
resolutions/fps/audio). Choose a CRF you're happy with.

---

## Troubleshooting

- **`[pid:...:ERROR:ffmpeg_common.cc] Unsupported pixel format: -1` on exit** — harmless.
  That is Chromium's *bundled* media library (not CUCI's `ffmpeg` CLI) tearing down the
  `<video>` decoder as the window closes. It does not affect cutting, matching or exports.
- **`ffmpeg ✗ not found`** — the bundled build is probably missing too. Run
  `npm run fetch:ffmpeg`, or install ffmpeg / set its full path in ⚙ Settings.
- **Export fails with "No such filter: subtitles"** — your ffmpeg build lacks libass; turn
  off *Burn subtitles* (or use a full ffmpeg build).
- **Preview shows a black frame / refuses to play** — the codec isn't decodable by Chromium;
  use *Create preview proxy*.
- **NSFW scan fails to start** — the model needs a one-time ~84 MB download; if you are
  offline, place `model_quantized.onnx` in `vendor/nsfw/` (or set `CUCI_NSFW_MODEL_DIR` to a
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
npm run store:package                                # -> dist/CUCI_<version>_x64.msix
```

Full walkthrough — identity, WACK, test plan, listing copy, age rating — is in
[docs/STORE-SUBMISSION.md](docs/STORE-SUBMISSION.md).

## License

[MIT](LICENSE) © 2025 AbahKool

Big Buck Bunny (if you use the sample) is © Blender Foundation, CC-BY 3.0 — not part of this
repository.
