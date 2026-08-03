import { atom } from 'nanostores'

import { persistBoolean, storedBoolean } from '@/lib/storage'

const TAKEOVER_KEY = 'alice.desktop.terminalTakeover'
const BROWSER_OPEN_KEY = 'alice.desktop.browserTabsOpen'

export const $terminalTakeover = atom(storedBoolean(TAKEOVER_KEY, false))
export const $browserTabsOpen = atom(storedBoolean(BROWSER_OPEN_KEY, false))

$terminalTakeover.subscribe(active => persistBoolean(TAKEOVER_KEY, active))
$browserTabsOpen.subscribe(open => persistBoolean(BROWSER_OPEN_KEY, open))

export const setTerminalTakeover = (active: boolean) => $terminalTakeover.set(active)
export const setBrowserTabsOpen = (open: boolean) => $browserTabsOpen.set(open)

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
