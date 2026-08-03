'use strict'

/**
 * stage-python-backend.cjs
 *
 * Downloads and stages a portable Python 3.11 distribution (python-embed)
 * with Lydia and all its Python dependencies for packaging inside the
 * Electron desktop app as an extraResource.
 *
 * Output layout:
 *   build/windows/python/
 *     python.exe               (embeddable Python runtime)
 *     python3.dll, python311.dll, python311.zip (stdlib)
 *     python._pth              (modified to include site-packages)
 *     site-packages/           (lydia + all deps via uv pip install --target)
 *     scripts/
 *       lydia-serve.py         (bundled entry point)
 *
 * Runs as part of `npm run build` on Windows (or as a pre-step before
 * electron-builder on CI). Idempotent — always re-stages deps to pick
 * up changes.
 *
 * Cache: downloads python-embed .zip once into build/.cache/.
 * Re-extract and re-install deps on every run (fast with local cache).
 *
 * Environment variables:
 *   LYDIA_SKIP_PYTHON_BUNDLE=1  — skip this script entirely (dev builds)
 *   PYTHON_EMBED_VERSION        — override Python version (default 3.11.11)
 */

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')
const https = require('node:https')
const { stdout } = require('node:process')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const APP_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')
const STAGE_ROOT = path.join(APP_ROOT, 'build', 'windows', 'python')
const SCRIPTS_DIR = path.join(STAGE_ROOT, 'scripts')
const SITE_PACKAGES = path.join(STAGE_ROOT, 'site-packages')
const CACHE_DIR = path.join(APP_ROOT, 'build', '.cache')

// ---------------------------------------------------------------------------
// Python version
// ---------------------------------------------------------------------------
const PYTHON_VERSION = process.env.PYTHON_EMBED_VERSION || '3.11.9'
const PYTHON_EMBED_URL =
  `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`
const PYTHON_ZIP_CACHE = path.join(CACHE_DIR, `python-${PYTHON_VERSION}-embed-amd64.zip`)

// Minimum free disk space required (MB) for the bundle operation
const MIN_DISK_MB = 500

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rmrf(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true })
  }
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true })
}

function fileSizeMb(p) {
  try {
    return fs.statSync(p).size / (1024 * 1024)
  } catch { return 0 }
}

function hasFreeDiskMb(targetDir, requiredMb) {
  try {
    // On Windows check the drive's free space; on POSIX check the mount.
    const platform = process.platform
    if (platform === 'win32') {
      const drive = path.parse(targetDir).root || 'C:\\'
      const result = execSync(
        `wmic logicaldisk where "DeviceID='${drive.replace(/\\/g, '\\\\')}'" get FreeSpace /format:csv`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
      )
      const match = result.match(/(\d+)\s*$/)
      if (match) {
        const freeBytes = parseInt(match[1], 10)
        return freeBytes >= requiredMb * 1024 * 1024
      }
    } else {
      const result = execSync(`df -m "${targetDir}" | tail -1`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
      })
      const parts = result.trim().split(/\s+/)
      // df output: Filesystem 1M-blocks Used Available Use% Mounted
      if (parts.length >= 4) {
        const available = parseInt(parts[3], 10)
        return available >= requiredMb
      }
    }
  } catch {
    // If df/wmic fails, assume we have enough space — the build would fail
    // anyway with a clearer error.
  }
  return true
}

// ---------------------------------------------------------------------------
// Download python-embed (with cache)
// ---------------------------------------------------------------------------
function downloadPythonEmbed() {
  if (fs.existsSync(PYTHON_ZIP_CACHE)) {
    const cachedSize = fileSizeMb(PYTHON_ZIP_CACHE)
    console.log(
      `[stage-python-backend] using cached ${path.relative(CACHE_DIR, PYTHON_ZIP_CACHE)}` +
        ` (${cachedSize.toFixed(1)} MB)`
    )
    return
  }

  console.log(`[stage-python-backend] downloading python ${PYTHON_VERSION} embed...`)
  ensureDir(CACHE_DIR)

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(PYTHON_ZIP_CACHE)

    const doRequest = (url) => {
      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect (python.org uses redirects)
          file.close()
          fs.unlinkSync(PYTHON_ZIP_CACHE)
          console.log(`[stage-python-backend] redirect → ${res.headers.location}`)
          return resolve(doRequest(res.headers.location))
        }
        if (res.statusCode !== 200) {
          file.close()
          fs.unlinkSync(PYTHON_ZIP_CACHE)
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
        }

        const total = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0

        res.on('data', (chunk) => {
          downloaded += chunk.length
          if (total && process.stdout.isTTY) {
            const pct = (downloaded / total * 100).toFixed(1)
            stdout.write(`\r[stage-python-backend] downloading... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`)
          }
        })

        res.pipe(file)
        file.on('finish', () => {
          file.close()
          if (process.stdout.isTTY) stdout.write('\n')
          console.log(`[stage-python-backend] downloaded ${(fileSizeMb(PYTHON_ZIP_CACHE)).toFixed(1)} MB`)
          resolve()
        })
      }).on('error', (err) => {
        file.close()
        if (fs.existsSync(PYTHON_ZIP_CACHE)) fs.unlinkSync(PYTHON_ZIP_CACHE)
        reject(err)
      })
    }

    doRequest(PYTHON_EMBED_URL)
  })
}

// ---------------------------------------------------------------------------
// Extract python-embed archive
// ---------------------------------------------------------------------------
function extractPythonEmbed() {
  console.log('[stage-python-backend] extracting python embed...')
  ensureDir(STAGE_ROOT)

  // Use the system unzip (available on Windows via Git Bash, or use tar.exe on
  // Windows 10+). Fall back to 7-Zip if available.
  let cmd, args

  // Determine platform-appropriate extraction
  if (process.platform === 'win32') {
    // Windows 10+ has tar.exe built-in
    cmd = 'tar'
    args = ['-xf', PYTHON_ZIP_CACHE, '-C', STAGE_ROOT]
  } else {
    cmd = 'unzip'
    args = ['-qo', PYTHON_ZIP_CACHE, '-d', STAGE_ROOT]
  }

  try {
    execSync(`${cmd} ${args.join(' ')}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      cwd: APP_ROOT
    })
  } catch (err) {
    // Fall back to a Node.js zip extraction if system tools fail
    console.log('[stage-python-backend] system unzip failed, using Node.js extraction...')
    const { spawnSync } = require('node:child_process')
    // Try PowerShell's Expand-Archive on Windows
    if (process.platform === 'win32') {
      const result = spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${PYTHON_ZIP_CACHE}" -DestinationPath "${STAGE_ROOT}" -Force`
      ], { stdio: 'pipe', timeout: 120000 })
      if (result.status !== 0) {
        throw new Error(
          `Failed to extract python-embed: system tools unavailable.\n` +
          `Install unzip (Git Bash), 7-Zip, or use Windows 10+ (tar.exe built-in).\n` +
          `Stderr: ${(result.stderr || '').toString().trim().slice(0, 200)}`
        )
      }
    } else {
      throw new Error(
        `Failed to extract python-embed: unzip not available.\n` +
        `Stderr: ${(err.stderr || '').toString().trim().slice(0, 200)}`
      )
    }
  }

  // Verify python.exe exists
  const pythonExe = path.join(STAGE_ROOT, 'python.exe')
  if (!fs.existsSync(pythonExe)) {
    throw new Error(
      `python.exe not found after extraction. Expected at ${pythonExe}. ` +
      `The python-embed archive structure may have changed.`
    )
  }

  console.log(`[stage-python-backend] extracted ${(fileSizeMb(PYTHON_ZIP_CACHE)).toFixed(1)} MB → ${path.relative(APP_ROOT, STAGE_ROOT)}`)
}

// ---------------------------------------------------------------------------
// Configure python._pth to include site-packages
// ---------------------------------------------------------------------------
function configurePathFile() {
  const pthFile = path.join(STAGE_ROOT, 'python._pth')
  if (!fs.existsSync(pthFile)) {
    console.log('[stage-python-backend] WARNING: python._pth not found, creating default')
    ensureDir(STAGE_ROOT)
    fs.writeFileSync(pthFile, [
      'python311.zip',
      '.',
      'site-packages',
      '',
      '# Uncomment to run site.main() automatically',
      '#import site',
      ''
    ].join('\n'), 'utf8')
    return
  }

  let content = fs.readFileSync(pthFile, 'utf8')
  const lines = content.split('\n').map(l => l.trimEnd())

  // Check if site-packages is already in the path list
  const hasSitePkg = lines.some(l => l.trim() === 'site-packages')

  if (!hasSitePkg) {
    // Insert site-packages after the zip entry and '.', before comments/import
    let insertAt = 0
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('import')) {
        insertAt = i
        break
      }
      insertAt = i + 1
    }
    lines.splice(insertAt, 0, 'site-packages')
    content = lines.join('\n')
    // Normalize line endings for Windows
    content = content.replace(/\r?\n/g, '\r\n')
    fs.writeFileSync(pthFile, content, 'utf8')
    console.log('[stage-python-backend] added site-packages to python._pth')
  } else {
    console.log('[stage-python-backend] python._pth already includes site-packages')
  }
}

// ---------------------------------------------------------------------------
// Install Lydia + dependencies via uv
// ---------------------------------------------------------------------------
function installDependencies() {
  console.log('[stage-python-backend] installing Lydia + dependencies...')

  rmrf(SITE_PACKAGES)
  ensureDir(SITE_PACKAGES)

  // Use uv to install the current project + its dependencies into the
  // bundled site-packages.  --target installs directly into the directory
  // without needing a venv or having pip in the embed runtime.
  const installTarget = SITE_PACKAGES

  // Check if uv is available
  let uvCmd
  try {
    execSync('uv --version', { stdio: 'ignore', timeout: 10000 })
    uvCmd = 'uv'
  } catch {
    // Try python -m uv
    try {
      execSync('python -m uv --version', { stdio: 'ignore', timeout: 10000 })
      uvCmd = 'python -m uv'
    } catch {
      // Try pipx
      try {
        execSync('pipx run uv --version', { stdio: 'ignore', timeout: 10000 })
        uvCmd = 'pipx run uv'
      } catch {
        throw new Error(
          'uv is required to install bundled Python dependencies.\n' +
          'Install it: https://docs.astral.sh/uv/#getting-started\n' +
          '  Windows (PowerShell): irm https://astral.sh/uv/install.ps1 | iex\n' +
          '  macOS/Linux: curl -LsSf https://astral.sh/uv/install.sh | sh'
        )
      }
    }
  }

  console.log(`[stage-python-backend] using: ${uvCmd}`)

  // Install the project + all dependencies into target directory.
  // We use non-editable install (no -e) so the package files are
  // actually copied into site-packages/ instead of creating a
  // .egg-link / .pth redirect.  --only-binary is NOT set because
  // the local package (lydia-agent) must be built from source.
  const result = execSync(
    `${uvCmd} pip install --target "${installTarget}" "${REPO_ROOT}"` +
    `  --no-verify-hashes` +
    `  -q`,
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000, // 5 min for uv to solve + download
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024 // 10 MB stdout
    }
  )

  console.log(`[stage-python-backend] uv install complete`)

  // Print a summary of what was installed
  try {
    const pkgDirs = fs.readdirSync(installTarget)
      .filter(d => d !== '__pycache__' && !d.endsWith('.dist-info') && !d.endsWith('.egg-info'))
    console.log(`[stage-python-backend] site-packages: ${pkgDirs.length} packages`)
  } catch { /* ignore */ }

  // Clean up .pyc files and __pycache__ dirs to save space
  const cleaned = cleanPycFiles(installTarget)
  if (cleaned > 0) {
    console.log(`[stage-python-backend] cleaned ${cleaned} __pycache__ / .pyc entries`)
  }
}

function cleanPycFiles(dir) {
  let count = 0
  if (!fs.existsSync(dir)) return count

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        rmrf(full)
        count++
      } else {
        count += cleanPycFiles(full)
      }
    } else if (entry.name.endsWith('.pyc')) {
      fs.unlinkSync(full)
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Write the entry point script
// ---------------------------------------------------------------------------
function writeEntryPoint() {
  const entryFile = path.join(SCRIPTS_DIR, 'lydia-serve.py')
  ensureDir(SCRIPTS_DIR)

  // The entry point sets up sys.path for the bundled site-packages,
  // then runs `lydia serve` with the provided argv.
  const entryContent = `\"\"\"Bundled Lydia backend entry point for Windows standalone.

This script is bundled inside the Electron app at
  resources/python/scripts/lydia-serve.py

It sets up sys.path to find the bundled site-packages/ and then
delegates to lydia_cli.main with \"serve\" arguments.  The Electron
main process (main.cjs) spawns this as:

  python.exe scripts/lydia-serve.py [--profile NAME]

instead of the usual \"python -m lydia_cli.main serve ...\".

When called with --probe, it just imports lydia_cli.config and exits 0.
This is used by the Electron backend resolver to verify the bundle
works before committing to it.
\"\"\"
import os
import sys


def _setup_paths():
    \"\"\"Add the bundled site-packages to sys.path.\"\"\"
    # This script lives at resources/python/scripts/lydia-serve.py
    # site-packages is at resources/python/site-packages/
    script_dir = os.path.dirname(os.path.abspath(__file__))
    bundle_dir = os.path.dirname(script_dir)  # python/
    site_pkg = os.path.join(bundle_dir, \"site-packages\")

    if os.path.isdir(site_pkg) and site_pkg not in sys.path:
        sys.path.insert(0, site_pkg)

    # Support site-packages as .zip (future optimization)
    site_zip = site_pkg + \".zip\"
    if os.path.isfile(site_zip) and site_zip not in sys.path:
        sys.path.insert(0, site_zip)


def main():
    _setup_paths()
    # --probe mode: verify the bundle can import lydia_cli without
    # actually starting the server.
    if \"--probe\" in sys.argv:
        import yaml  # noqa: F401 — verify yaml (a core dep) is loadable
        import lydia_cli.config  # noqa: F401 — verify CLI is importable
        sys.exit(0)

    from lydia_cli.main import main as lydia_main
    sys.exit(lydia_main())


if __name__ == \"__main__\":
    # Our argv is already set up by the Electron spawn with the
    # right serve arguments (or --probe).  Just run.
    main()
`

  fs.writeFileSync(entryFile, entryContent, 'utf8')
  console.log(`[stage-python-backend] wrote ${path.relative(APP_ROOT, entryFile)}`)
}

// ---------------------------------------------------------------------------
// Verify the bundle
// ---------------------------------------------------------------------------
function verifyBundle() {
  console.log('[stage-python-backend] verifying bundle...')

  const checks = [
    { name: 'python.exe', path: path.join(STAGE_ROOT, 'python.exe') },
    { name: 'python311.dll', path: path.join(STAGE_ROOT, 'python311.dll') },
    { name: 'site-packages', path: SITE_PACKAGES, isDir: true },
    { name: 'lydia-serve.py', path: path.join(SCRIPTS_DIR, 'lydia-serve.py') },
  ]

  // Verify lydia_cli is installed
  const lydiaCliDir = path.join(SITE_PACKAGES, 'lydia_cli')
  checks.push({ name: 'lydia_cli package', path: lydiaCliDir, isDir: true })

  const failures = []
  for (const check of checks) {
    const exists = check.isDir
      ? fs.existsSync(check.path) && fs.statSync(check.path).isDirectory()
      : fs.existsSync(check.path)
    if (!exists) {
      failures.push(check.name)
    }
  }

  if (failures.length > 0) {
    console.error(`[stage-python-backend] VERIFICATION FAILED — missing: ${failures.join(', ')}`)
    console.error(`  Stage root: ${STAGE_ROOT}`)
    console.error(`  Directory contents:`)
    listDir(STAGE_ROOT, '    ')
    process.exit(1)
  }

  // Quick size summary
  const totalSize = dirSize(STAGE_ROOT)
  console.log(`[stage-python-backend] ✓ bundle verified: ${path.relative(APP_ROOT, STAGE_ROOT)}`)
  console.log(`[stage-python-backend]   total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`)
}

function listDir(dir, indent = '') {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const size = entry.isFile() ? ` (${(fs.statSync(full).size / 1024).toFixed(1)} KB)` : '/'
      console.error(`${indent}${entry.name}${size}`)
    }
  } catch { /* dir may not exist yet */ }
}

function dirSize(dir) {
  let total = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += dirSize(full)
      } else if (entry.isFile()) {
        total += fs.statSync(full).size
      }
    }
  } catch { /* ignore */ }
  return total
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Skip if env var is set
  if (process.env.LYDIA_SKIP_PYTHON_BUNDLE) {
    console.log('[stage-python-backend] skipped (LYDIA_SKIP_PYTHON_BUNDLE=1)')
    return
  }

  // Only run on Windows or when explicitly targeting Windows
  if (process.platform !== 'win32' && !process.env.LYDIA_FORCE_PYTHON_BUNDLE) {
    console.log('[stage-python-backend] skipped (not Windows; set LYDIA_FORCE_PYTHON_BUNDLE=1 to force)')
    return
  }

  console.log(`[stage-python-backend] staging bundled Python ${PYTHON_VERSION}...`)

  // Check disk space
  if (!hasFreeDiskMb(STAGE_ROOT, MIN_DISK_MB)) {
    throw new Error(
      `Insufficient disk space. Need at least ${MIN_DISK_MB} MB free at ${STAGE_ROOT}`
    )
  }

  // Step 1: Download
  await downloadPythonEmbed()

  // Step 2: Extract
  rmrf(STAGE_ROOT)
  ensureDir(path.dirname(STAGE_ROOT))
  extractPythonEmbed()

  // Step 3: Configure path
  configurePathFile()

  // Step 4: Install dependencies
  installDependencies()

  // Step 5: Write entry point
  writeEntryPoint()

  // Step 6: Verify
  verifyBundle()

  console.log('[stage-python-backend] done.')
}

main().catch(err => {
  console.error(`[stage-python-backend] ERROR: ${err.message}`)
  process.exit(1)
})
