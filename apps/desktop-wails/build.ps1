# Build script for the Alice Wails desktop app (Windows).
# Mirrors build.sh: generates bindings, builds the React frontend, copies the
# assets into the Wails tree, then builds the Go shell.
#
# Prerequisites (installed by CI / the installer's local-build fallback):
#   - Go toolchain (go.mod requires go 1.25)
#   - wails CLI:  go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
#   - mingw-w64 GCC on PATH (Wails v2 links CGO on Windows)
#   - Node.js/npm (>= 20.19)
#
# Produces: apps/desktop-wails/build/bin/alice-desktop.exe

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

    Write-Host "=== Building Wails binary ==="
    & wails build -windowsarch amd64
    if ($LASTEXITCODE -ne 0) { throw "wails build failed (exit $LASTEXITCODE)" }

    Write-Host "=== Done ==="
    Write-Host "Binary: $(Join-Path $WailsDir 'build/bin/alice-desktop.exe')"
} finally {
    Pop-Location
}
