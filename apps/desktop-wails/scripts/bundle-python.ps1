# bundle-python.ps1 — assemble a self-contained Python backend beside the Wails
# binary (resources/python) so the Windows desktop does not depend on a system
# venv. Mirrors bundle-python.sh but produces the Windows layout the Go
# fallbacks expect (python_manager.go):
#   findPythonForRoot   -> resources/python/python.exe
#   findVenvRoot        -> resources/python
#   getVenvSitePackages -> resources/python/Lib/site-packages
#
# The bundle is a uv-managed CPython (python-build-standalone) — a fully
# self-contained runtime with its own stdlib and pip — with the alice-agent
# project and its deps installed into Lib\site-packages.
#
# Usage:
#   .\bundle-python.ps1 [[-PythonVersion 3.13] [-Dest <dir>] [-SkipInstall]]
#     PythonVersion  default 3.13
#     Dest           default <repo>/apps/desktop-wails/build/bin/resources/python
#     -SkipInstall   only stage the CPython layout (no pip install of alice) —
#                    used for a quick layout-smoke in CI before the slow install
#
# Requires: uv on PATH (provisions the standalone CPython). The project+deps
# install pulls from PyPI and takes several minutes — run in the background.
#
# Also emits, beside the bundle, a `resources/python.tar.gz` containing the
# bundle so the installer (scripts/install.ps1) can ship it as a downloadable
# release artifact instead of rebuilding it on the user's machine.

param(
    [string]$PythonVersion = "3.13",
    [string]$Dest = "",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..\..")).Path

if (-not $Dest) {
    $Dest = Join-Path $ScriptDir "..\build\bin\resources\python"
}
$Dest = [System.IO.Path]::GetFullPath($Dest)

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Error "uv not found (needed to provision the standalone CPython)"
}

# 1. Provision the STANDALONE CPython into a fresh staging dir. --install-dir
#    guarantees python-build-standalone (self-contained) rather than resolving
#    the project's .venv (which `uv python find` would happily return).
$Staging = Join-Path $env:TEMP ("alice-bundle-py-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Staging | Out-Null
try {
    Write-Host "Provisioning standalone CPython $PythonVersion ..."
    & uv python install --install-dir $Staging $PythonVersion
    if ($LASTEXITCODE -ne 0) { throw "uv python install failed" }

    $SrcRoot = Get-ChildItem -Path $Staging -Directory -Filter "cpython-*" | Select-Object -First 1
    if (-not $SrcRoot) { throw "could not locate standalone CPython in $Staging" }
    Write-Host "standalone cpython source: $($SrcRoot.FullName)"

    # 2. Copy the self-contained runtime into the bundle. Robocopy preserves
    #    the tree (python.exe at root, Lib\, DLLs\, etc.) — the layout the Go
    #    fallbacks expect. robocopy exit codes: <8 is success.
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    & robocopy $SrcRoot.FullName $Dest /E /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

    $PyExe = Join-Path $Dest "python.exe"
    if (-not (Test-Path $PyExe)) { throw "no python.exe in bundle at $PyExe" }

    if (-not $SkipInstall) {
        # 3. Install alice-agent + deps into the bundle. Use the bundle's own
        #    pip (python-build-standalone ships it), run from repo root so
        #    `pip install .` finds pyproject.toml.
        Write-Host "installing alice-agent (+deps) into $Dest ... (pulls from PyPI)"
        Push-Location $RepoRoot
        try {
            # --break-system-packages: python-build-standalone ships PEP 668
            # EXTERNALLY-MANAGED; this bundle IS the managed package.
            & $PyExe -m pip install --break-system-packages --no-input --quiet .
            if ($LASTEXITCODE -ne 0) { throw "pip install of alice-agent failed" }
        } finally {
            Pop-Location
        }

        # 4. Smoke test: the bundled python must import alice_cli.
        Write-Host "smoke test: importing alice_cli from the bundle ..."
        $env:ALICE_HOME = Join-Path $env:TEMP ("alice-home-" + [guid]::NewGuid().ToString("N"))
        try {
            & $PyExe -c "import alice_cli; print('alice_cli OK, version', alice_cli.__version__)"
            if ($LASTEXITCODE -ne 0) { throw "bundle smoke test failed" }
        } finally {
            Remove-Item Env:\ALICE_HOME -ErrorAction SilentlyContinue
        }
    }

    # 5. Package a distributable tar.gz of the bundle beside it (for the
    #    Windows installer release artifact). Use ABSOLUTE paths — on Windows
    #    pwsh's Push-Location does not change the native tar.exe cwd, so a
    #    relative -C "resources" fails with "could not chdir". tar.exe is
    #    available on Win10 1803+.
    $BundleParent = Split-Path -Parent $Dest          # ...\build\bin
    $tgzPath = Join-Path $BundleParent "python.tar.gz"
    Write-Host "packaging $tgzPath ..."
    & tar -czf $tgzPath -C $BundleParent "resources"
    if ($LASTEXITCODE -ne 0) { throw "tar packaging failed (exit $LASTEXITCODE)" }

    Write-Host "bundle ready: $Dest"
    Write-Host "  python: $PyExe"
    Write-Host "  distributable: $tgzPath"
    $size = (Get-Item $Dest).Length
    Write-Host ("  size: {0:N1} MB" -f ($size / 1MB))
} finally {
    Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue
}