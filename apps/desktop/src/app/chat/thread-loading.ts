
export type ThreadLoadingState = 'response' | 'session'

// Moved to lib/ for D2 (store/session.ts uses it in a `computed`); re-exported
// here for existing call sites.
export { lastVisibleMessageIsUser } from '@/lib/chat-messages'

export function threadLoadingState(
  loadingSession: boolean,
  busy: boolean,
  awaitingResponse: boolean,
  lastVisibleIsUser: boolean
): ThreadLoadingState | undefined {
  if (loadingSession) {
    return 'session'
  }

  if (busy && awaitingResponse && lastVisibleIsUser) {
    return 'response'
  }

  return undefined
}
