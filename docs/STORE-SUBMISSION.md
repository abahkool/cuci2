# Microsoft Store submission guide

Everything needed to package CUCI² as an **MSIX** and submit it to the Microsoft Store:
tooling, the test plan, and ready-to-paste listing copy.

- [1. What you need](#1-what-you-need)
- [2. Set your app identity](#2-set-your-app-identity)
- [3. Build the MSIX](#3-build-the-msix)
- [4. Package size & ffmpeg licensing](#4-package-size--ffmpeg-licensing)
- [5. Testing guidelines](#5-testing-guidelines)
- [6. Store listing copy](#6-store-listing-copy)
- [7. Visual assets](#7-visual-assets)
- [8. Age rating, privacy & declarations](#8-age-rating-privacy--declarations)
- [9. Submission checklist](#9-submission-checklist)
- [10. Updating the app](#10-updating-the-app)

---

## 1. What you need

| Item | Notes |
| --- | --- |
| Microsoft Partner Center account | Individual (one-off ~$19) or company |
| Reserved product name | Partner Center → *New product* → reserve a unique name |
| **Package/Identity/Name**, **Publisher**, **PublisherDisplayName** | Partner Center → your app → *Product identity* — copy these verbatim |
| Node.js 18+ and the repo | `npm install` |
| MSIX packaging tools | `makeappx.exe` (plus `makepri.exe`) from the Windows SDK, **or** the *MSIX Packaging Tool* app |
| `signtool.exe` | Optional — only for installing your own build locally |

**The MSIX tools are a separate SDK component.** If `makeappx.exe` is missing, install it with either:

```powershell
# Visual Studio Installer → Individual components → "MSIX Packaging Tools"
# or the Windows SDK installer → check "MSIX Packaging Tools"
# or (easiest for one-off builds) the free "MSIX Packaging Tool" from the Store
```

Verify before building:

```powershell
& "C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\makeappx.exe" /?
```

`signtool.exe` may be present in the same folder even when `makeappx.exe` is not — they come from different SDK features.

---

## 2. Set your app identity

```bash
cp store/identity.example.json store/identity.json
```

Fill it in from **Partner Center → Product identity**:

| Key | Partner Center field | Example |
| --- | --- | --- |
| `identityName` | Package/Identity/Name | `12345AbahKool.CUCI2` |
| `publisher` | Package/Identity/Publisher | `CN=1A2B3C4D-...` |
| `publisherDisplayName` | Package/Properties/PublisherDisplayName | `AbahKool` |
| `displayName` | your reserved product name | `CUCI2 Video Cut Studio` |
| `shortName` | tile short name (≤ 40 chars) | `CUCI2` |
| `architecture` | — | `x64` (or `arm64`) |

`store/identity.json` is **gitignored** — it is your account-specific identity, not source.

> `publisher` must match exactly, character for character, including the `CN=` prefix and GUID. A mismatch is the most common certification rejection.

---

## 3. Build the MSIX

```bash
npm install
npm run store:assets      # regenerate placeholder artwork (only when it changes)
npm run store:package     # builds the app and packs dist/CUCI2_<version>_x64.msix
```

Useful variants:

```bash
npm run store:stage                       # lay out dist/msix, no makeappx needed
node scripts/build-msix.mjs --no-ffmpeg   # drop the bundled ffmpeg (see §4)
node scripts/build-msix.mjs --arch arm64  # ARM64 package
node scripts/build-msix.mjs --sign my.pfx --cert-pass hunter2   # local install only
```

### Manual path (no makeappx)

`npm run store:stage` produces a complete tree:

```
dist/msix/
  AppxManifest.xml
  Assets/            StoreLogo, Square44x44, Square150x150, Wide310x150, Square310x310, SplashScreen
  app/               the Electron app (CUCI2.exe, resources/, ...)
```

Point the **MSIX Packaging Tool** at it, or pack it yourself:

```powershell
makeappx pack /d dist\msix /p dist\CUCI2_1.0.0.0_x64.msix /o
```

### Installing your build locally

Store submissions are **signed by Microsoft during certification** — you upload the package and it is re-signed. To sideload your own build for testing you must sign it with a self-signed certificate whose subject **matches `publisher`** exactly:

```powershell
$cert = New-SelfSignedCertificate -Type Custom -Subject "CN=1A2B3C4D-..." `
  -KeyUsage DigitalSignature -FriendlyName "CUCI2 test" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")

Export-PfxCertificate -Cert $cert -FilePath cuci2-test.pfx -Password (Read-Host -AsSecureString)

# trust it once, then install
Import-Certificate -FilePath cuci2-test.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
Add-AppxPackage .\dist\CUCI2_1.0.0.0_x64.msix
```

---

## 4. Package size & ffmpeg licensing

Two things to decide before you submit.

**Size.** Measured on a v1.0.0 x64 staging build:

| Payload | Staged | Packed `.msix` (zip) |
| --- | --- | --- |
| Electron runtime + app | ~225 MB | ~95 MB |
| `onnxruntime-node` (win32-x64 only) | 65 MB | ~30 MB |
| Bundled ffmpeg + ffprobe | 201 MB | ~75 MB |
| **Total — bundled ffmpeg** | **495 MB** | **~200–230 MB** |
| **Total — `--no-ffmpeg`** | **294 MB** | **~120 MB** |

The build already trims what the Store package doesn't need:

- only the **target architecture's** `onnxruntime-node` binaries are kept — the npm package ships every
  OS/arch by default (**288 MB → 65 MB**);
- Electron is limited to `en-US` locales via `build.electronLanguages` (**41 MB → 0.5 MB**).

The NSFW model (~84 MB) is **not** in the package — it downloads on first scan into user data, so it
survives app updates and is fetched only once.

**Licensing — read this.** The bundled ffmpeg from gyan.dev "essentials" is a **GPLv3** build (it enables `libx264`, `libx265`, etc.). Distributing it means you must comply with the GPL for that binary: ship the licence text and offer the corresponding source. Your own app can stay MIT (it invokes ffmpeg as a separate process), but you cannot simply ignore the ffmpeg licence.

Three options:

| Option | Command | Trade-off |
| --- | --- | --- |
| **Don't bundle** (recommended for the Store) | `npm run store:stage` → then `node scripts/build-msix.mjs --no-ffmpeg` | Smallest package, no GPL obligation. Users need ffmpeg on `PATH`, and **subtitle burn-in needs a libass build**. The app already surfaces a clear status-bar error when ffmpeg is missing. |
| Bundle + comply | default build | Must publish the ffmpeg source offer / licence text. See *Third-party notices* below. |
| Bundle an LGPL build | replace `vendor/ffmpeg` with an `-lgpl` BtbN build | No `libx264`/`libx265` — encoding falls back to a different codec, so the app's H.264/H.265 presets would break. |

If you bundle, add a `THIRD-PARTY-NOTICES.md` covering ffmpeg (GPLv3), `onnxruntime-node` (MIT), Electron (MIT) and the model licences (`AdamCodd/vit-base-nsfw-detector` — check the model card), and link it from the Store description.

---

## 5. Testing guidelines

### 5.1 Automated suite

```bash
npm test
```

| Suite | Covers |
| --- | --- |
| `test:locate` | ffmpeg/ffprobe resolution: custom → env → system → bundled |
| `test:nsfw` | tensor/softmax/grouping units + a live scan when the model is present |
| `test:export` | joins mixed-resolution + silent clips with the production filtergraph |
| `test:smoke` | boots the real renderer, fails on any console error |
| `test:e2e` | full UI flow: load → subtitle → cut → seek → context menu → job → export → cancel |
| `test:cancel` | cancelling kills ffmpeg and leaves no residue |

### 5.2 Windows App Certification Kit (WACK)

Required before submitting. Install the **Windows App Certification Kit** (part of the Windows SDK / "Windows App Cert Kit" download), then:

1. Build and (locally) sign the MSIX as in §3.
2. Launch **Windows App Cert Kit** → *Validate a Store App*.
3. Select `dist/CUCI2_<version>_x64.msix`.
4. Run all tests and export the report.

A clean run is the baseline expectation. The suite checks manifest validity, package integrity, crash/hang behaviour, and Store policy compliance.

### 5.3 Manual test plan

Run on a clean Windows 10/11 x64 machine (no dev tools installed).

**Install / identity**

- [ ] `Add-AppxPackage` succeeds with the signed MSIX
- [ ] App appears in Start with the correct **name and tile artwork**
- [ ] Launches from Start, taskbar pin, and the app list — no UAC / elevation prompt
- [ ] Uninstall removes all files (user data under `%APPDATA%\CUCI2` may remain — that is expected and allowed)
- [ ] No crash when launched twice quickly

**No ffmpeg installed** (the important one for bulk users)

- [ ] App launches; status bar shows `ffmpeg ✓ <version> · bundled`
- [ ] Settings shows the resolved path, source and `libass ✓`
- [ ] A full cut + export works end to end
- [ ] **With `--no-ffmpeg`**: status bar shows a clear "ffmpeg not found" error and Settings offers the Browse / config path — no crash

**Core editing**

- [ ] Add a long video (≥ 10 min) → duration/fps shown correctly
- [ ] Drag-select → Cut; In/Out → Cut; double-click ruler sets In then Out; right-click menu
- [ ] Cut edges drag; `Ctrl`+`Z` undoes
- [ ] Merge order ↑/↓ changes the exported result
- [ ] Load `.srt` → events remap across cuts; export burns subtitles; `.srt` written next to the output
- [ ] Export guard: with no cuts, Start asks for confirmation
- [ ] Export **Cancel** stops ffmpeg (check Task Manager — no orphan `ffmpeg.exe`)

**Content scan**

- [ ] `Scan NSFW` on a short clip: model downloads once, progress shows, results listed
- [ ] "Apply as cuts" adds undoable cuts
- [ ] Cancel mid-scan stops promptly
- [ ] Offline: scan fails with a clear message rather than hanging

**Shell integration & polish**

- [ ] High DPI (150 %/200 %) — UI not clipped, timeline still usable
- [ ] Multiple monitors / moving between them
- [ ] Window resize to minimum (1040×680) — no layout overflow
- [ ] Long file paths, filenames with spaces / unicode / `#` / `?`
- [ ] Very long video (1 h+) — no freeze
- [ ] App is responsive during a long export (progress updates, cancel works)

### 5.4 Electron/MSIX-specific checks

- [ ] `runFullTrust` is declared (Electron cannot run sandboxed) — already in the manifest
- [ ] `process.windowsStore` is `true` inside a packaged build (so the AUMID is left to the package identity)
- [ ] No writes outside `%APPDATA%\CUCI2`, temp, and user-chosen paths
- [ ] The app does not phone home; the only network calls are model downloads from `huggingface.co` (user-triggered)
- [ ] Proxy previews and thumbnails are written to `%TEMP%` and cleaned up

---

## 6. Store listing copy

Paste-ready. Verify character limits in Partner Center (typical: description 10,000 · features 20 × 200 · search terms 7 × 30).

### Display name

> **CUCI2 Video Cut Studio**

Tiles use the short name **CUCI2**.

### Short description (~100 chars)

> Trim, merge and subtitle-sync video with millisecond precision — entirely on your device.

### Description

```
CUCI2 is a focused desktop editor for one job: cutting out the parts you don't want and
joining what's left — with subtitles that stay in sync.

MILLISECOND PRECISION
Every edit point is stored and exported to the millisecond, with optional frame snapping
based on the real source frame rate. What you set is what you get.

CUT, MERGE, REPEAT
Remove as many ranges as you like from each clip, reorder clips, and CUCI2 joins the kept
segments into one continuous file. Clips with different resolutions, frame rates or missing
audio are normalised automatically.

SUBTITLES THAT FOLLOW YOUR CUTS
Load an .srt or .vtt and CUCI2 rewrites the timings to match your edit: captions after a cut
move earlier by exactly the removed time, captions spanning a cut are trimmed, and captions
inside a removed scene are dropped. Export the corrected subtitle file, or burn the captions
straight into the video.

FAST TIMELINE TOOLS
Set in and out points with a keystroke, double-click the ruler, or right-click the timeline
for a full cut menu. Drag cut edges to fine-tune, preview the untouched source or the final
result, and undo anything with Ctrl+Z.

FIND SCENES AUTOMATICALLY
Scan a clip with a built-in on-device classifier to flag NSFW content and mark those scenes
as cuts in one pass. No frames ever leave your computer.

SHARE AN EDIT, NOT A FILE
Save your cut list as a small job file, or copy a compact one-line code that pastes into
chat, email or a message. Anyone with the same source video can load it and get your exact
edit — including an optional note explaining what you cut and why.

BUILT FOR REAL FILES
Preview codecs your player can't handle by generating a lightweight proxy. Exports offer
H.264/H.265, CPU or GPU encoding, quality and resolution presets, with live progress and a
working Cancel.

Your media stays yours. Everything runs locally; nothing is uploaded.

Requires ffmpeg for encoding — either install it yourself or use the copy bundled with the app.
```

### Product features (each ≤ 200 chars)

```
Millisecond-precision cutting with optional frame snapping
Merge multiple clips; different resolutions and frame rates are normalised automatically
Subtitle auto-sync: .srt/.vtt timings are rewritten to match your cuts, or burned in
Double-click the timeline to set in/out points; right-click for a full cut menu
Auto-detect NSFW scenes with an on-device classifier and mark them as cuts
Save and share edits as a small job file or a compact one-line code
Source and Result preview modes with seamless playback across cuts
Generate a preview proxy for codecs your player can't decode
H.264/H.265 export with CPU or GPU encoding, quality presets and live progress
Cancel an export at any time — it stops cleanly and leaves no leftovers
Undo/redo, keyboard shortcuts and a persistent status bar with full message history
Runs entirely on your device; no media is uploaded
```

### Search terms (keywords — up to 7)

```
video cutter
trim video
merge video
subtitle sync
srt editor
cut video
video editor
```

Alternates if any are taken: `split video`, `video trimming`, `subtitle editor`, `scene cut`, `mp4 cutter`.

### Category

- **Category:** Photo & video
- **Subcategory:** Video editing (or *Utilities* if unavailable)

### Additional system requirements

```
Windows 10 version 1809 (build 17763) or later, 64-bit.
~400 MB disk space (or ~150 MB if ffmpeg is not bundled).
An internet connection is needed once to download the optional NSFW detection model (~84 MB).
Hardware H.264/H.265 encoding (NVENC) is optional and used when available.
```

### Support / contact

| Field | Value |
| --- | --- |
| Support contact info | your support email or GitHub Issues URL |
| Website | `https://github.com/abahkool/cuci2` |
| Privacy policy URL | required — see §8 |
| Copyright / trademark | `© 2025 AbahKool` |
| License | MIT (plus third-party notices if ffmpeg is bundled) |

### "What's new in this version" (≤ 1,500 chars)

```
First Microsoft Store release.

• Millisecond-precision cutting and merging with frame snapping
• Subtitle auto-sync — .srt/.vtt timings rewritten to match your edit, or burned in
• Double-click the timeline for in/out points, plus a right-click cut menu
• On-device NSFW scene detection
• Save and share cut jobs as a file or a one-line code
• Preview proxy for exotic codecs; cancellable exports with progress
```

---

## 7. Visual assets

### Store listing (Partner Center)

| Asset | Size | Notes |
| --- | --- | --- |
| Store listing logo | 300×300 PNG | required — `store/listing/StoreListingLogo300x300.png` |
| Screenshots | ≥ 1366×768, up to 10 | required (at least 1) |
| Hero / promotional art | 1920×1080 (optional) | shown on the Store page if provided |

Suggested screenshots (capture at 1920×1080):

1. Main window with a loaded video, several cuts on the timeline and the status bar visible.
2. The Subtitles panel showing *original → new* timings beside a cut.
3. The export dialog showing "removed 9:34.000" and the progress bar.
4. The NSFW scan modal with detected scenes listed.
5. A Job panel showing the share code and description field.

### MSIX package artwork (in `store/Assets/`)

| File | Size |
| --- | --- |
| `StoreLogo.png` | 50×50 |
| `Square44x44Logo.png` | 44×44 |
| `Square150x150Logo.png` | 150×150 |
| `Square310x310Logo.png` | 310×310 |
| `Wide310x150Logo.png` | 310×150 |
| `SplashScreen.png` | 620×300 |
| `LockScreenLogo.png` | 24×24 |

All of these are **placeholders** generated by `npm run store:assets` (dark background, accent wordmark). Replace them with real branding and re-run the build. Also replace `build/icon.ico` (the executable icon).

---

## 8. Age rating, privacy & declarations

### IARC age rating

You must complete the **IARC questionnaire** in Partner Center. Answer honestly — CUCI² is a *content-management utility*, not a media player with preloaded content:

- It ships **no** media or sample content.
- The NSFW feature only **analyses the user's own files on-device** and never displays, stores or transmits imagery.
- No user-generated content is hosted or shared by the app.

Two things to flag in the questionnaire so the rating is sane:

- the app can **open and display video files the user provides** (so "user-generated content shown" applies);
- it includes a feature that **detects adult content**.

Disclose this in the Store description too (the copy in §6 already does). Expect a **PEGI 12 / ESRB T**-style rating and, if you rate it higher than you'd like, explain the moderation use case in the certification notes.

### Declarations / notes for certification

Paste into **Partner Center → Submission → Notes for certification**:

```
CUCI2 is an offline video cutting utility. It ships no media content.

- The NSFW detection feature runs an ONNX image classifier entirely on-device
  (onnxruntime-node). No frames, files or telemetry leave the machine.
- The only network access is a one-time, user-triggered download of the classifier
  model (~84 MB) from huggingface.co. If that fails the app continues to work and
  the feature is simply unavailable.
- ffmpeg is used as a separate command-line process for encoding. [If bundled:
  "A GPLv3 ffmpeg build is bundled; see THIRD-PARTY-NOTICES.md."]
- No account, sign-in or purchase is required.

Test account: none required.
Test steps: launch → Add Video → drag on the timeline → Cut → Export.
```

### Privacy policy (required URL)

The app collects nothing; you still need a published URL. Minimal text (host it as a GitHub Pages page or a `PRIVACY.md` on the repo):

```
CUCI2 privacy policy

CUCI2 processes video and subtitle files entirely on your device. We do not collect,
store, transmit or sell any personal data, usage analytics, telemetry or media.

Network access happens only when you explicitly ask the app to download the optional
on-device content-detection model, which is fetched from huggingface.co. That request
contains no information about you or your media.

Files you open, edit or export remain on your computer. The app stores only your own
preferences (window-independent settings such as ffmpeg paths) under %APPDATA%\CUCI2.

Contact: <your email>
```

---

## 9. Submission checklist

**Identity**
- [ ] Product name reserved; `store/identity.json` filled from Product identity
- [ ] `publisher` matches Partner Center exactly (including `CN=` and GUID)
- [ ] Package version is 4 parts and higher than the last submission (`package.json` version + `.0`)

**Package**
- [ ] `npm test` passes
- [ ] `npm run store:package` produced `CUCI2_<version>_x64.msix`
- [ ] **WACK** run and the report is clean
- [ ] Decided on bundled ffmpeg (§4) and — if bundled — added third-party notices
- [ ] Exe icon is the real one (`build/icon.ico`)
- [ ] Real artwork replaces every placeholder in `store/Assets/` and `store/listing/`

**Listing**
- [ ] Description, short description, features and search terms entered
- [ ] Category **Photo & video**, subcategory **Video editing**
- [ ] ≥ 1 screenshot at 1366×768+, no personal/unlicensed content visible
- [ ] 300×300 listing logo uploaded
- [ ] Support email/URL and website set
- [ ] Privacy policy URL published and reachable
- [ ] Copyright line set

**Compliance**
- [ ] IARC questionnaire completed; adult-content detection disclosed
- [ ] "Notes for certification" pasted and accurate
- [ ] Age rating review requested if the auto-rating looks wrong
- [ ] No third-party trademarks or unlicensed media in screenshots

---

## 10. Updating the app

1. Bump `version` in `package.json` (e.g. `1.0.1`) — the MSIX becomes `1.0.1.0`.
2. `npm test && npm run store:package`
3. Partner Center → your app → **Update** → upload the new `.msix`.
4. Write the "What's new" notes (§6) and submit.

Store updates are incremental: users get the new MSIX automatically. The NSFW model is **not** part of the package — it lives in user data, so it survives updates and is only downloaded once.
