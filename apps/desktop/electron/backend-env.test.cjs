const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  POSIX_SANE_PATH_ENTRIES,
  appendUniquePathEntries,
  buildDesktopBackendEnv,
  buildDesktopBackendPath,
  normalizeLydiaHomeRoot,
  pathEnvKey
} = require('./backend-env.cjs')

test('desktop backend PATH adds Lydia-managed bins and missing POSIX sane entries', () => {
  const result = buildDesktopBackendPath({
    lydiaHome: '/Users/test/.lydia',
    venvRoot: '/Users/test/.lydia/lydia-agent/venv',
    currentPath: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
    platform: 'darwin',
    pathModule: path.posix
  })

  const entries = result.split(':')
  assert.equal(entries[0], '/Users/test/.lydia/node/bin')
  assert.equal(entries[1], '/Users/test/.lydia/lydia-agent/venv/bin')
  assert.ok(entries.includes('/opt/homebrew/bin'), 'Apple Silicon Homebrew bin is added')
  assert.ok(entries.includes('/opt/homebrew/sbin'), 'Apple Silicon Homebrew sbin is added')
  assert.ok(entries.includes('/usr/local/sbin'), 'missing standard sbin is added')

  for (const expected of POSIX_SANE_PATH_ENTRIES) {
    assert.ok(entries.includes(expected), `${expected} should be present`)
  }
})

test('desktop backend PATH preserves first occurrence and avoids duplicates', () => {
  const result = buildDesktopBackendPath({
    lydiaHome: '/Users/test/.lydia',
    venvRoot: '/Users/test/.lydia/lydia-agent/venv',
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
    lydiaHome: '/Users/test/.lydia',
    pythonPathEntries: ['/repo/lydia-agent'],
    venvRoot: '/Users/test/.lydia/lydia-agent/venv',
    currentEnv: {
      PATH: '/usr/bin:/bin',
      PYTHONPATH: '/existing/pythonpath'
    },
    platform: 'darwin',
    pathModule: path.posix
  })

  assert.equal(env.PYTHONPATH, '/repo/lydia-agent:/existing/pythonpath')
  assert.ok(env.PATH.startsWith('/Users/test/.lydia/node/bin:/Users/test/.lydia/lydia-agent/venv/bin:'))
  assert.ok(env.PATH.includes('/opt/homebrew/bin'))
})

test('normalizeLydiaHomeRoot maps profile homes back to the global Lydia root', () => {
  assert.equal(
    normalizeLydiaHomeRoot('/Users/test/.lydia/profiles/oracle', { pathModule: path.posix }),
    '/Users/test/.lydia'
  )
  assert.equal(
    normalizeLydiaHomeRoot('C:\\Users\\test\\AppData\\Local\\lydia\\profiles\\oracle', { pathModule: path.win32 }),
    'C:\\Users\\test\\AppData\\Local\\lydia'
  )
  assert.equal(normalizeLydiaHomeRoot('/Users/test/.lydia', { pathModule: path.posix }), '/Users/test/.lydia')
})

test('Windows PATH casing and delimiter are preserved without POSIX sane entries', () => {
  const env = buildDesktopBackendEnv({
    lydiaHome: 'C:\\Users\\test\\AppData\\Local\\lydia',
    pythonPathEntries: ['C:\\repo\\lydia-agent'],
    venvRoot: 'C:\\Users\\test\\AppData\\Local\\lydia\\lydia-agent\\venv',
    currentEnv: {
      Path: 'C:\\Windows\\System32;C:\\Windows',
      PYTHONPATH: 'C:\\existing\\pythonpath'
    },
    platform: 'win32',
    pathModule: path.win32
  })

  assert.equal(pathEnvKey({ Path: 'x' }, 'win32'), 'Path')
  assert.equal(env.PATH, undefined)
  assert.ok(env.Path.startsWith('C:\\Users\\test\\AppData\\Local\\lydia\\node\\bin;'))
  assert.ok(env.Path.includes('\\venv\\Scripts;'))
  assert.ok(env.Path.includes(';C:\\Windows\\System32;C:\\Windows'))
  assert.equal(env.Path.includes('/opt/homebrew/bin'), false)
})

test('appendUniquePathEntries drops empty entries and keeps first occurrence', () => {
  assert.equal(appendUniquePathEntries([':/a::/b', ['/a', '/c']], { delimiter: ':' }), '/a:/b:/c')
})
