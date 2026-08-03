'use strict'

// Regression guards for Windows `lydia` resolution in main.cjs.
//
// main.cjs has no module.exports, so these follow the repo's source-assertion
// test pattern (see windows-child-process.test.cjs). They pin the two Windows
// resolution bugs that caused desktop reinstall loops:
//   1. findOnPath() tried the empty extension FIRST, so an extensionless
//      Git-Bash `lydia` shim shadowed the real lydia.cmd/lydia.exe; the
//      shim then failed the --version probe and the desktop fell through to a
//      spurious bootstrap/repair.
//   2. handOffWindowsBootstrapRecovery() chose --update vs the destructive
//      --repair by checking ONLY venv\Scripts\lydia.exe (the console-script
//      shim, written at the END of venv setup and absent in interrupted
//      states), so it escalated to a full venv recreate even on healthy
//      installs.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function readMain() {
  return fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8').replace(/\r\n/g, '\n')
}

test('findOnPath tries PATHEXT extensions before the bare (empty) name on Windows', () => {
  const source = readMain()
  // Fixed order: PATHEXT first, empty string LAST.
  assert.match(
    source,
    /\(process\.env\.PATHEXT \|\| '\.COM;\.EXE;\.BAT;\.CMD'\)\.split\(';'\)\.filter\(Boolean\), ''\]/,
    'extensions array must end with the empty string, not start with it'
  )
  // The buggy empty-first order must not return.
  assert.doesNotMatch(
    source,
    /\['', \.\.\.\(process\.env\.PATHEXT/,
    'empty-extension-first order regressed: an extensionless shim can shadow lydia.cmd/.exe'
  )
})

test('Windows bootstrap recovery chooses --update when any real-install signal is present', () => {
  const source = readMain()
  assert.match(source, /const haveRealInstall =/, 'recovery must compute haveRealInstall')
  assert.match(
    source,
    /fileExists\(venvPython\)/,
    'recovery must accept the venv interpreter as a real-install signal'
  )
  assert.match(
    source,
    /\.lydia-bootstrap-complete/,
    'recovery must accept the bootstrap-complete marker as a real-install signal'
  )
  assert.match(
    source,
    /updaterArgs = haveRealInstall \? \['--update'/,
    'updaterArgs must gate on haveRealInstall'
  )
  // The old too-narrow check (only venv\Scripts\lydia.exe) must not return.
  assert.doesNotMatch(
    source,
    /updaterArgs = fileExists\(venvLydia\) \?/,
    'recovery regressed to gating only on the lydia.exe shim, which forces destructive --repair'
  )
})
