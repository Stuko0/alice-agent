# Build script for the Alice Wails desktop app (Windows).
# Mirrors build.sh: generates bindings, builds the React frontend, copies the
# assets into the Wails tree, then builds the Go shell. By default it also
# bundles a self-contained Python backend beside the binary (resources/python)
# so the desktop does not depend on a system venv. Set the env var
# ALICE_SKIP_PYTHON_BUNDLE=1 to skip (the backend then falls back to a system
# venv or the prebuilt bundle that install.ps1 placed there).
#
# Prerequisites (installed by CI / the installer's local-build fallback):
#   - Go toolchain (go.mod requires go 1.25)
#   - wails CLI:  go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
#   - mingw-w64 GCC on PATH (Wails v2 links CGO on Windows)
#   - Node.js/npm (>= 20.19)
#   - uv on PATH (only for the embedded python bundle; optional)
#
# Produces: apps/desktop-wails/build/bin/alice-desktop.exe
#   + apps/desktop-wails/build/bin/resources/python/ (embedded Python runtime)
#   + apps/desktop-wails/build/bin/resources/alice/  (agent runtime tree)
#   + apps/desktop-wails/build/bin/resources/icon.ico (shortcut/window icon)
#   + apps/desktop-wails/build/bin/resources.zip      (distributable backend)
#   + apps/desktop-wails/build/bin/alice-desktop-amd64-installer.exe  (-Nsis)
#
# -Nsis also builds the NSIS installer (requires makensis on PATH). The
# installer is user-scoped so install/update never raises UAC.

param(
    [switch]$Nsis,
    # Shell version (tag without "v"). CI passes the release tag; local builds
    # fall back to alice_cli/__init__.py. It is stamped into wails.json (NSIS +
    # PE version metadata, Add/Remove Programs) and linked into the binary
    # (main.buildVersion), so the app never reports a stale checkout's version.
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$WailsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = Join-Path (Split-Path -Parent $WailsDir) "desktop"

Push-Location $WailsDir
try {
    Write-Host "=== Building Wails bindings first ==="
    # Failure is informational (stderr usage text when up to date) — bindings
    # are committed under frontend/wailsjs anyway.
    & wails generate bindings 2>&1 | Out-Null

    Write-Host "=== Copying bindings to desktop source ==="
    $jsSrc = Join-Path $WailsDir "frontend/wailsjs/go/main"
    $jsDst = Join-Path $DesktopDir "src/lib/wailsjs/go/main"
    New-Item -ItemType Directory -Force -Path $jsDst | Out-Null
    Copy-Item (Join-Path $jsSrc "*.js") $jsDst -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $jsSrc "*.d.ts") $jsDst -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $WailsDir "frontend/wailsjs/go/models.ts") (Join-Path $DesktopDir "src/lib/wailsjs/go/") -Force -ErrorAction SilentlyContinue

    Write-Host "=== Building frontend ==="
    Push-Location $DesktopDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "frontend build failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }

    Write-Host "=== Copying frontend to Wails ==="
    $distSrc = Join-Path $DesktopDir "dist"
    $distDst = Join-Path $WailsDir "frontend/dist"
    if (Test-Path $distDst) { Remove-Item -Recurse -Force $distDst }
    Copy-Item -Recurse $distSrc $distDst

    Write-Host "=== Copying bindings to frontend dist ==="
    $assetsDst = Join-Path $distDst "assets/wailsjs/go/main"
    New-Item -ItemType Directory -Force -Path $assetsDst | Out-Null
    Copy-Item (Join-Path $jsSrc "*.js") $assetsDst -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $jsSrc "*.d.ts") $assetsDst -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Join-Path $distDst "assets/wailsjs/go") | Out-Null
    Copy-Item (Join-Path $WailsDir "frontend/wailsjs/go/models.ts") (Join-Path $distDst "assets/wailsjs/go/") -Force -ErrorAction SilentlyContinue

    # --- Version stamping -----------------------------------------------------
    # NSIS takes INFO_PRODUCTVERSION from wails.json (VIProductVersion + the
    # uninstaller entry), and the About/update code reads main.buildVersion.
    if (-not $Version) {
        $initPy = Join-Path (Split-Path -Parent $WailsDir) "alice_cli\__init__.py"
        if (Test-Path $initPy) {
            $m = Select-String -Path $initPy -Pattern '__version__\s*=\s*"([^"]+)"' | Select-Object -First 1
            if ($m) { $Version = $m.Matches[0].Groups[1].Value }
        }
    }
    if (-not $Version) { $Version = "0.0.0" }
    $Version = $Version.TrimStart("v")

    # Commit + build time: without them every republish of a tag is
    # indistinguishable in About, which turns "does the installer have the new
    # UI?" into guesswork. CI exports GITHUB_SHA; local builds ask git.
    $commit = $env:GITHUB_SHA
    if (-not $commit) {
        $commit = (& git -C $WailsDir rev-parse --short HEAD 2>$null)
    }
    if ($commit) { $commit = $commit.Trim().Substring(0, [Math]::Min(7, $commit.Trim().Length)) }

    $builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    $ldflags = "-X main.buildVersion=$Version"
    if ($commit) { $ldflags += " -X main.buildCommit=$commit" }
    $ldflags += " -X main.buildTime=$builtAt"

    Write-Host "=== Build stamp: $Version $commit ($builtAt) ==="

    Write-Host "=== Stamping version $Version ==="
    $wailsJsonPath = Join-Path $WailsDir "wails.json"
    $wailsJson = Get-Content $wailsJsonPath -Raw | ConvertFrom-Json
    $wailsJson.info.productVersion = $Version
    $wailsJson | ConvertTo-Json -Depth 12 | Set-Content $wailsJsonPath -Encoding utf8

    Write-Host "=== Building Wails binary ==="
    & wails build -platform windows/amd64 -ldflags $ldflags
    if ($LASTEXITCODE -ne 0) { throw "wails build failed (exit $LASTEXITCODE)" }

    # Bundle a self-contained Python backend beside the binary so the desktop
    # does not depend on a system venv. Takes minutes (PyPI pull); best-effort
    # (never fails the build). tools/install.ps1 places a prebuilt bundle here
    # for the prebuilt-download path, so this only matters for local builds.
    $resourcesDir = Join-Path $WailsDir "build\bin\resources"

    if ($env:ALICE_SKIP_PYTHON_BUNDLE -ne "1" -and (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Host "=== Bundling embedded Python backend ==="
        & ./scripts/bundle-python.ps1 -Dest (Join-Path $resourcesDir "python") -SkipZip
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "!! python bundle failed (build continues; desktop needs a system venv)"
        }
    } else {
        Write-Host "=== Skipping embedded Python backend (uv absent or ALICE_SKIP_PYTHON_BUNDLE=1) ==="
    }

    # Runtime tree: makes the installer self-sufficient (no checkout, no CLI).
    Write-Host "=== Staging agent runtime tree ==="
    & ./scripts/stage-runtime.ps1 -Dest (Join-Path $resourcesDir "alice")
    if ($LASTEXITCODE -ne 0) { throw "runtime staging failed (exit $LASTEXITCODE)" }

    # Standalone icon beside the exe: shortcuts reference it by path so a
    # re-stamped exe never shows a stale cached icon after an update.
    $iconSrc = Join-Path $DesktopDir "assets/icon.ico"
    if (Test-Path $iconSrc) {
        Copy-Item -Force $iconSrc (Join-Path $resourcesDir "icon.ico")
    }

    # One distributable zip for install.ps1's prebuilt path: resources/python +
    # resources/alice + resources/icon.ico.
    $zipPath = Join-Path $WailsDir "build\bin\resources.zip"
    Write-Host "=== Packaging $zipPath ==="
    if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
    Compress-Archive -Path $resourcesDir -DestinationPath $zipPath -CompressionLevel Fastest -Force
    if (-not (Test-Path $zipPath)) { throw "resources.zip packaging failed" }

    if ($Nsis) {
        Write-Host "=== Building NSIS installer ==="
        if (-not (Get-Command makensis -ErrorAction SilentlyContinue)) {
            throw "makensis not found on PATH (install NSIS: choco install nsis -y)"
        }

        # build/ is gitignored, so the canonical scripts live under installer/.
        # wails build -nsis reads build/windows/installer/project.nsi.
        $installerDir = Join-Path $WailsDir "build\windows\installer"
        New-Item -ItemType Directory -Force -Path $installerDir | Out-Null
        Copy-Item -Force (Join-Path $WailsDir "installer/project.nsi") (Join-Path $installerDir "project.nsi")
        if (Test-Path $iconSrc) {
            Copy-Item -Force $iconSrc (Join-Path $WailsDir "build\windows\icon.ico")
        }

        & wails build -platform windows/amd64 -nsis -installscope user -ldflags $ldflags
        if ($LASTEXITCODE -ne 0) { throw "wails nsis build failed (exit $LASTEXITCODE)" }
    }

    Write-Host "=== Done ==="
    Write-Host "Binary: $(Join-Path $WailsDir 'build/bin/alice-desktop.exe')"
    Write-Host "Backend: $(Join-Path $WailsDir 'build/bin/resources.zip')"
    if ($Nsis) {
        Write-Host "Installer: $(Join-Path $WailsDir 'build/bin/alice-desktop-amd64-installer.exe')"
    }
} finally {
    Pop-Location
}