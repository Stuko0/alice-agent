/**
 * Reduced motion — one switch that quiets the whole renderer.
 *
 * The CSS already honours the OS setting (`@media (prefers-reduced-motion)`),
 * but a user can't ask for less motion on a machine whose desktop reports
 * "animations on", and QA can't exercise the reduced path without rebooting a
 * session manager. This atom mirrors the OS preference on first run and lets
 * the user override it from Settings → Appearance.
 *
 * Applied as `data-reduce-motion` on <html>; the stylesheet turns every
 * animation/transition into a single near-instant step under that attribute.
 */

import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

const KEY = 'alice.desktop.reduce-motion.v1'

function osPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

function read(): boolean {
  const stored = storedString(KEY)

  if (stored === 'true' || stored === 'false') {
    return stored === 'true'
  }

  return osPrefersReducedMotion()
}

export const $reduceMotion = atom<boolean>(typeof window === 'undefined' ? false : read())

function apply(reduce: boolean): void {
  if (typeof document === 'undefined') {
    return
  }

  document.documentElement.dataset.reduceMotion = reduce ? 'true' : 'false'
}

export function setReduceMotion(reduce: boolean): void {
  $reduceMotion.set(reduce)
}

if (typeof window !== 'undefined') {
  // Paint the attribute before the first React commit so nothing animates in.
  apply($reduceMotion.get())

  $reduceMotion.subscribe(reduce => {
    persistString(KEY, String(reduce))
    apply(reduce)
  })
}
