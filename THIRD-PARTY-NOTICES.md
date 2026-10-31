# Third-party notices — CUCI

CUCI itself is MIT licensed (see [`LICENSE`](LICENSE)). This file covers the third-party
components that are **shipped inside the packaged app** (MSIX, NSIS installer, portable `.exe`) or
**downloaded at runtime at the user's request**.

`npm run dist` / `build.ps1` stage the app from `.build/app`, so this file travels with the sources;
the Store notes for certification (`store/notes-for-certification.txt`) point here for the GPLv3
source offer.

---

## FFmpeg / ffprobe — GPLv3

- **Shipped as:** `resources/ffmpeg/ffmpeg.exe` and `resources/ffmpeg/ffprobe.exe` (unmodified
  binaries, separate executable processes — never linked into CUCI).
- **Version / build:** `ffmpeg version 9.0.2-essentials_build-www.gyan.dev`, built 2026 with
  MSYS2/MinGW-w64 gcc 16.2.0 and configured with `--enable-gpl --enable-version3`
  (enables `libx264`, `libx265`, `libxvid`, `libass`, `libvpx`, `libmp3lame`, …).
- **Source of the binaries:** <https://www.gyan.dev/ffmpeg/builds/> ("essentials" shared/static
  build by Gyan Doshi). `scripts/fetch-ffmpeg.mjs` downloads it into `vendor/ffmpeg`, which is
  gitignored.
- **License:** GNU General Public License, version 3 — full text at
  <https://www.gnu.org/licenses/gpl-3.0.txt>, project licence page at
  <https://ffmpeg.org/legal.html>.
- **Corresponding source (GPLv3 §6 written offer):** the exact sources for these binaries are
  published by the build provider and upstream:
  - build provider sources: <https://www.gyan.dev/ffmpeg/builds/> (source archive link on that page)
  - upstream releases: <https://ffmpeg.org/download.html#releases> (tarball for 9.0.2)
  - upstream git: <https://git.ffmpeg.org/ffmpeg.git> (tag `n9.0.2`)

  These URLs are valid for at least three years from the date of each release. The binaries are
  redistributed unpatched; no CUCI-specific modifications exist.
- **Why GPL does not affect CUCI's own code:** CUCI only spawns `ffmpeg.exe`/`ffprobe.exe` as child
  processes and communicates over arguments, stdout and files — there is no linking, so CUCI stays
  MIT (see `docs/DEVELOPMENT.md` and `docs/STORE-SUBMISSION.md` §4).

> Replacing `vendor/ffmpeg` with an `-lgpl` build removes the GPLv3 obligation but also removes
> `libx264`/`libx265`/`libass`, which breaks the H.264/H.265 presets and subtitle burn-in. The
> `--no-ffmpeg` packaging mode ships no ffmpeg at all (the app then requires a system install).

---

## onnxruntime-node 1.30.0 — MIT

- Copyright (c) Microsoft Corporation. All rights reserved.
- <https://github.com/microsoft/onnxruntime> · licence text: <https://github.com/microsoft/onnxruntime/blob/main/LICENSE>
- Shipped under `resources/app.asar.unpacked/node_modules/onnxruntime-node` (native
  `onnxruntime_binding.node` + `onnxruntime.dll` for the packaged architecture only — the MSIX
  staging step prunes the other OS/arch binaries).

## Electron 33.4.11 — MIT

- Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.
- <https://github.com/electron/electron/blob/main/LICENSE>
- Electron embeds Chromium and Node.js. Their licences and the full list of bundled third-party
  components are shipped inside the package as `LICENSES.chromium.html` (and
  `LICENSE.electron.txt`), next to `CUCI.exe`. Those files are authoritative for the Chromium /
  Node.js / V8 components and are not duplicated here.

## Model downloaded at runtime — not distributed

- **`AdamCodd/vit-base-nsfw-detector`** (ONNX, quantised, ~89 MB), fetched from
  <https://huggingface.co/AdamCodd/vit-base-nsfw-detector> **only** when the user starts a
  "Parent Assist" scan, and stored in the app's user-data folder. It is not part of any
  installer or Store package, so no model licence is redistributed; check the model card for the
  terms that apply to the user's own download.
- Inference uses `onnxruntime-node` (above). No image data leaves the machine.

---

## Development-only dependencies (not shipped)

`electron-builder` (MIT) and `javascript-obfuscator` (BSD-2-Clause) are build-time tools; they are
not part of the packaged app.
