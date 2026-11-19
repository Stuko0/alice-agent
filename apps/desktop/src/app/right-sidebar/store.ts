import { atom, computed } from 'nanostores'

import { startInteraction } from '@/lib/interaction-telemetry'
import { persistedKey } from '@/lib/persisted-keys'
import { persistCoalesced, storedBoolean } from '@/lib/storage'
import { $fileBrowserOpen } from '@/store/layout'
import { bindPaneGate } from '@/store/panes'
import { $reviewOpen } from '@/store/review'

const TAKEOVER_KEY = persistedKey('terminalTakeover')
const BROWSER_OPEN_KEY = persistedKey('browserTabsOpen')

export const $terminalTakeover = atom(storedBoolean(TAKEOVER_KEY, false))
export const $browserTabsOpen = atom(storedBoolean(BROWSER_OPEN_KEY, false))

// Coalesced + `listen`: toggling a pane must not do synchronous storage work in
// the click commit, and subscribing at import rewrote both seeds on boot.
$terminalTakeover.listen(active => persistCoalesced(TAKEOVER_KEY, String(active)))
$browserTabsOpen.listen(open => persistCoalesced(BROWSER_OPEN_KEY, String(open)))

// One observable open state per pane (see bindPaneGate).
bindPaneGate('terminal-sidebar', $terminalTakeover)
bindPaneGate('browser-tabs', $browserTabsOpen)

export const setTerminalTakeover = (active: boolean) => {
  const stopTiming = startInteraction('toggle-terminal')

  $terminalTakeover.set(active)
  stopTiming({ paint: true })
}

export const setBrowserTabsOpen = (open: boolean) => {
  const stopTiming = startInteraction('toggle-browser')

  $browserTabsOpen.set(open)
  stopTiming({ paint: true })
}

// The terminal moves to a full-width row once any other rail pane is docked,
// so the rail never over-subscribes into a sliver. An atom (not a controller
// derivation) so `<Pane bottomRowAtom>` can follow it without the shell root
// re-rendering on every toggle.
export const $terminalAsRow = computed(
  [$terminalTakeover, $fileBrowserOpen, $reviewOpen, $browserTabsOpen],
  (takeover, files, review, browser) => takeover && (files || review || browser)
)

/** A command queued to run in the embedded terminal. The terminal pane flushes
 *  (and clears) it once its session is live, so a value set before the pane
 *  mounts still runs. Cleared after flush so a later remount can't replay it. */
export const $terminalInjection = atom<null | string>(null)

/** Open the terminal pane and run a command in it. Used to disconnect external
 *  (CLI-managed) providers, which Alice can't clear via the API — the user
 *  sees exactly what runs instead of Alice silently deleting their creds. */
export const runInTerminal = (command: string) => {
  const trimmed = command.trim()

  if (!trimmed) {
    return
  }

  setTerminalTakeover(true)
  $terminalInjection.set(trimmed)
}
