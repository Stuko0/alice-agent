/**
 * Native browser pane state.
 *
 * The page itself is a WebKitGTK view owned by the Go shell (see
 * `browser_service.go`); this store only carries what the React chrome paints
 * and what tells the native view when to show itself.
 */

import { atom } from 'nanostores'

export interface BrowserConsoleError {
  level: string
  line: number
  message: string
  source: string
}

export interface BrowserConsoleState {
  count: number
  last: BrowserConsoleError | null
}

export const $browserConsole = atom<BrowserConsoleState>({ count: 0, last: null })

export function recordBrowserConsoleError(error: BrowserConsoleError): void {
  const current = $browserConsole.get()

  $browserConsole.set({ count: current.count + 1, last: error })
}

export function clearBrowserConsoleErrors(): void {
  $browserConsole.set({ count: 0, last: null })
}

/** Shortcuts the native surface forwards to the renderer. */
export type BrowserShortcut = 'escape' | 'palette'

export interface BrowserState {
  /** The native view exists and accepts commands. */
  available: boolean
  loading: boolean
  ready: boolean
  title: string
  url: string
}

export const EMPTY_BROWSER_STATE: BrowserState = {
  available: true,
  loading: false,
  ready: false,
  title: '',
  url: ''
}

export const $browserState = atom<BrowserState>(EMPTY_BROWSER_STATE)
export const $browserOpen = atom(false)

/** URL painted in the chrome (input value, not necessarily loaded). */
export const $browserInput = atom('')

export function setBrowserState(next: Partial<BrowserState>): void {
  $browserState.set({ ...$browserState.get(), ...next })

  if (next.url !== undefined) {
    $browserInput.set(next.url)
  }
}

export function setBrowserOpen(open: boolean): void {
  $browserOpen.set(open)
}

export function toggleBrowser(): void {
  $browserOpen.set(!$browserOpen.get())
}
