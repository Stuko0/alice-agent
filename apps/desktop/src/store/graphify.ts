import { atom } from 'nanostores'

import { startInteraction } from '@/lib/interaction-telemetry'

// Chat-shell view mode. The user can swap the main thread view for the
// session's graphify HTML, rendered full-size in the chat area. When the user
// navigates to a different session, we auto-flip back to 'chat' so they don't
// end up looking at a stale graph.
export type ChatView = 'chat' | 'graph'
export const $chatView = atom<ChatView>('chat')

export function setChatView(view: ChatView): void {
  $chatView.set(view)
}

export function toggleChatView(): void {
  const stopTiming = startInteraction('toggle-graph')

  $chatView.set($chatView.get() === 'chat' ? 'graph' : 'chat')
  stopTiming({ paint: true })
}

/**
 * Which view survives a session change. Only a switch between two ALREADY
 * loaded sessions invalidates the graph (it belongs to the previous session's
 * cwd). A resume publishes `null → runtimeId`, which is not a switch — flipping
 * on it threw the user out of the graph while the chat was still loading.
 */
export function chatViewAfterSessionChange(
  view: ChatView,
  previousSessionId: null | string,
  nextSessionId: null | string
): ChatView {
  if (view !== 'graph' || previousSessionId === null || nextSessionId === null) {
    return view
  }

  return previousSessionId === nextSessionId ? view : 'chat'
}
