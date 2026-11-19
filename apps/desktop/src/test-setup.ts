import { beforeEach } from 'vitest'

// jsdom does not implement CSS.escape, which the thread timeline uses to build
// `[data-message-id="…"]` selectors. Without it any render of the timeline in a
// test throws "Cannot read properties of undefined (reading 'escape')" — that
// surfaced as four `block-direction` failures and two `user-message-edit`
// failures that had nothing to do with the code under test.
if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
  const escape = (value: string) =>
    String(value).replace(/([^\w-])/g, character => `\\${character}`)

  if (typeof CSS === 'undefined') {
     
    ;(globalThis as { CSS?: { escape: (value: string) => string } }).CSS = { escape }
  } else {
    CSS.escape = escape
  }
}

// jsdom has no ResizeObserver. Components that measure themselves (the terminal
// overlay, the thread timeline) must not crash when a test renders them.
if (typeof ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  }

  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
}

// Radix + the shell's responsive hooks query media lists on mount.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      addEventListener: () => undefined,
      addListener: () => undefined,
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => undefined,
      removeListener: () => undefined
    }) as unknown as MediaQueryList
}

// Persisted UI state must not leak between tests (module-global atoms are
// isolated per file by vitest, but localStorage is shared by the whole worker).
// Tests that seed a key in their own beforeEach still win: this runs first.
beforeEach(() => {
  try {
    window.localStorage.clear()
  } catch {
    // Restricted storage: nothing to reset.
  }
})
