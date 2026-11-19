import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $chatView } from '@/store/graphify'

import { ChatViewSwitch } from './chat-view-switch'

const graph = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

vi.mock('../shell/graphify-canvas', () => ({
  GraphifyCanvas: () => {
    useEffect(() => {
      graph.mounts += 1

      return () => {
        graph.unmounts += 1
      }
    }, [])

    return <div data-testid="graphify" />
  }
}))

const chat = { mounts: 0, unmounts: 0 }

function ChatBody() {
  return <div data-testid="chat-body" />
}

// Count mount/unmount of the chat subtree without relying on React internals.
function ChatBodyWithLifecycle() {
  useEffect(() => {
    chat.mounts += 1

    return () => {
      chat.unmounts += 1
    }
  }, [])

  return <ChatBody />
}

describe('ChatViewSwitch', () => {
  beforeEach(() => {
    graph.mounts = 0
    graph.unmounts = 0
    chat.mounts = 0
    chat.unmounts = 0
    $chatView.set('chat')
  })

  afterEach(() => {
    cleanup()
    $chatView.set('chat')
  })

  it('keeps the chat mounted across graph toggles', () => {
    render(
      <ChatViewSwitch activeSessionId="rt-1">
        <ChatBodyWithLifecycle />
      </ChatViewSwitch>
    )

    expect(chat.mounts).toBe(1)

    act(() => $chatView.set('graph'))
    act(() => $chatView.set('chat'))
    act(() => $chatView.set('graph'))

    expect(chat.unmounts).toBe(0)
    expect(chat.mounts).toBe(1)
  })

  it('mounts the canvas lazily and keeps it mounted afterwards', () => {
    render(
      <ChatViewSwitch activeSessionId="rt-1">
        <ChatBodyWithLifecycle />
      </ChatViewSwitch>
    )

    // Never opened → no iframe/document read.
    expect(graph.mounts).toBe(0)

    act(() => $chatView.set('graph'))
    expect(graph.mounts).toBe(1)

    act(() => $chatView.set('chat'))
    act(() => $chatView.set('graph'))

    // Still one mount: closing to chat must not throw the document away.
    expect(graph.mounts).toBe(1)
  })

  it('stays in graph while a resume resolves the session id', () => {
    const { rerender } = render(
      <ChatViewSwitch activeSessionId={null}>
        <ChatBody />
      </ChatViewSwitch>
    )

    act(() => $chatView.set('graph'))

    rerender(
      <ChatViewSwitch activeSessionId="rt-1">
        <ChatBody />
      </ChatViewSwitch>
    )

    expect($chatView.get()).toBe('graph')
  })

  it('returns to chat on a genuine session switch', () => {
    const { rerender } = render(
      <ChatViewSwitch activeSessionId="rt-1">
        <ChatBody />
      </ChatViewSwitch>
    )

    act(() => $chatView.set('graph'))

    rerender(
      <ChatViewSwitch activeSessionId="rt-2">
        <ChatBody />
      </ChatViewSwitch>
    )

    expect($chatView.get()).toBe('chat')
  })
})
