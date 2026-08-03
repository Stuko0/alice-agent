import { atom } from 'nanostores'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'

export const GRAPHIFY_PANE_ID = 'graphify'
const OPEN_KEY = 'alice.desktop.graphifyOpen'

// Persisted so the pane stays open across reloads
export const $graphifyOpen = persistentAtom(OPEN_KEY, false, Codecs.bool)

export function toggleGraphify(): void {
  const current = $graphifyOpen.get()
  $graphifyOpen.set(!current)
  if (!current) {
    window.dispatchEvent(new CustomEvent(PANE_TOGGLE_REVEAL_EVENT, { detail: { id: GRAPHIFY_PANE_ID } }))
  }
}

export function closeGraphify(): void {
  $graphifyOpen.set(false)
}

// Chat-shell view mode. The user can swap the main thread view for the
// session's graphify HTML (the same content the right-rail graphify pane
// loads as an iframe, but rendered full-size in the chat area). When the
// user navigates to a different session, we auto-flip back to 'chat' so
// they don't end up looking at a stale graph.
export type ChatView = 'chat' | 'graph'
export const $chatView = atom<ChatView>('chat')

export function setChatView(view: ChatView): void {
  $chatView.set(view)
}

export function toggleChatView(): void {
  $chatView.set($chatView.get() === 'chat' ? 'graph' : 'chat')
}
