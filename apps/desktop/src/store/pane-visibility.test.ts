import { atom } from 'nanostores'
import { beforeEach, describe, expect, it } from 'vitest'

import { $paneOpen, $paneStates, bindPaneGate, ensurePaneRegistered, setPaneOpen, togglePane } from './panes'

describe('bindPaneGate', () => {
  beforeEach(() => {
    $paneStates.set({})
  })

  it('reflects the gate in the pane store and vice versa', () => {
    // Stand-in for $reviewOpen / $browserTabsOpen / $terminalTakeover.
    const gate = atom(false)

    bindPaneGate('gated-pane', gate)

    expect($paneOpen('gated-pane').get()).toBe(false)

    gate.set(true)
    expect($paneOpen('gated-pane').get()).toBe(true)

    gate.set(false)
    expect($paneOpen('gated-pane').get()).toBe(false)
  })

  it('keeps togglePane working for gated panes', () => {
    const gate = atom(false)

    bindPaneGate('gated-toggle', gate)

    togglePane('gated-toggle')
    expect(gate.get()).toBe(true)
    expect($paneOpen('gated-toggle').get()).toBe(true)

    setPaneOpen('gated-toggle', false)
    expect(gate.get()).toBe(false)
  })
})

describe('bindPaneGate reconciliation', () => {
  it('overwrites a stale persisted open flag with the live gate', () => {
    // Reproduces the boot state: localStorage said open:true for review/browser/
    // terminal, while the gate atoms were false. Registering-if-missing left the
    // contradiction in place.
    $paneStates.set({})
    ensurePaneRegistered('stale-pane', { open: true })

    const gate = atom(false)

    bindPaneGate('stale-pane', gate)

    expect($paneOpen('stale-pane').get()).toBe(false)
    expect($paneStates.get()['stale-pane']?.open).toBe(false)
  })
})
