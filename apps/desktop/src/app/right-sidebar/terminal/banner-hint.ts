/**
 * One-time "the shell banner doesn't fit" offer.
 *
 * A shell that prints a fixed-width ASCII banner (fastfetch/neofetch with a
 * pinned `logo.width`) overflows a narrow terminal drawer: the art and the info
 * column collide. We can't reflow the user's config from here, but we can offer
 * a one-click `clear`. Never automatic — clearing would throw away real history.
 */

import { atom } from 'nanostores'

const SEEN_KEY = 'alice.desktop.terminal-banner-hint.v1'

export interface BannerHint {
  sessionId: string
  terminalId: string
}

export const $terminalBannerHint = atom<BannerHint | null>(null)

function alreadySeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Storage unavailable: the offer may repeat next launch.
  }
}

/** Called with the first output chunk of a freshly started shell. */
export function maybeOfferBannerHint(input: {
  cols: number
  data: string
  sessionId: string
  terminalId: string
}): void {
  if (alreadySeen() || input.cols >= 100) {
    return
  }

  // Box-drawing / block / braille glyphs only show up in art, not in a normal
  // prompt or command output. 40+ of them in the first chunk means a banner.
  const artGlyphs = input.data.match(/[\u2500-\u259f\u2800-\u28ff]/g)?.length ?? 0

  if (artGlyphs < 40) {
    return
  }

  $terminalBannerHint.set({ sessionId: input.sessionId, terminalId: input.terminalId })
  markSeen()
}

export function dismissBannerHint(): void {
  $terminalBannerHint.set(null)
  markSeen()
}
