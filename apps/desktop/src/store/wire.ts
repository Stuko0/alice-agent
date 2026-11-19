import { wireCodingStatus } from './coding-status'
import { wireProfileRouting } from './profile'
import { wireReview } from './review'

let wired = false

/**
 * Start the store-level edge subscriptions (git/gh probes, profile routing).
 *
 * These used to run at module load, so merely importing a store could schedule
 * IPC: tests inherited live behaviour, boot ordering was implicit, and there was
 * no single place to see what reacts to what. `main.tsx` calls this once before
 * the first render; tests that assert the wiring call it explicitly.
 *
 * Idempotent, so a second call (StrictMode double-invoke, HMR, a test setup) is
 * a no-op instead of doubling every probe.
 */
export function wireStores(): void {
  if (wired) {
    return
  }

  wired = true

  wireProfileRouting()
  wireCodingStatus()
  wireReview()
}

/** Test-only: allow a file to re-wire after resetting modules. */
export function resetStoreWiringForTests(): void {
  wired = false
}
