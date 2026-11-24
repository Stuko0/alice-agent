// @vitest-environment jsdom
// Test the chat-view state machine added for the chat⇄graphify toggle. The
// atom itself is a single value, but the public functions must flip the
// value predictably and the toggle must be symmetric.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $chatView, chatViewAfterSessionChange, setChatView, toggleChatView, type ChatView } from './graphify'

describe('$chatView', () => {
  beforeEach(() => {
    $chatView.set('chat')
  })
  afterEach(() => {
    $chatView.set('chat')
  })

  it('starts in chat mode', () => {
    expect($chatView.get()).toBe<ChatView>('chat')
  })

  it('setChatView("graph") flips to graph mode', () => {
    setChatView('graph')
    expect($chatView.get()).toBe<ChatView>('graph')
  })

  it('toggleChatView flips chat → graph → chat', () => {
    expect($chatView.get()).toBe('chat')
    toggleChatView()
    expect($chatView.get()).toBe('graph')
    toggleChatView()
    expect($chatView.get()).toBe('chat')
  })

  it('setChatView("chat") is a no-op when already chat', () => {
    setChatView('chat')
    expect($chatView.get()).toBe('chat')
  })

  it('subscribers see updates', () => {
    const seen: ChatView[] = []
    const unsub = $chatView.subscribe(value => {
      seen.push(value)
    })
    setChatView('graph')
    toggleChatView()
    unsub()
    expect(seen).toEqual(['chat', 'graph', 'chat'])
  })
})

describe('chatViewAfterSessionChange', () => {
  it('keeps graph while a resume resolves null -> runtime id', () => {
    // Regression: opening graph during a resume used to bounce back to chat the
    // moment the runtime id landed, because null->id looked like a switch.
    expect(chatViewAfterSessionChange('graph', null, 'rt-1')).toBe('graph')
  })

  it('keeps graph when the session id did not change', () => {
    expect(chatViewAfterSessionChange('graph', 'rt-1', 'rt-1')).toBe('graph')
  })

  it('flips to chat on a genuine switch between loaded sessions', () => {
    expect(chatViewAfterSessionChange('graph', 'rt-1', 'rt-2')).toBe('chat')
  })

  it('leaves chat mode alone in every case', () => {
    expect(chatViewAfterSessionChange('chat', 'rt-1', 'rt-2')).toBe('chat')
    expect(chatViewAfterSessionChange('chat', null, 'rt-1')).toBe('chat')
  })
})
