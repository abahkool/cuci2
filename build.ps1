# CUCI - Build Script
# --------------------
# Checks the toolchain, bumps the version when sources changed, runs the tests,
# obfuscates the renderer, verifies the obfuscated app, then packages:
#   * NSIS installer  (-Installer, default)
#   * portable .exe   (-Portable)
#   * Microsoft Store .msix  (-Store)
#   * legacy .appx           (-Appx)
# Signing is opt-in (-Sign).
#
#   .\build.ps1                          # NSIS installer, obfuscated + verified
#   .\build.ps1 -Portable
#   .\build.ps1 -Installer -Portable -Store -Appx
#   .\build.ps1 -Store -NoDownload       # never fetch the SDK tools from NuGet
#   .\build.ps1 -NoObfuscate             # package readable sources (debug only)
#   .\build.ps1 -SkipTests -SkipVerify   # packaging only
#   .\build.ps1 -Sign                    # sign the produced binaries
#   .\build.ps1 -Store -AllowExampleIdentity  # test package, REJECTED by the Store
#
# Notes
#  * The obfuscated app is staged in .build/app and every artifact is built from
#    there. scripts/verify-build.cjs boots it before packaging (i18n, media,
#    deletes) so a broken obfuscation never reaches a release.
#  * electron-builder is launched through node cli.js: the .cmd shim fails with
#    EINVAL when spawned from PowerShell.
#  * makeappx.exe comes from the Windows SDK when installed; otherwise the
#    Microsoft "Windows SDK BuildTools" package is downloaded once into
#    vendor/msix-tools/ (pass -NoDownload to forbid that).
#  * Store uploads do not need to be signed - Microsoft re-signs them.

param(
    [switch]$Installer = $false,
    [switch]$Portable = $false,
    [switch]$Store = $false,
    [switch]$Appx = $false,
    [switch]$Sign = $false,
    [switch]$NoObfuscate = $false,
    [switch]$NoDownload = $false,
    [switch]$SkipTests = $false,
    [switch]$SkipVerify = $false,
    [switch]$SkipVersion = $false,
    [switch]$AllowExampleIdentity = $false
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSCommandPath
$DistDir = Join-Path $ProjectRoot 'dist'
$AppDir = Join-Path $ProjectRoot '.build\app'

function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Yellow }
function Ok($text) { Write-Host "  $text" -ForegroundColor Green }
function Info($text) { Write-Host "  $text" -ForegroundColor Gray }
function Warn($text) { Write-Host "  WARNING: $text" -ForegroundColor DarkYellow }
function Die($text) { Write-Host "  ERROR: $text" -ForegroundColor Red; exit 1 }

if (-not ($Installer -or $Portable -or $Store -or $Appx)) { $Installer = $true }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CUCI - Delete Unnecessary Video Scenes - Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Push-Location $ProjectRoot
try {
    # ── 1. toolchain ────────────────────────────────────────────────
    Step '1/9' 'Checking Node.js...'
    $nodeVersion = node --version 2>&1
    if ($LASTEXITCODE -ne 0) { Die 'Node.js is not installed (https://nodejs.org).' }
    Ok "Node.js $nodeVersion"
    if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
        Info 'First run: installing dependencies (may fetch ~110 MB ffmpeg)...'
        npm install
        if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' }
    }
    if (-not $NoObfuscate -and -not (Test-Path (Join-Path $ProjectRoot 'node_modules\javascript-obfuscator'))) {
        Info 'Installing the obfuscator...'
        npm install --save-dev javascript-obfuscator
        if ($LASTEXITCODE -ne 0) { Die 'Could not install javascript-obfuscator.' }
    }
    Ok 'Dependencies ready.'

    # ── 2. version bump from a source hash ──────────────────────────
    Step '2/9' 'Checking sources for a version bump...'
    $hashFile = Join-Path $ProjectRoot '.last-build-hash'
    $codeFiles = Get-ChildItem $ProjectRoot -Recurse -File -Include *.js,*.mjs,*.cjs,*.html,*.css,*.json |
        Where-Object {
            $_.FullName -notmatch '\\node_modules\\' -and
            $_.FullName -notmatch '\\dist\\' -and
            $_.FullName -notmatch '\\.build\\' -and
            $_.FullName -notmatch '\\vendor\\' -and
            $_.FullName -notmatch '\\Sample\\' -and
            $_.Name -notin @('package-lock.json', 'package.json')
        } | Sort-Object FullName
    $sb = New-Object System.Text.StringBuilder
    foreach ($f in $codeFiles) { [void]$sb.Append((Get-FileHash $f.FullName -Algorithm SHA256).Hash) }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $codeHash = ([System.BitConverter]::ToString($hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString())))).Replace('-', '')
    $lastHash = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { '' }
    if ($SkipVersion) {
        Info 'Version bump skipped (-SkipVersion)'
    } elseif ($codeHash -ne $lastHash) {
        node -e "const fs=require('fs');const p='package.json',l='package-lock.json';const pj=JSON.parse(fs.readFileSync(p));const v=(pj.version||'0.0.0').split('.');while(v.length<3)v.push('0');v[2]=(parseInt(v[2],10)+1);const nv=v.join('.');pj.version=nv;fs.writeFileSync(p,JSON.stringify(pj,null,2)+'\n');try{const lj=JSON.parse(fs.readFileSync(l));lj.version=nv;fs.writeFileSync(l,JSON.stringify(lj,null,2)+'\n')}catch(e){}console.log(nv)"
        if ($LASTEXITCODE -ne 0) { Die 'Version bump failed.' }
        Set-Content -Path $hashFile -Value $codeHash
        $newVer = node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).version)"
        Ok "Version bumped to $newVer"
    } else {
        Ok 'No source changes - keeping the version.'
    }

    # ── 3. tests ────────────────────────────────────────────────────
    Step '3/9' 'Running the test suite...'
    if ($SkipTests) {
        Warn 'Skipped (-SkipTests)'
    } else {
        npm test
        if ($LASTEXITCODE -ne 0) { Die 'npm test failed - fix the tests before shipping.' }
        Ok 'All tests passed.'
    }

    # ── 4. clean ────────────────────────────────────────────────────
    Step '4/9' 'Cleaning previous output...'
    if (Test-Path $DistDir) { Remove-Item $DistDir -Recurse -Force }
    if (Test-Path (Join-Path $ProjectRoot '.build')) { Remove-Item (Join-Path $ProjectRoot '.build') -Recurse -Force }
    Ok 'dist/ and .build/ are empty.'

    # ── 5. obfuscate + verify ───────────────────────────────────────
    Step '5/9' 'Obfuscating the renderer...'
    $BuildAppDir = ''
    if ($NoObfuscate) {
        Warn 'Skipped (-NoObfuscate) - packaging the working tree as-is.'
    } else {
        node scripts/obfuscate.mjs --out "$AppDir"
        if ($LASTEXITCODE -ne 0) { Die 'Obfuscation failed.' }
        $BuildAppDir = $AppDir
        Ok "Obfuscated app staged in $AppDir"
        if (-not $SkipVerify) {
            Info 'Verifying the obfuscated app boots...'
            node_modules\.bin\electron.cmd scripts\verify-build.cjs --app-dir "$AppDir"
            if ($LASTEXITCODE -ne 0) { Die 'The obfuscated build failed verification (see output above).' }
        }
    }

    $ebCli = Join-Path $ProjectRoot 'node_modules\electron-builder\cli.js'
    $appDirFlag = if ($BuildAppDir) { @("--config.directories.app=$BuildAppDir") } else { @() }

    # ── 6. Windows installer / portable ─────────────────────────────
    Step '6/9' 'Building Windows targets...'
    if ($Installer) {
        Info 'Target: NSIS installer'
        node $ebCli --win nsis --config.directories.output="$DistDir" @appDirFlag
        if ($LASTEXITCODE -ne 0) { Die 'electron-builder (nsis) failed.' }
        Ok 'NSIS installer built.'
    }
    if ($Portable) {
        Info 'Target: portable .exe'
        node $ebCli --win portable --config.directories.output="$DistDir" @appDirFlag
        if ($LASTEXITCODE -ne 0) { Die 'electron-builder (portable) failed.' }
        Ok 'Portable build built.'
    }
    if (-not ($Installer -or $Portable)) { Info 'No electron-builder target selected.' }

    # ── 7. Microsoft Store packages ─────────────────────────────────
    Step '7/9' 'Microsoft Store packages (.msix / .appx)...'
    if (-not ($Store -or $Appx)) {
        Info 'Skipped (use -Store and/or -Appx)'
    } else {
        if (-not (Test-Path (Join-Path $ProjectRoot 'store\identity.json')) -and -not $AllowExampleIdentity) {
            Die @'
store/identity.json is missing - an MSIX built with the example identity is rejected
by Partner Center ("The PublisherDisplayName element ... doesn't match your publisher
display name"). Copy store/identity.example.json to store/identity.json and fill in the
values from Partner Center -> your app -> Product identity. See docs/STORE-SUBMISSION.md.
For a throwaway test package: -AllowExampleIdentity
'@
        }
        $msixArgs = @()
        if ($AllowExampleIdentity) { $msixArgs += '--allow-example-identity' }
        if (-not (Test-Path (Join-Path $DistDir 'win-unpacked'))) {
            Info 'No win-unpacked yet - build-msix will create it.'
        }
        if ($NoDownload) { $msixArgs += '--no-download' }
        if ($BuildAppDir) { $msixArgs += @('--app-dir', $BuildAppDir) }

        if ($Store) {
            Info 'Packing .msix...'
            node scripts/build-msix.mjs @msixArgs
            if ($LASTEXITCODE -ne 0) { Warn '.msix packing failed (see output above).' } else { Ok '.msix packed.' }
        }
        if ($Appx) {
            Info 'Packing legacy .appx...'
            $appxArgs = $msixArgs
            if ($Store) { $appxArgs += '--skip-build' }   # reuse the unpacked build
            node scripts/build-msix.mjs --appx @appxArgs
            if ($LASTEXITCODE -ne 0) { Warn '.appx packing failed (see output above).' } else { Ok '.appx packed.' }
        }
    }

    # ── 8. signing ──────────────────────────────────────────────────
    Step '8/9' 'Signing...'
    if (-not $Sign) {
        Info 'Skipped (use -Sign)'
    } else {
        $certDir = Join-Path $ProjectRoot 'certs'
        $pfx = Join-Path $certDir 'code-signing.pfx'
        if (-not (Test-Path $pfx)) {
            $openssl = Get-Command openssl -ErrorAction SilentlyContinue
            if (-not $openssl) { Die 'No certs/code-signing.pfx and no openssl in PATH to create one.' }
            if (-not (Test-Path $certDir)) { New-Item -ItemType Directory -Path $certDir -Force | Out-Null }
            $key = Join-Path $certDir 'key.pem'
            $crt = Join-Path $certDir 'cert.pem'
            Info 'Generating a self-signed code-signing certificate (10 years)...'
            openssl req -x509 -newkey rsa:2048 -keyout $key -out $crt -days 3650 -nodes `
                -subj '/CN=CUCI' -addext 'extendedKeyUsage=codeSigning' -addext 'keyUsage=digitalSignature' 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { Die 'openssl certificate generation failed.' }
            openssl pkcs12 -export -out $pfx -inkey $key -in $crt -passout 'pass:' 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { Die 'openssl pkcs12 export failed.' }
            Remove-Item $key, $crt -Force -ErrorAction SilentlyContinue
            Ok "Certificate created: $pfx"
        } else {
            Info "Using existing certificate: $pfx"
        }

        $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
        if (-not $signtool -and (Test-Path (Join-Path $ProjectRoot 'vendor\msix-tools'))) {
            $signtool = Get-ChildItem (Join-Path $ProjectRoot 'vendor\msix-tools') -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
        }
        if (-not $signtool) { Die 'signtool.exe not found (install the Windows SDK or run -Store once).' }

        $binaries = Get-ChildItem $DistDir -Recurse -File -Include *.exe,*.msix,*.appx,*.dll
        if (-not $binaries) { Warn 'No binaries to sign.' }
        foreach ($bin in $binaries) {
            Info "Signing $($bin.Name) ..."
            & $signtool.FullName sign /fd SHA256 /f $pfx /tr 'http://timestamp.digicert.com' /td SHA256 /v $bin.FullName | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok 'Signed.' } else { Warn "Signing failed for $($bin.Name)." }
        }
    }

    # ── 9. summary ──────────────────────────────────────────────────
    Step '9/9' 'Done.'
    $outs = Get-ChildItem $DistDir -Recurse -File -Include *.exe,*.msix,*.appx,*.zip -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\win-unpacked\\' -and $_.FullName -notmatch '\\msix\\' }
    if ($outs) {
        foreach ($o in $outs) { Write-Host ("  {0}" -f $o.FullName) -ForegroundColor White }
    } else {
        Info 'No packaged output yet (tests only?).'
    }
    Write-Host ""
    Write-Host "  Build finished." -ForegroundColor Green
    Write-Host "  Store checklist: docs/STORE-SUBMISSION.md" -ForegroundColor Gray
    Write-Host ""
} finally {
    Pop-Location
}
