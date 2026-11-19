import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Phase 3 contract: the composition root composes, it does not subscribe to
// feature state. Every atom it reads re-renders the whole shell; keeping that
// list to session/route state is what makes panes and the statusbar independent
// "islands".
//
// If a new subscription is genuinely needed, move the component that uses it
// into its own host (see `StatusbarHost`, `OverlaysHost`, `RailPanes` design)
// instead of extending this allowlist.

const ROOT = import.meta.dirname
const CONTROLLER = join(ROOT, 'desktop-controller.tsx')

const source = readFileSync(CONTROLLER, 'utf8')

const FORBIDDEN_ATOMS = [
  '$reviewOpen',
  '$browserTabsOpen',
  '$terminalTakeover',
  '$terminalAsRow',
  '$previewTarget',
  '$previewTabOpen',
  '$paneOpen',
  '$fileBrowserOpen',
  '$chatView',
  '$messages',
  '$busy',
  '$currentUsage',
  '$subagentsBySession',
  '$keybindPanelOpen'
]

// `$panesFlipped` is deliberately NOT forbidden: it is a layout preference the
// panes need at collection time (`side`), it changes only on an explicit flip,
// and both the shell and the pane container already read it.

describe('composition root (Phase 3)', () => {
  it('does not subscribe to pane / statusbar / thread state', () => {
    const offenders = FORBIDDEN_ATOMS.filter(atom => new RegExp(`useStore\\(\\s*${atom.replace('$', '\\$')}`).test(source))

    expect(offenders).toEqual([])
  })

  it('passes declarative gates instead of computing pane visibility', () => {
    expect(source).toContain('openAtom={$reviewOpen}')
    expect(source).toContain('openAtom={$browserTabsOpen}')
    expect(source).toContain('openAtom={$terminalTakeover}')
    // The preview rail was absorbed by the browser drawer (Fase 3): its pane
    // and gate are gone, the browser's remains.
    expect(source).not.toContain('PREVIEW_PANE_ID')
    expect(source).toContain('bottomRowAtom={$terminalAsRow}')
  })

  it('delegates the running head, spine and overlays to their own hosts', () => {
    expect(source).not.toContain('useStatusbarItems(')
    expect(source).not.toContain('<StatusbarHost')
    expect(source).toContain('runningHead={runningHead}')
    expect(source).toContain('spine={spine}')
    expect(source).toContain('<OverlaysHost')
  })
})
