import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $browserOpen, setBrowserOpen } from '@/store/browser'
import { $activeBrowserTabId, $browserTabs, $browserUnread, clearBrowserTabs } from '@/store/browser-tabs'
import type { RpcEvent } from '@/types/alice'

import { useGatewayEventHandler } from './gateway-event'

// Contract: a page the AGENT opens must never take over the window. It lands
// as a tab plus a badge on the browser suit; the user decides when to open it.
function Harness({ onReady }: { onReady: (handler: (event: RpcEvent) => void) => void }) {
  const handler = useGatewayEventHandler({
    activeSessionIdRef: { current: 's1' },
    compactedTurnRef: { current: new Set<string>() },
    lastCwdInfoSessionRef: { current: null },
    nativeSubagentSessionsRef: { current: new Set<string>() },
    appendAssistantDelta: vi.fn(),
    appendReasoningDelta: vi.fn(),
    completeAssistantMessage: vi.fn(),
    failAssistantMessage: vi.fn(),
    flushQueuedDeltas: vi.fn(),
    queryClient: { invalidateQueries: vi.fn() } as never,
    refreshAliceConfig: vi.fn(async () => {}),
    sessionInterrupted: () => false,
    updateSessionState: state => state as never,
    upsertToolCall: vi.fn()
  })

  onReady(handler)

  return null
}

describe('gateway browser_navigate event', () => {
  beforeEach(() => {
    clearBrowserTabs()
    $browserUnread.set(0)
    setBrowserOpen(false)
  })

  it('badges the suit instead of opening the pane', () => {
    let handler: ((event: RpcEvent) => void) | null = null

    render(<Harness onReady={next => (handler = next)} />)

    act(() => {
      handler?.({
        session_id: 's1',
        type: 'tool.start',
        payload: { args: { url: 'https://agent.example/page' }, name: 'browser_navigate' }
      } as RpcEvent)
    })

    expect($browserTabs.get().map(tab => tab.url)).toEqual(['https://agent.example/page'])
    expect($browserUnread.get()).toBe(1)
    expect($browserOpen.get()).toBe(false)
    expect($activeBrowserTabId.get()).toBeNull()
  })

  it('does not badge while the pane is already open', () => {
    let handler: ((event: RpcEvent) => void) | null = null

    setBrowserOpen(true)
    render(<Harness onReady={next => (handler = next)} />)

    act(() => {
      handler?.({
        session_id: 's1',
        type: 'tool.start',
        payload: { args: { url: 'https://agent.example/page' }, name: 'browser_navigate' }
      } as RpcEvent)
    })

    expect($browserTabs.get()).toHaveLength(1)
    expect($browserUnread.get()).toBe(0)
  })
})
