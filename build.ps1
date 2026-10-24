# CUCI - Build Script
# --------------------
# Checks the toolchain, bumps the version when sources changed, runs the tests
# (optional), then packages with electron-builder (NSIS installer / portable)
# or stages + packs the Microsoft Store MSIX via scripts/build-msix.mjs.
#
#   .\build.ps1                 # NSIS installer (default)
#   .\build.ps1 -Portable       # portable single .exe
#   .\build.ps1 -Store          # MSIX for the Microsoft Store (store:package)
#   .\build.ps1 -Store -StageOnly
#   .\build.ps1 -Installer -Portable
#   .\build.ps1 -Sign           # sign the produced binaries (needs a cert)
#   .\build.ps1 -SkipTests      # skip npm test
#   .\build.ps1 -SkipVersion    # do not bump package.json
#
# Notes
#  * electron-builder is launched through node cli.js: the .cmd shim fails with
#    EINVAL when spawned from PowerShell on this project.
#  * The MSIX target needs makeappx.exe (Windows SDK) and store/identity.json;
#    without them the script stages dist/msix and prints the next step.

param(
    [switch]$Installer = $false,
    [switch]$Portable = $false,
    [switch]$Store = $false,
    [switch]$StageOnly = $false,
    [switch]$Sign = $false,
    [switch]$SkipTests = $false,
    [switch]$SkipVersion = $false
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSCommandPath
$DistDir = Join-Path $ProjectRoot 'dist'

function Step($n, $text) {
    Write-Host ""
    Write-Host "[$n] $text" -ForegroundColor Yellow
}
function Ok($text) { Write-Host "  $text" -ForegroundColor Green }
function Info($text) { Write-Host "  $text" -ForegroundColor Gray }
function Warn($text) { Write-Host "  WARNING: $text" -ForegroundColor DarkYellow }
function Die($text) { Write-Host "  ERROR: $text" -ForegroundColor Red; exit 1 }

if (-not ($Installer -or $Portable -or $Store)) { $Installer = $true }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CUCI - Cut Out Bad Scenes - Build"      -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Push-Location $ProjectRoot
try {
    # ── 1. toolchain ────────────────────────────────────────────────
    Step '1/8' 'Checking Node.js...'
    $nodeVersion = node --version 2>&1
    if ($LASTEXITCODE -ne 0) { Die 'Node.js is not installed (https://nodejs.org).' }
    Ok "Node.js $nodeVersion"
    if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
        Step '1/8' 'Installing dependencies (first run, may fetch ~110 MB ffmpeg)...'
        npm install
        if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' }
        Ok 'Dependencies installed.'
    } else {
        Info 'node_modules present - skipping npm install'
    }

    # ── 2. version bump from a source hash ──────────────────────────
    Step '2/8' 'Checking sources for a version bump...'
    $hashFile = Join-Path $ProjectRoot '.last-build-hash'
    $codeFiles = Get-ChildItem $ProjectRoot -Recurse -File -Include *.js,*.mjs,*.html,*.css,*.json |
        Where-Object {
            $_.FullName -notmatch '\\node_modules\\' -and
            $_.FullName -notmatch '\\dist\\' -and
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
    Step '3/8' 'Running the test suite...'
    if ($SkipTests) {
        Warn 'Skipped (-SkipTests)'
    } else {
        npm test
        if ($LASTEXITCODE -ne 0) { Die 'npm test failed - fix the tests before shipping.' }
        Ok 'All tests passed.'
    }

    # ── 4. clean ────────────────────────────────────────────────────
    Step '4/8' 'Cleaning previous output...'
    if (Test-Path $DistDir) { Remove-Item $DistDir -Recurse -Force }
    Ok 'dist/ is empty.'

    $ebCli = Join-Path $ProjectRoot 'node_modules\electron-builder\cli.js'

    # ── 5. Windows installer / portable ─────────────────────────────
    Step '5/8' 'Building Windows targets...'
    if ($Installer) {
        Info 'Target: NSIS installer'
        node $ebCli --win nsis --config.directories.output="$DistDir"
        if ($LASTEXITCODE -ne 0) { Die 'electron-builder (nsis) failed.' }
        Ok 'NSIS installer built.'
    }
    if ($Portable) {
        Info 'Target: portable .exe'
        node $ebCli --win portable --config.directories.output="$DistDir"
        if ($LASTEXITCODE -ne 0) { Die 'electron-builder (portable) failed.' }
        Ok 'Portable build built.'
    }
    if (-not ($Installer -or $Portable)) { Info 'No electron-builder target selected.' }

    # ── 6. Microsoft Store MSIX ─────────────────────────────────────
    Step '6/8' 'Microsoft Store package...'
    if ($Store) {
        if (-not (Test-Path (Join-Path $ProjectRoot 'store\identity.json'))) {
            Warn 'store/identity.json is missing - copy store/identity.example.json and fill in your Partner Center values.'
            Warn 'Continuing with the example identity (fine for a local stage test).'
        }
        if ($StageOnly) {
            npm run store:stage
        } else {
            npm run store:package
        }
        if ($LASTEXITCODE -ne 0) {
            Warn 'store:package did not complete (makeappx.exe / identity). dist/msix is still staged.'
        } else {
            Ok 'MSIX staged/packed.'
        }
    } else {
        Info 'Skipped (use -Store)'
    }

    # ── 7. signing ──────────────────────────────────────────────────
    Step '7/8' 'Signing...'
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
        if (-not $signtool) { Die 'signtool.exe not found (install the Windows SDK).' }

        $binaries = Get-ChildItem $DistDir -Recurse -File -Include *.exe,*.msix,*.dll
        if (-not $binaries) { Warn 'No binaries to sign.' }
        foreach ($bin in $binaries) {
            Info "Signing $($bin.Name) ..."
            & $signtool.FullName sign /fd SHA256 /f $pfx /tr 'http://timestamp.digicert.com' /td SHA256 /v $bin.FullName | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok 'Signed.' } else { Warn "Signing failed for $($bin.Name)." }
        }
    }

    # ── 8. summary ──────────────────────────────────────────────────
    Step '8/8' 'Done.'
    $outs = Get-ChildItem $DistDir -Recurse -File -Include *.exe,*.msix,*.appx,*.zip -ErrorAction SilentlyContinue
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
