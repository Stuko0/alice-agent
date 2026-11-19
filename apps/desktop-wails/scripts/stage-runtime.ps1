# stage-runtime.ps1 — copy the agent's runtime tree beside the Wails binary so an
# installer-managed Windows install needs no git checkout and no `alice` CLI.
#
# Layout produced (matching python_manager.go:installerRuntimeRoot):
#   build\bin\resources\alice\alice_cli\main.py
#   build\bin\resources\alice\skills\...
#   build\bin\resources\python\python.exe        (from bundle-python.ps1)
#
# The Go shell resolves <exe>\resources\alice first (after the explicit
# ALICE_DESKTOP_ALICE_ROOT override), runs `python -m alice_cli.main serve` with
# that root on PYTHONPATH, and extracts its embedded SPA to
# %ALICE_HOME%\desktop-dist (never into this tree).
#
# Usage:
#   .\stage-runtime.ps1 [-Dest <dir>]
#     Dest  default <repo>/apps/desktop-wails/build/bin/resources/alice
#
# Excludes: __pycache__, *.pyc, node_modules, build outputs and VCS metadata.
# `scripts\` is included on purpose: install/update helpers and dep_ensure are
# imported by the agent at runtime.

param(
    [string]$Dest = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..\..")).Path
$WailsDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $Dest) {
    $Dest = Join-Path $WailsDir "build\bin\resources\alice"
}
$Dest = [System.IO.Path]::GetFullPath($Dest)

# Directories that make up the runtime. Keep this list in sync with
# `[tool.setuptools.packages.find]` in pyproject.toml plus the data dirs the
# agent reads from disk (skills/optional-skills/locales).
$RuntimeDirs = @(
    "alice_cli",
    "agent",
    "acp_adapter",
    "cron",
    "gateway",
    "plugins",
    "providers",
    "tools",
    "tui_gateway",
    "skills",
    "optional-skills",
    "locales",
    "scripts"
)

# Top-level modules listed in pyproject's `py-modules` (the backend imports them
# by name; without them `serve` can't start).
$RuntimeFiles = @(
    "run_agent.py",
    "model_tools.py",
    "toolsets.py",
    "batch_runner.py",
    "trajectory_compressor.py",
    "toolset_distributions.py",
    "cli.py",
    "alice_bootstrap.py",
    "alice_constants.py",
    "alice_state.py",
    "alice_time.py",
    "alice_logging.py",
    "utils.py",
    "mcp_serve.py",
    "pyproject.toml",
    "README.md",
    "LICENSE"
)

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# robocopy: <8 is success. /XD prunes heavy dirs, /XF prunes build noise.
$ExcludeDirs = @("__pycache__", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", "build")
$ExcludeFiles = @("*.pyc", "*.pyo", ".DS_Store")

foreach ($dir in $RuntimeDirs) {
    $src = Join-Path $RepoRoot $dir
    if (-not (Test-Path $src)) {
        Write-Warning "runtime dir missing, skipping: $dir"
        continue
    }

    $dst = Join-Path $Dest $dir
    & robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /XD @ExcludeDirs /XF @ExcludeFiles | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $dir (exit $LASTEXITCODE)" }
}

foreach ($file in $RuntimeFiles) {
    $src = Join-Path $RepoRoot $file
    if (-not (Test-Path $src)) {
        Write-Warning "runtime file missing, skipping: $file"
        continue
    }

    Copy-Item -Force $src (Join-Path $Dest $file)
}

$entry = Join-Path $Dest "alice_cli\main.py"
if (-not (Test-Path $entry)) { throw "runtime tree is missing alice_cli\main.py at $Dest" }

$size = (Get-ChildItem -Recurse -File $Dest | Measure-Object -Property Length -Sum).Sum
Write-Host ("runtime tree ready: {0} ({1:N1} MB)" -f $Dest, ($size / 1MB))

# robocopy exits 1/3 on success; make the script exit code explicit.
exit 0
