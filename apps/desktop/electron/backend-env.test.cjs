const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  POSIX_SANE_PATH_ENTRIES,
  appendUniquePathEntries,
  buildDesktopBackendEnv,
  buildDesktopBackendPath,
  normalizeAliceHomeRoot,
  pathEnvKey
} = require('./backend-env.cjs')

test('desktop backend PATH adds Alice-managed bins and missing POSIX sane entries', () => {
  const result = buildDesktopBackendPath({
    aliceHome: '/Users/test/.alice',
    venvRoot: '/Users/test/.alice/alice-agent/venv',
    currentPath: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
    platform: 'darwin',
    pathModule: path.posix
  })

  const entries = result.split(':')
  assert.equal(entries[0], '/Users/test/.alice/node/bin')
  assert.equal(entries[1], '/Users/test/.alice/alice-agent/venv/bin')
  assert.ok(entries.includes('/opt/homebrew/bin'), 'Apple Silicon Homebrew bin is added')
  assert.ok(entries.includes('/opt/homebrew/sbin'), 'Apple Silicon Homebrew sbin is added')
  assert.ok(entries.includes('/usr/local/sbin'), 'missing standard sbin is added')

  for (const expected of POSIX_SANE_PATH_ENTRIES) {
    assert.ok(entries.includes(expected), `${expected} should be present`)
  }
})

test('desktop backend PATH preserves first occurrence and avoids duplicates', () => {
  const result = buildDesktopBackendPath({
    aliceHome: '/Users/test/.alice',
    venvRoot: '/Users/test/.alice/alice-agent/venv',
    currentPath: '/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:/bin',
    platform: 'darwin',
    pathModule: path.posix
  })

  const entries = result.split(':')
  assert.equal(entries.filter(entry => entry === '/opt/homebrew/bin').length, 1)
  assert.ok(
    entries.indexOf('/opt/homebrew/bin') < entries.indexOf('/opt/homebrew/sbin'),
    'existing Homebrew bin keeps its precedence over appended missing sane entries'
  )
})

test('buildDesktopBackendEnv extends PYTHONPATH and backend PATH together', () => {
  const env = buildDesktopBackendEnv({
    aliceHome: '/Users/test/.alice',
    pythonPathEntries: ['/repo/alice-agent'],
    venvRoot: '/Users/test/.alice/alice-agent/venv',
    currentEnv: {
      PATH: '/usr/bin:/bin',
      PYTHONPATH: '/existing/pythonpath'
    },
    platform: 'darwin',
    pathModule: path.posix
  })

  assert.equal(env.PYTHONPATH, '/repo/alice-agent:/existing/pythonpath')
  assert.ok(env.PATH.startsWith('/Users/test/.alice/node/bin:/Users/test/.alice/alice-agent/venv/bin:'))
  assert.ok(env.PATH.includes('/opt/homebrew/bin'))
})

test('normalizeAliceHomeRoot maps profile homes back to the global Alice root', () => {
  assert.equal(
    normalizeAliceHomeRoot('/Users/test/.alice/profiles/oracle', { pathModule: path.posix }),
    '/Users/test/.alice'
  )
  assert.equal(
    normalizeAliceHomeRoot('C:\\Users\\test\\AppData\\Local\\alice\\profiles\\oracle', { pathModule: path.win32 }),
    'C:\\Users\\test\\AppData\\Local\\alice'
  )
  assert.equal(normalizeAliceHomeRoot('/Users/test/.alice', { pathModule: path.posix }), '/Users/test/.alice')
})

test('Windows PATH casing and delimiter are preserved without POSIX sane entries', () => {
  const env = buildDesktopBackendEnv({
    aliceHome: 'C:\\Users\\test\\AppData\\Local\\alice',
    pythonPathEntries: ['C:\\repo\\alice-agent'],
    venvRoot: 'C:\\Users\\test\\AppData\\Local\\alice\\alice-agent\\venv',
    currentEnv: {
      Path: 'C:\\Windows\\System32;C:\\Windows',
      PYTHONPATH: 'C:\\existing\\pythonpath'
    },
    platform: 'win32',
    pathModule: path.win32
  })

  assert.equal(pathEnvKey({ Path: 'x' }, 'win32'), 'Path')
  assert.equal(env.PATH, undefined)
  assert.ok(env.Path.startsWith('C:\\Users\\test\\AppData\\Local\\alice\\node\\bin;'))
  assert.ok(env.Path.includes('\\venv\\Scripts;'))
  assert.ok(env.Path.includes(';C:\\Windows\\System32;C:\\Windows'))
  assert.equal(env.Path.includes('/opt/homebrew/bin'), false)
})

test('appendUniquePathEntries drops empty entries and keeps first occurrence', () => {
  assert.equal(appendUniquePathEntries([':/a::/b', ['/a', '/c']], { delimiter: ':' }), '/a:/b:/c')
})
