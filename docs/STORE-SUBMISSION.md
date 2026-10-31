# Microsoft Store submission guide

Everything needed to package CUCI as an **MSIX** and submit it to the Microsoft Store:
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
- [11. Submission errors](#11-submission-errors)

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
| `identityName` | Package/Identity/Name | `12345AbahKool.CUCI` (must match your Partner Center reservation) |
| `publisher` | Package/Identity/Publisher | `CN=1A2B3C4D-...` |
| `publisherDisplayName` | Package/Properties/PublisherDisplayName | `AbahKool` |
| `displayName` | your reserved product name | `CUCI Video Delete Studio` |
| `shortName` | tile short name (≤ 40 chars) | `CUCI` |
| `architecture` | — | `x64` (or `arm64`) |

`store/identity.json` is **gitignored** — it is your account-specific identity, not source.

> `publisher` must match exactly, character for character, including the `CN=` prefix and GUID. A mismatch is the most common certification rejection.
>
> `publisher` is the GUID of the **account** (Package/Identity/Publisher), `publisherDisplayName`
> is the **account's** Publisher display name (Partner Center → *Account settings* → Publishers),
> and `identityName` is the reserved product's Package/Identity/Name. Many sellers rename the
> publisher display name later, while the identity name keeps the original prefix
> (`12345AbahKool.CUCI`) — **copy all three, never guess**.
>
> `scripts/build-msix.mjs` validates this file and **refuses to pack** (exit 5) when
> `identityName`/`publisher` are empty, the publisher GUID is the all-zero placeholder, or the
> display names are blank, because Partner Center rejects such a package after a 200+ MB upload.
> For a throwaway test package use `--allow-example-identity` (or `build.ps1 -AllowExampleIdentity`).

---

## 3. Build the MSIX

The easiest path is the PowerShell build script (checks Node, bumps the version when
sources changed, runs the test suite, builds and optionally signs):

```powershell
.\build.ps1 -Store            # obfuscate + build + pack dist/CUCI_<version>_x64.msix
.\build.ps1 -Appx             # same, but the legacy .appx container
.\build.ps1 -Installer        # NSIS installer for a direct download link
.\build.ps1 -Store -Appx -Sign  # both containers, signed for local testing
.\build.ps1 -Store -NoDownload  # offline: use an installed SDK only
```

`makeappx.exe` is taken from the Windows SDK when installed. If it is not, the script downloads
the Microsoft **Windows SDK BuildTools** NuGet package once and extracts it into
`vendor/msix-tools/` (same signed tool, nothing hand-rolled). `build-msix.mjs` then
round-trips the package (`makeappx unpack`) before reporting success, so a broken archive is
caught immediately. Both `.msix` and `.appx` are accepted by Partner Center; `.msix` is
preferred for new submissions.

Or drive the tools directly:

```bash
npm install
npm run store:assets      # rebuild store artwork + build/icon.ico from icons/logo.png
npm run store:package     # builds the app and packs dist/CUCI_<version>_x64.msix
```

Useful variants:

```bash
npm run store:stage                       # obfuscate + lay out dist/msix, no makeappx needed
npm run store:appx                        # obfuscate + pack .appx
node scripts/build-msix.mjs --no-ffmpeg   # drop the bundled ffmpeg (see §4)
node scripts/build-msix.mjs --arch arm64  # ARM64 package
node scripts/build-msix.mjs --sign my.pfx --cert-pass hunter2   # local install only
node scripts/build-msix.mjs --no-download # forbid fetching the SDK tools
```

### Manual path (no makeappx)

`npm run store:stage` produces a complete tree:

```
dist/msix/
  AppxManifest.xml
  Assets/            StoreLogo, Square44x44, Square150x150, Wide310x150, Square310x310, SplashScreen
  app/               the Electron app (CUCI.exe, resources/, ...)
```

Point the **MSIX Packaging Tool** at it, or pack it yourself:

```powershell
makeappx pack /d dist\msix /p dist\CUCI_1.0.0.0_x64.msix /o
```

### Installing your build locally

Store submissions are **signed by Microsoft during certification** — you upload the package and it is re-signed. To sideload your own build for testing you must sign it with a self-signed certificate whose subject **matches `publisher`** exactly:

```powershell
$cert = New-SelfSignedCertificate -Type Custom -Subject "CN=1A2B3C4D-..." `
  -KeyUsage DigitalSignature -FriendlyName "CUCI test" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")

Export-PfxCertificate -Cert $cert -FilePath cuci-test.pfx -Password (Read-Host -AsSecureString)

# trust it once, then install
Import-Certificate -FilePath cuci-test.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
Add-AppxPackage .\dist\CUCI_1.0.0.0_x64.msix
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

If you bundle, the `THIRD-PARTY-NOTICES.md` at the repo root covers ffmpeg (GPLv3 + source offer),
`onnxruntime-node` (MIT), Electron/Chromium (MIT + `LICENSES.chromium.html`) and the runtime-downloaded
model (`AdamCodd/vit-base-nsfw-detector`). It ships inside the package (`build.extraResources` →
`resources/THIRD-PARTY-NOTICES.md`) and is linked from the Store description.

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
| `test:e2e` | full UI flow: load → subtitle → delete → seek → context menu → job → export → cancel |
| `test:cancel` | cancelling kills ffmpeg and leaves no residue |

### 5.2 Windows App Certification Kit (WACK)

Required before submitting. Install the **Windows App Certification Kit** (part of the Windows SDK / "Windows App Cert Kit" download), then:

1. Build and (locally) sign the MSIX as in §3.
2. Launch **Windows App Cert Kit** → *Validate a Store App*.
3. Select `dist/CUCI_<version>_x64.msix`.
4. Run all tests and export the report.

A clean run is the baseline expectation. The suite checks manifest validity, package integrity, crash/hang behaviour, and Store policy compliance.

### 5.3 Manual test plan

Run on a clean Windows 10/11 x64 machine (no dev tools installed).

**Install / identity**

- [ ] `Add-AppxPackage` succeeds with the signed MSIX
- [ ] App appears in Start with the correct **name and tile artwork**
- [ ] Launches from Start, taskbar pin, and the app list — no UAC / elevation prompt
- [ ] Uninstall removes all files (user data under `%APPDATA%\CUCI` may remain — that is expected and allowed)
- [ ] No crash when launched twice quickly

**No ffmpeg installed** (the important one for bulk users)

- [ ] App launches; the Actions panel shows **no** ffmpeg chip (it only appears on problems); Settings shows `ffmpeg ✓ <version> · bundled`
- [ ] Settings shows the resolved path, source and `libass ✓`
- [ ] A full delete + export works end to end
- [ ] **With `--no-ffmpeg`**: status bar shows a clear "ffmpeg not found" error and Settings offers the Browse / config path — no crash

**Core editing**

- [ ] Add a long video (≥ 10 min) → duration/fps shown correctly
- [ ] Drag-select → Delete; In/Out → Delete; double-click ruler sets In then Out; right-click menu
- [ ] Delete edges drag; `Ctrl`+`Z` undoes
- [ ] Merge order ↑/↓ changes the exported result
- [ ] Load `.srt` → events remap across deletes; export burns subtitles; `.srt` written next to the output
- [ ] Export guard: with no deletes, Start asks for confirmation
- [ ] Export **Cancel** stops ffmpeg (check Task Manager — no orphan `ffmpeg.exe`)

**Content scan**

- [ ] `Parental AI` on a short clip: model downloads once, progress shows, results listed
- [ ] "Apply as deletes" adds undoable deletes
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
- [ ] No writes outside `%APPDATA%\CUCI`, temp, and user-chosen paths
- [ ] The app does not phone home; the only network calls are model downloads from `huggingface.co` (user-triggered)
- [ ] Proxy previews and thumbnails are written to `%TEMP%` and cleaned up

---

## 6. Store listing copy

Paste-ready. Verify character limits in Partner Center (typical: description 10,000 · features 20 × 200 · search terms 7 × 30).

> The English copy below is the master. Localised **description + product features + keywords** for all 14
> app languages live in [`Sample/msstore/`](../Sample/msstore) (one `en-us.txt`, `ms-my.txt`, … per Store
> locale, plus a `README.md` index) — the remaining fields in this section stay English-only.

### Listing stack

- Display name and category: §6 (below)
- Description / features / keywords: `Sample/msstore/<locale>.txt`
- Visual assets: §7 · age rating, privacy and declarations: §8

### Display name

> **CUCI Video Delete Studio**

Tiles use the short name **CUCI**.

### Short description (~100 chars)

> Trim, merge and subtitle-sync video with millisecond precision — entirely on your device.

### Description

```
CUCI is a focused desktop editor for one job: deleting out the parts you don't want and
joining what's left — with subtitles that stay in sync.

MILLISECOND PRECISION
Every edit point is stored and exported to the millisecond, with optional frame snapping
based on the real source frame rate. What you set is what you get.

DELETE, MERGE, REPEAT
Remove as many ranges as you like from each clip, reorder clips, and CUCI joins the kept
segments into one continuous file. Clips with different resolutions, frame rates or missing
audio are normalised automatically.

SUBTITLES THAT FOLLOW YOUR DELETES
Load an .srt or .vtt and CUCI rewrites the timings to match your edit: captions after a delete
move earlier by exactly the removed time, captions spanning a delete are trimmed, and captions
inside a removed scene are dropped. Export the corrected subtitle file, or burn the captions
straight into the video.

FAST TIMELINE TOOLS
Set in and out points with a keystroke, double-click the ruler, or right-click the timeline
for a full delete menu. Drag delete edges to fine-tune, preview the untouched source or the final
result, and undo anything with Ctrl+Z.

FIND SCENES AUTOMATICALLY
Scan a clip with a built-in on-device classifier to flag NSFW content and mark those scenes
as deletes in one pass. No frames ever leave your computer.

SHARE AN EDIT, NOT A FILE
Save your delete list as a small job file, or copy a compact one-line code that pastes into
chat, email or a message. Anyone with the same source video can load it and get your exact
edit — including an optional note explaining what you delete and why.

BUILT FOR REAL FILES
Preview codecs your player can't handle by generating a lightweight proxy. Exports offer
H.264/H.265, CPU or GPU encoding, quality and resolution presets, with live progress and a
working Cancel.

PRIVACY
CUCI runs entirely on your device. It has no account, no ads, no purchases and no telemetry.
Your videos, subtitles and exported files are read and written only where you point the app;
preferences and cached thumbnails stay inside your Windows user profile. Network access happens
only when you start the optional Parent Assist scan, which downloads an AI model file once and then
analyses frames locally — no video, frame, filename or personal data is uploaded. Links to GitHub,
Telegram, WhatsApp, Reddit and the Microsoft Store open in your browser only after you click them.
We collect no personal data, so there is no separate privacy policy page: this statement is the
complete policy.

Requires ffmpeg for encoding — either install it yourself or use the copy bundled with the app.
```

### Product features (each ≤ 200 chars)

```
Millisecond-precision deleting with optional frame snapping
Merge multiple clips; different resolutions and frame rates are normalised automatically
Subtitle auto-sync: .srt/.vtt timings are rewritten to match your deletes, or burned in
Double-click the timeline to set in/out points; right-click for a full delete menu
Auto-detect NSFW scenes with an on-device classifier and mark them as deletes
Save and share edits as a small job file or a compact one-line code
Source and Result preview modes with seamless playback across deletes
Generate a preview proxy for codecs your player can't decode
H.264/H.265 export with CPU or GPU encoding, quality presets and live progress
Cancel an export at any time — it stops cleanly and leaves no leftovers
Undo/redo, keyboard shortcuts and a persistent status bar with full message history
Runs entirely on your device; no media is uploaded
```

### Search terms (keywords — up to 7)

```
delete video scenes
trim video
merge video
subtitle sync
srt editor
remove video parts
video editor
```

Alternates if any are taken: `split video`, `video trimming`, `subtitle editor`, `scene removal`, `mp4 trimmer`.

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
| Privacy policy URL | **leave empty** — no personal data is collected, see §8 |
| Copyright / trademark | `© 2025 AbahKool` |
| License | MIT (plus third-party notices if ffmpeg is bundled) |

### "What's new in this version" (≤ 1,500 chars)

```
First Microsoft Store release.

• Millisecond-precision deleting and merging with frame snapping
• Subtitle auto-sync — .srt/.vtt timings rewritten to match your edit, or burned in
• Double-click the timeline for in/out points, plus a right-click delete menu
• On-device NSFW scene detection
• Save and share delete jobs as a file or a one-line code
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

Screenshots are generated, not hand-captured: `npm run store:screenshots` boots the real
renderer in an isolated profile and writes five 1920×1080 PNGs per UI language into
`Sample/msstore/screenshots/<store-locale>/` (14 locales × 5 views = 70 files, local only —
`Sample/` is gitignored). Upload one set per listing language; the captions/filenames per view:

| View | Content |
| --- | --- |
| `01-editor` | Main window: filmstrip + deletions, two 0:18/0:15 delete rows, selected range, synced subtitle track and overlay |
| `02-export` | Export dialog (container, codec, quality, subtitle burn-in) |
| `03-parent-assist` | Parent Assist dialog with the on-device model status |
| `04-job` | Delete job dialog with a share code and description |
| `05-guide` | Built-in user guide |

The generator uses `Sample/bbb.mp4` (Big Buck Bunny, CC-BY 3.0, © Blender Foundation) with
generated captions — credit Blender Foundation in the listing notes if the Store asks.

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

All of these are generated from the app logo (`icons/logo.png`) by `npm run store:assets`: the logo is scaled into each shape with its aspect ratio preserved and padded with the app background colour. Update the logo, re-run the script, and the tile set and `build/icon.ico` (multi-size executable icon) are rebuilt together.

---

## 8. Age rating, privacy & declarations

### IARC age rating

You must complete the **IARC questionnaire** in Partner Center. Answer honestly — CUCI is a *content-management utility*, not a media player with preloaded content:

- It ships **no** media or sample content.
- The NSFW feature only **analyses the user's own files on-device** and never displays, stores or transmits imagery.
- No user-generated content is hosted or shared by the app.

Two things to flag in the questionnaire so the rating is sane:

- the app can **open and display video files the user provides** (so "user-generated content shown" applies);
- it includes a feature that **detects adult content**.

Disclose this in the Store description too (the copy in §6 already does). Expect a **PEGI 12 / ESRB T**-style rating and, if you rate it higher than you'd like, explain the moderation use case in the certification notes.

### Declarations / notes for certification

Paste into **Partner Center → Submission → Notes for certification**. The maintained copy (two
lengths, ~1.9K and ~1.1K characters, both under the field's ~2,000-character limit) lives in
[`store/notes-for-certification.txt`](../store/notes-for-certification.txt); the full version is:

```
CUCI is an offline desktop utility (Electron, full-trust MSIX) that removes unwanted parts of the
user's own videos. No media is bundled; no account, ads, purchases or telemetry.

WHAT IT DOES: the user adds their own videos, marks ranges on a timeline, and exports a new file
with those ranges cut out (optionally merging clips and burning in subtitles). "Parent Assist" is an
optional on-device scan that flags scenes a parent may want to remove; it is a content filter, not
an adult-content player.

TEST (no account needed; any local .mp4/.mov works)
1. Launch CUCI from Start.
2. Actions > Add videos (or drag a file in).
3. Drag on the timeline, then click Delete (or right-click > Delete range).
4. Click Export, keep MP4, click Start: progress runs and the output .mp4 is written to the path
   shown. F1 opens the in-app guide (first-run tour can be skipped).

NETWORK: the only outbound request is a one-time, user-initiated ~89 MB download of an on-device
classifier model from huggingface.co when Parent Assist is first used. Inference runs locally via
onnxruntime; no frames, files or telemetry leave the machine. If it is blocked the scan reports an
error and the rest of the app works. External links (guide > GitHub, Store rating,
Telegram/WhatsApp/Reddit share buttons) open in the default browser only after a click.

NOT BUGS
- AVI/WMV/FLV/TS may not preview (Chromium lacks those codecs); exporting still works.
- Exporting with zero deletions asks for a second confirmation, to avoid accidental re-encodes.
- ffmpeg/ffprobe are bundled and run as separate processes. ffmpeg is GPLv3; licence text and the
  source offer are at https://github.com/abahkool/cuci2 (THIRD-PARTY-NOTICES.md).

DATA: all local. No accounts, ads, telemetry or crash reports, so no personal data is collected and
no privacy policy URL is provided; the privacy statement is in the Store description.
```

There is no placeholder to replace — CUCI collects nothing, so there is no privacy policy page
(§8 below). Rules for this field: no marketing copy, no download links; the single URL in the text
is the GPLv3 source offer. If certification pushes back on adult content (10.4) or external links (10.1), quote the
*Parent Assist* paragraph and the "links open only after a click" sentence.

`THIRD-PARTY-NOTICES.md` (repo root) is the source of the GPLv3 statement referenced above; it and
`LICENSE` are shipped inside the package via `build.extraResources` (`resources/` next to the app).

### Privacy statement (no URL)

**Decision: CUCI ships no privacy policy page and no policy URL.** Store policy 10.5.1 only
requires a privacy policy URL when the product collects personal information or uses a
third-party service that does — CUCI does neither (no account, telemetry, analytics, crash
reporting, advertising ID or location). Leave Partner Center's *Privacy policy URL* field **empty**
and keep the privacy answers in the submission consistent: *no personal data collected*, *no
telemetry*, *no advertising*.

Instead of a URL, this statement is the policy. It is used verbatim in the Store description and in
the certification notes; the maintained copy (plus a `PRIVACY.md`-ready long version, and the exact
Partner Center answers) is [`store/privacy-statement.txt`](../store/privacy-statement.txt).

```
Privacy: CUCI runs entirely on your device. It has no account, no ads, no purchases and no
telemetry. Your videos, subtitles and exported files are read and written only where you point the
app; preferences and cached thumbnails stay inside your Windows user profile (%APPDATA%\CUCI and
%TEMP%). Network access happens only when you start the optional Parent Assist scan, which
downloads an AI model file from huggingface.co once and then analyses frames locally — no video,
frame, filename or personal data is uploaded. Links to GitHub, Telegram, WhatsApp, Reddit and the
Microsoft Store open in your browser only after you click them. We collect no personal data, so
there is no separate privacy policy page: this statement is the complete policy.
```

Facts behind every sentence (for review, not for pasting): settings in
`%APPDATA%\CUCI\settings.json` (`lib/ipc.js:52`), thumbnails/proxies/subtitle temp in `%TEMP%`
(`lib/ipc.js:257,559,609`), model in `%APPDATA%\CUCI\models\nsfw` (`lib/nsfw.js:50`), only
outbound request is the huggingface model download (`lib/nsfw.js:70`), external links via
`shell.openExternal` only from `share:open` / `store:open` / the Help menu.

If Partner Center ever blocks submission on a missing URL (it validates the declared data
collection, not the app), the zero-hosting fallback is the long version as `PRIVACY.md` in the repo
and its GitHub URL — do not stand up a separate site.

### Landing page / public privacy URL

`docs/index.html` is a self-contained marketing page for the product (assets in `docs/assets/`).
If you ever prefer a real URL over the empty privacy field, publish the `docs/` folder as GitHub
Pages (Settings → Pages → Source: *Deploy from a branch* → `/docs`): the page then lives at
`https://abahkool.github.io/cuci2/` and its `#privacy` section is the same statement as above.
That URL can be pasted into the Partner Center *Privacy policy URL* field — the empty field is
still the simpler choice.

---

## 9. Submission checklist

**Identity**
- [ ] Product name reserved; `store/identity.json` filled from Product identity
- [ ] `publisher` matches Partner Center exactly (including `CN=` and GUID)
- [ ] Package version is 4 parts and higher than the last submission (`package.json` version + `.0`)

**Package**
- [ ] `npm test` passes
- [ ] `npm run store:package` produced `CUCI_<version>_x64.msix`
- [ ] **WACK** run and the report is clean
- [ ] Decided on bundled ffmpeg (§4) and — if bundled — added third-party notices
- [ ] Exe icon is the real one (`build/icon.ico`)
- [ ] `npm run store:assets` was re-run after the last logo change (`store/Assets/`, `store/listing/`, `build/icon.ico`)

**Listing**
- [ ] Description, short description, features and search terms entered
- [ ] Category **Photo & video**, subcategory **Video editing**
- [ ] ≥ 1 screenshot at 1366×768+, no personal/unlicensed content visible
- [ ] 300×300 listing logo uploaded
- [ ] Support email/URL and website set
- [ ] Privacy policy URL field left empty; the privacy statement in the description matches `store/privacy-statement.txt`
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

---

## 11. Submission errors

Partner Center validates the uploaded manifest field-by-field against the reserved product, so a
mismatch costs a full 200+ MB upload and comes back after a few minutes. Decode the message
before rebuilding:

### `You must upload at least one package. If you are using market groups, then each market group must have at least one package.`

A cascade, not a separate problem: the submission's package list is empty because the package you
uploaded **failed acceptance validation** (or you removed it). Fix the package error below,
remove the rejected file, upload the new one — this message disappears on its own.

### `The PublisherDisplayName element in the app manifest is X, which doesn't match your publisher display name: Y.`

`<Package><Properties><PublisherDisplayName>` came from `publisherDisplayName` in
`store/identity.json` and must equal the **account** Publisher display name
(Partner Center → *Account settings* → Publishers), not the app's display name.

Typical cause in this repo: `store/identity.json` was missing, so
`store/identity.example.json` was used and the package carried `AbahKool` /
`CN=00000000-0000-0000-0000-000000000000`. The publisher GUID error usually follows the same
build; fixing only the display name is not enough — fill both fields from
**Product identity**:

| Manifest element | `store/identity.json` key | Partner Center field |
| --- | --- | --- |
| `Identity/@Publisher` | `publisher` | Package/Identity/Publisher (`CN=<GUID>`) |
| `Identity/@Name` | `identityName` | Package/Identity/Name |
| `Properties/PublisherDisplayName` | `publisherDisplayName` | Account publisher display name |

Then rebuild (`npm run store:package`) and check the identity **without uploading** —
`dist/msix/AppxManifest.xml` is rendered from the same values:

```powershell
Select-String -Path dist\msix\AppxManifest.xml -Pattern 'Name=|Publisher|DisplayName'
```

`scripts/build-msix.mjs` now refuses to pack when the identity is still the placeholder (exit 5),
so this specific rejection can only come from an old artifact.

### `You must provide a package that supports each selected device family (or uncheck the box for unsupported device families). Note that targeting the Xbox device family requires a neutral or x64 package.`

Nothing is wrong with the package: in **Pricing & availability → Device family** you have
**Xbox** and/or **HoloLens** ticked, but `store/AppxManifest.xml.template` only declares
`<TargetDeviceFamily Name="Windows.Desktop">`. CUCI is an Electron desktop app with
`runFullTrust`, so untick **Xbox** and **HoloLens** and keep **PC** (Windows 10/11 desktop).

### Version conflicts after a failed upload

A rejected package still occupies its version slot. Remove it from the submission before
uploading the fixed build; the same `1.0.2.0` is then accepted. If Partner Center still refuses,
bump `version` in `package.json` to `1.0.3` (→ `1.0.3.0`), rebuild and upload that instead.
