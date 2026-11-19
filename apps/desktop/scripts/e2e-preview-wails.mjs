#!/usr/bin/env node
/**
 * Preview E2E harness (Wails / WebKit matrix, automatable half).
 *
 *   node apps/desktop/scripts/e2e-preview-wails.mjs [--no-generate]
 *
 * What it does:
 *   1. regenerates the large preview fixtures (deterministic, git-ignored);
 *   2. runs the Go end-to-end harness (`TestPreviewE2E`) against the real
 *      loopback preview origin — status codes, MIME, CSP/nosniff, token
 *      scoping, traversal refusals, thumbnail dimensions, GIF passthrough and
 *      port release on stop;
 *   3. prints one row per case plus the GUI-only cases that still need a human
 *      on a machine with a display.
 *
 * Exit codes: 0 all automated cases passed, 1 failures, 2 harness could not run
 * (e.g. `go` missing).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const wailsDir = join(repoRoot, 'apps', 'desktop-wails')
const fixturesDir = join(repoRoot, 'apps', 'desktop', 'preview-fixtures')

const noGenerate = process.argv.includes('--no-generate')

// Cases that cannot be automated without a live GUI session. Kept in sync with
// apps/desktop/preview-fixtures/README.md.
const MANUAL_CASES = [
  ['html paints with relative CSS/JS/image', 'visual: styles, logo and fetched JSON render in the WebKit iframe'],
  ['ES module executes and fetches data.json', 'body[data-fixture-result="ok"] in the DOM inspector'],
  ['form / dialog / download / popup', 'sandbox tokens allow form submit, showModal, download and popup'],
  ['remote fetch blocked by CSP', 'fetch("https://example.com") rejected, page stays usable'],
  ['gif animates', 'both frames play (passthrough preserves frames)'],
  ['markdown 2MB stays responsive', 'first paint < 300ms, DOM node count bounded while scrolling'],
  ['python 30k lines renders plain by default', '"Highlight anyway" banner shown, no Shiki pass'],
  ['text 4MB truncation banner', 'refusal → Preview anyway → "Showing first 512 KB."'],
  ['close preview tab releases origin', 'port no longer answers (covered by automation, verified in GUI too)'],
  ['12-tab working set', '20 opens leave 12 tabs, newest kept']
]

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(2)
}

if (!existsSync(wailsDir)) {
  fail(`missing ${wailsDir}`)
}

if (!noGenerate) {
  console.log('▸ generating preview fixtures…')
  await import(pathToFileURL(join(here, 'gen-preview-fixtures.mjs')).href)
}

const largeFixtures = [
  'md-large.md',
  'py-large.py',
  'img-huge.png',
  'gif-anim.gif',
  'text-huge.log'
].map(name => join(fixturesDir, 'large', name))

const missing = largeFixtures.filter(path => !existsSync(path))

if (missing.length > 0) {
  fail(`missing fixtures: ${missing.map(path => path.replace(repoRoot, '.')).join(', ')}`)
}

console.log('▸ fixtures:')
for (const path of largeFixtures) {
  console.log(`   ${path.replace(repoRoot, '.')} ${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`)
}

console.log('\n▸ running Go preview E2E harness…')

const run = spawnSync('go', ['test', '-count=1', '-json', '-run', '^TestPreviewE2E$', '.'], {
  cwd: wailsDir,
  encoding: 'utf8',
  timeout: 180_000
})

if (run.error) {
  fail(`could not run go test: ${run.error.message}`)
}

const cases = new Map()
let harnessFailed = false
let nonJSON = ''

for (const line of (run.stdout || '').split('\n')) {
  const trimmed = line.trim()

  if (!trimmed) continue

  if (!trimmed.startsWith('{')) {
    nonJSON += `${line}\n`
    continue
  }

  let event
  try {
    event = JSON.parse(trimmed)
  } catch {
    nonJSON += `${line}\n`
    continue
  }

  if (event.Test === 'TestPreviewE2E') {
    if (event.Action === 'fail') harnessFailed = true
    continue
  }

  if (!event.Test?.startsWith('TestPreviewE2E/')) continue

  const name = event.Test.slice('TestPreviewE2E/'.length)

  if (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip') {
    cases.set(name, { action: event.Action, elapsed: event.Elapsed ?? 0 })
  } else if (event.Action === 'output' && event.Output?.startsWith('    preview_e2e_test.go:')) {
    const current = cases.get(name)
    if (current && current.action === 'fail') current.detail = event.Output.trim()
  }
}

if (cases.size === 0) {
  console.error(nonJSON || run.stderr || '')
  fail('the Go harness produced no cases (build error?)')
}

const icons = { pass: '✔', fail: '✖', skip: '○' }
const automated = [...cases.entries()].sort(([a], [b]) => a.localeCompare(b))

console.log('')

for (const [name, result] of automated) {
  console.log(`${icons[result.action]} ${name.padEnd(34)} ${result.action.padEnd(5)} ${result.elapsed.toFixed(2)}s`)
  if (result.detail) console.log(`   ${result.detail}`)
}

const failed = automated.filter(([, result]) => result.action === 'fail')
const skipped = automated.filter(([, result]) => result.action === 'skip')

console.log(`\n▸ automated: ${automated.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`)

console.log('\n▸ manual (needs a running `alice desktop` + WebKitGTK session):')
for (const [name, note] of MANUAL_CASES) {
  console.log(`○ ${name.padEnd(42)} ${note}`)
}

if (nonJSON.trim()) {
  console.log('\n▸ go test stderr/stdout:')
  console.log(nonJSON.trim())
}

if (failed.length > 0 || harnessFailed) {
  console.error('\n✖ preview E2E failed')
  process.exit(1)
}

console.log('\n✔ preview E2E passed')
