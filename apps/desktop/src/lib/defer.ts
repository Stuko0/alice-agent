// Run non-critical follow-up work after the urgent commit.
//
// `startTransition` does not help here: the stores are nanostores atoms, and
// their subscribers re-render outside React's transition lane. An idle callback
// (with a timeout so it always runs) keeps the work off the interaction path
// without changing ordering guarantees for anything the user is waiting on.
export function deferToIdle(fn: () => void, timeoutMs = 500): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown })
    .requestIdleCallback

  if (typeof idle === 'function') {
    idle(fn, { timeout: timeoutMs })

    return
  }

  setTimeout(fn, 0)
}
