#!/usr/bin/env node
/**
 * Interaction latency harness for Alice Desktop (P0.0).
 *
 *   node apps/desktop/scripts/measure-interactions.mjs [--case=all] [--reps=20] [--port=9222]
 *   node apps/desktop/scripts/measure-interactions.mjs --self-test
 *
 * For every case and repetition we record:
 *   t0 = Input.dispatchMouseEvent (click) send time, measured in the page clock
 *   t1 = first DOM mutation matching the case's observable (state flipped)
 *   t2 = first requestAnimationFrame after t1 (≈ next paint)
 * plus a PerformanceObserver long-task list per repetition.
 *
 * Output: per-case min/p50/p95/max for t1-t0 and t2-t0, top long tasks, and a
 * JSON artifact at /tmp/opencode/interaction-baseline.json.
 *
 * Requires a running renderer with a CDP port (Electron):
 *   npm run profile:main        # --inspect=9229; use --remote-debugging-port=9222
 *
 * Cases whose selectors are not present are reported as `skipped` (never as a
 * pass) so a missing UI affordance can't be mistaken for a good measurement.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).flatMap(raw => {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/)

    return m ? [[m[1], m[2] ?? true]] : []
  })
)

const PORT = Number(args.port ?? 9222)
const REPS = Number(args.reps ?? 20)
const CASE = String(args.case ?? 'all')
const OUT = String(args.out ?? '/tmp/opencode/interaction-baseline.json')

// ── stats (pure; exercised by --self-test) ───────────────────────────────────

export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = q => {
    if (!sorted.length) return null
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * q))

    return Number(sorted[index].toFixed(2))
  }

  return {
    n: sorted.length,
    min: sorted.length ? Number(sorted[0].toFixed(2)) : null,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null
  }
}

/**
 * Normalize a telemetry export (`{samples:[{name,ms}]}`) or a harness artifact
 * (`{results:[{case, summary:{paint:{p95}}}]}`) into `{ case: p95 }` numbers.
 * Pure, so the CI self-test can cover it without a display.
 */
export function baselineFrom(value) {
  if (!value || typeof value !== 'object') return {}

  const out = {}

  if (Array.isArray(value.samples)) {
    for (const sample of value.samples) {
      if (typeof sample?.name !== 'string' || typeof sample?.ms !== 'number') continue
      out[sample.name] = out[sample.name] ?? { values: [] }
      out[sample.name].values.push(sample.ms)
    }

    for (const [name, entry] of Object.entries(out)) {
      out[name] = summarize(entry.values).p95
    }

    return out
  }

  if (Array.isArray(value.results)) {
    for (const result of value.results) {
      const p95 = result?.summary?.paint?.p95

      if (typeof result?.case === 'string' && typeof p95 === 'number') {
        out[result.case] = p95
      }
    }

    return out
  }

  // Tagged baseline: `{ meta, cases: { "toggle-git": 40 } }`.
  if (value.cases && typeof value.cases === 'object') {
    for (const [name, entry] of Object.entries(value.cases)) {
      if (typeof entry === 'number') out[name] = entry
      else if (entry && typeof entry === 'object' && typeof entry.p95 === 'number') out[name] = entry.p95
    }

    return out
  }

  // Hand-written baseline: `{ "toggle-git": 40 }` or `{ "toggle-git": { p95: 40 } }`.
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'number') {
      out[name] = entry
    } else if (entry && typeof entry === 'object' && typeof entry.p95 === 'number') {
      out[name] = entry.p95
    }
  }

  return out
}

/**
 * Compare current p95 values against a baseline. A case is "regressed" when it
 * got > `threshold` worse. Missing cases are reported, never guessed.
 */
export function compareToBaseline(current, baseline, threshold = 0.4) {
  const rows = []

  for (const [name, p95] of Object.entries(current)) {
    const base = baseline[name]

    if (typeof base !== 'number') {
      rows.push({ baseline: null, case: name, current: p95, deltaPct: null, regressed: false })
      continue
    }

    const deltaPct = base === 0 ? 0 : ((p95 - base) / base) * 100

    rows.push({
      baseline: base,
      case: name,
      current: p95,
      deltaPct: Number(deltaPct.toFixed(1)),
      regressed: deltaPct > threshold * 100
    })
  }

  return rows.sort((a, b) => a.case.localeCompare(b.case))
}

// ── cases ────────────────────────────────────────────────────────────────────
// `click` is the statusbar / dialog selector. `expect` is the mutation anchor
// observed after the click. `attribute` watches that attribute flip.

const CASES = {
  'toggle-git': {
    click: '[data-statusbar-item="git-provider"]',
    expect: '[data-pane-id="review"]',
    attribute: 'data-pane-open',
    note: 'git review pane open/close'
  },
  'toggle-terminal': {
    click: '[data-statusbar-item="terminal"]',
    expect: '[data-pane-id="terminal-sidebar"]',
    attribute: 'data-pane-open',
    note: 'terminal pane open/close'
  },
  'toggle-browser': {
    click: '[data-statusbar-item="browser-tabs"]',
    expect: '[data-pane-id="browser-tabs"]',
    attribute: 'data-pane-open',
    note: 'browser tabs pane open/close'
  },
  'toggle-graph': {
    click: '[data-statusbar-item="view-toggle"]',
    expect: 'iframe[title="Graphify"], [data-slot="aui_thread-viewport"]',
    note: 'chat ⇄ graphify view swap'
  },
  'close-modal': {
    open: '[data-statusbar-item="command-center"]',
    click: '[data-slot="dialog-close-button"], [data-view-close], button[aria-label*="lose"]',
    expect: '[data-slot="dialog-content"], [data-slot="command-center"]',
    note: 'close the command center overlay with its X'
  },
  'switch-session': {
    click: '[data-sidebar-session][data-session-active="false"]',
    expect: '[data-slot="aui_thread-viewport"]',
    note: 'sidebar row → transcript'
  },
  idle: {
    click: null,
    expect: null,
    note: 'baseline: rAF churn while nothing happens'
  }
}

// ── CDP plumbing (same shape as scripts/measure-latency.mjs) ─────────────────

const log = (...m) => console.log('[interactions]', ...m)

async function pickRenderer() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()

  return list.find(t => t.type === 'page' && t.url.startsWith('http'))
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()

    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const myId = ++id
          ws.send(JSON.stringify({ id: myId, method, params }))

          return new Promise((res, rej) => pending.set(myId, { rej, res }))
        },
        close: () => ws.close()
      })
    )
    ws.addEventListener('error', reject)
    ws.addEventListener('message', ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8'))

      if (m.id == null) return
      const p = pending.get(m.id)

      if (!p) return
      pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
    })
  })
}

async function evalInPage(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { awaitPromise: true, expression, returnByValue: true })

  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)

  return r.result.value
}

// Installs a one-shot observer before the click so t1 is measured from the same
// clock as t0 (no round-trip added to the latency).
function armObserver(caseDef) {
  return `(() => {
    window.__aliceInteraction = { t0: null, t1: null, t2: null, longTasks: [], observer: null, raf: 0 }
    const state = window.__aliceInteraction

    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) state.longTasks.push(Math.round(entry.duration))
      }).observe({ entryTypes: ['longtask'] })
    } catch {}

    const mark = () => {
      if (state.t1 !== null) return
      state.t1 = performance.now()
      state.raf = requestAnimationFrame(() => {
        state.t2 = performance.now()
        state.observer?.disconnect()
      })
    }

    const target = ${JSON.stringify(caseDef.expect)}

    if (!target) return true

    const matches = node => {
      if (!(node instanceof Element)) return false
      if (node.matches(target)) return true
      return Boolean(node.querySelector?.(target))
    }

    state.observer = new MutationObserver(records => {
      for (const record of records) {
        if (matches(record.target)) { mark(); return }
        for (const node of record.addedNodes) {
          if (matches(node)) { mark(); return }
        }
        for (const node of record.removedNodes) {
          if (matches(node)) { mark(); return }
        }
      }
    })

    state.observer.observe(document.body, {
      attributes: true,
      attributeFilter: ${JSON.stringify(caseDef.attribute ? [caseDef.attribute] : undefined)},
      childList: true,
      subtree: true
    })

    return true
  })()`
}

async function readSample(cdp) {
  return evalInPage(
    cdp,
    `(() => {
      const s = window.__aliceInteraction
      if (!s || s.t1 === null) return null
      return { t0: s.t0, t1: s.t1, t2: s.t2, longTasks: s.longTasks }
    })()`
  )
}

async function clickSelector(cdp, selector) {
  const box = await evalInPage(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`
  )

  if (!box) return false

  await evalInPage(cdp, 'window.__aliceInteraction.t0 = performance.now()')
  await cdp.send('Input.dispatchMouseEvent', { button: 'left', clickCount: 1, type: 'mousePressed', x: box.x, y: box.y })
  await cdp.send('Input.dispatchMouseEvent', { button: 'left', clickCount: 1, type: 'mouseReleased', x: box.x, y: box.y })

  return true
}

async function runCase(cdp, name, def, reps) {
  if (!def.click) {
    // Idle baseline: observe rAF churn for one second.
    return evalInPage(
      cdp,
      `(() => new Promise(resolve => {
        let frames = 0
        const start = performance.now()
        const tick = () => {
          frames++
          if (performance.now() - start < 1000) requestAnimationFrame(tick)
          else resolve({ frames, rafPerSecond: frames })
        }
        requestAnimationFrame(tick)
      }))()`
    ).then(result => ({ case: name, idle: result, samples: [], summary: null }))
  }

  const samples = []
  let skipped = false

  for (let i = 0; i < reps; i++) {
    if (def.open && i === 0) {
      await clickSelector(cdp, def.open)
      await new Promise(r => setTimeout(r, 400))
    }

    await evalInPage(cdp, armObserver(def))

    const clicked = await clickSelector(cdp, def.click)

    if (!clicked) {
      skipped = true
      await evalInPage(cdp, 'window.__aliceInteraction?.observer?.disconnect()')
      break
    }

    // Wait up to 1.5s for the observable mutation.
    let sample = null

    for (let waited = 0; waited < 30; waited++) {
      await new Promise(r => setTimeout(r, 50))
      sample = await readSample(cdp)

      if (sample) break
    }

    await evalInPage(cdp, 'window.__aliceInteraction?.observer?.disconnect()')

    if (!sample) {
      skipped = true
      break
    }

    samples.push({
      commit: Number((sample.t1 - sample.t0).toFixed(2)),
      longTasks: sample.longTasks,
      paint: sample.t2 === null ? null : Number((sample.t2 - sample.t0).toFixed(2))
    })

    await new Promise(r => setTimeout(r, 300))
  }

  if (skipped) {
    return { case: name, note: def.note, samples: [], skipped: true, summary: null }
  }

  const longTasks = samples.flatMap(s => s.longTasks)

  return {
    case: name,
    note: def.note,
    samples,
    summary: {
      commit: summarize(samples.map(s => s.commit)),
      paint: summarize(samples.filter(s => s.paint !== null).map(s => s.paint)),
      longTasks: { max: longTasks.length ? Math.max(...longTasks) : 0, count: longTasks.length }
    }
  }
}

// ── self-test (no Electron) ──────────────────────────────────────────────────

function selfTest() {
  const stats = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const expected = { max: 10, min: 1, n: 10, p50: 6, p95: 10 }
  const ordered = { max: stats.max, min: stats.min, n: stats.n, p50: stats.p50, p95: stats.p95 }
  const ok = JSON.stringify(ordered) === JSON.stringify(expected)

  const empty = summarize([])
  const emptyOk = empty.n === 0 && empty.p50 === null && empty.max === null

  const names = Object.keys(CASES)
  const casesOk = names.includes('idle') && names.every(n => typeof CASES[n].note === 'string')

  const selectorOk = Object.values(CASES).every(c => c.click === null || typeof c.click === 'string')

  const fromSamples = baselineFrom({ samples: [{ ms: 10, name: 'a' }, { ms: 30, name: 'a' }] })
  const fromResults = baselineFrom({ results: [{ case: 'b', summary: { paint: { p95: 42 } } }] })
  const fromMap = baselineFrom({ c: 7, d: { p95: 9 } })
  const baselineOk = fromSamples.a === 30 && fromResults.b === 42 && fromMap.c === 7 && fromMap.d === 9

  const compared = compareToBaseline({ a: 20, b: 100, c: 5 }, { a: 10, b: 100 })
  const compareOk =
    compared.find(row => row.case === 'a')?.regressed === true &&
    compared.find(row => row.case === 'b')?.regressed === false &&
    compared.find(row => row.case === 'c')?.baseline === null

  if (!ok || !emptyOk || !casesOk || !selectorOk || !baselineOk || !compareOk) {
    console.error('✖ self-test failed', {
      baselineOk,
      casesOk,
      compareOk,
      empty,
      emptyOk,
      ok,
      selectorOk,
      stats
    })
    process.exit(1)
  }

  console.log(`✔ self-test ok — ${names.length} cases: ${names.join(', ')}`)
}

if (args['self-test']) {
  selfTest()
  process.exit(0)
}

// ── main ─────────────────────────────────────────────────────────────────────

async function importMode() {
  const { readFileSync } = await import('node:fs')

  const current = baselineFrom(JSON.parse(readFileSync(String(args.import), 'utf8')))

  if (typeof args.baseline === 'string') {
    const raw = JSON.parse(readFileSync(args.baseline, 'utf8'))
    const baseline = baselineFrom(raw)

    if (Object.keys(baseline).length === 0) {
      // Honest "unmeasured" baseline: capture on Wails (`wails dev` → Settings →
      // About → Copy JSON) before this can gate anything.
      console.log('▸ baseline has no measurements yet — capture one with wails dev')
      console.log('✔ nothing to compare (non-blocking)')

      return
    }

    if (raw?.meta) {
      const missing = ['captured_at', 'commit', 'machine'].filter(key => !raw.meta[key])

      if (missing.length) {
        console.warn(`⚠ baseline meta is incomplete (missing: ${missing.join(', ')})`)
      }
    }

    const rows = compareToBaseline(current, baseline)

    for (const row of rows) {
      const delta = row.deltaPct === null ? 'n/a' : `${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}%`
      console.log(
        `  ${row.case.padEnd(20)} p95=${row.current}ms baseline=${row.baseline ?? '—'} Δ=${delta}${
          row.regressed ? '  ✖ regression' : ''
        }`
      )
    }

    const regressed = rows.filter(row => row.regressed)

    if (regressed.length) {
      console.error(`✖ ${regressed.length} interaction(s) regressed by more than ${40}%`)
      process.exit(1)
    }

    console.log('✔ no interaction regressed')

    return
  }

  for (const [name, p95] of Object.entries(current)) {
    console.log(`  ${name.padEnd(20)} p95=${p95}ms`)
  }
}

async function main() {
  if (typeof args.import === 'string') {
    await importMode()

    return
  }

  const selected = CASE === 'all' ? Object.keys(CASES) : CASE.split(',')

  for (const name of selected) {
    if (!CASES[name]) {
      console.error(`✖ unknown case "${name}" (known: ${Object.keys(CASES).join(', ')})`)
      process.exit(2)
    }
  }

  const target = await pickRenderer()

  if (!target) {
    console.error(`✖ no renderer page on CDP port ${PORT} (run: npm run profile:main)`)
    process.exit(2)
  }

  log(`target ${target.url}`)
  const cdp = await connect(target.webSocketDebuggerUrl)

  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const results = []

  for (const name of selected) {
    log(`case ${name}…`)
    results.push(await runCase(cdp, name, CASES[name], REPS))
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(
    OUT,
    JSON.stringify({ at: new Date().toISOString(), port: PORT, reps: REPS, results }, null, 2)
  )

  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.case.padEnd(16)} skipped (selector not found)`)
      continue
    }

    if (r.idle) {
      console.log(`  ${r.case.padEnd(16)} rafPerSecond=${r.idle.rafPerSecond}`)
      continue
    }

    console.log(
      `  ${r.case.padEnd(16)} commit p50=${r.summary.commit.p50}ms p95=${r.summary.commit.p95}ms ` +
        `| paint p95=${r.summary.paint.p95}ms | longTask max=${r.summary.longTasks.max}ms (${r.summary.longTasks.count})`
    )
  }

  console.log(`\n▸ ${OUT}`)
  cdp.close()
}

main().catch(e => {
  console.error('[interactions] fatal:', e.stack ?? e.message)
  process.exit(1)
})
