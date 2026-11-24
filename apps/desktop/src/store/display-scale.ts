/**
 * Display scale — the desktop's own zoom.
 *
 * Browsers expose 100/125/150 via ⌘+/⌘-, but the Wails shell has no such
 * shortcut and the OS scale changes the whole session, not this window. One
 * lever, applied with CSS `zoom` on <html> (supported by WebKitGTK and
 * Chromium), gives the same result: every surface — shell, transcript,
 * drawers, overlays — scales together, and the layout reflows as if the window
 * were smaller, which is exactly what a magnified UI needs.
 */

import { persistentAtom } from '@/lib/persisted'
import { persistedKey } from '@/lib/persisted-keys'

export const DISPLAY_SCALES = [1, 1.15, 1.25, 1.5] as const

export type DisplayScale = (typeof DISPLAY_SCALES)[number]

const KEY = persistedKey('displayScale')

function normalize(value: number): DisplayScale {
  return (DISPLAY_SCALES.find(scale => Math.abs(scale - value) < 0.001) ?? 1) as DisplayScale
}

export const $displayScale = persistentAtom<DisplayScale>(KEY, 1, {
  decode: raw => normalize(Number(raw)),
  encode: value => String(value)
})

function apply(scale: DisplayScale): void {
  if (typeof document === 'undefined') {
    return
  }

  const root = document.documentElement

  if (scale === 1) {
    root.style.removeProperty('zoom')
    root.style.removeProperty('--display-scale')
    delete root.dataset.displayScale

    return
  }

  root.style.zoom = String(scale)
  root.style.setProperty('--display-scale', String(scale))
  root.dataset.displayScale = String(scale)
}

export function setDisplayScale(scale: number): void {
  $displayScale.set(normalize(scale))
}

if (typeof window !== 'undefined') {
  // Zoom before the first React commit so the shell paints at its final size.
  apply($displayScale.get())
  $displayScale.subscribe(apply)
}
