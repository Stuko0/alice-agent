import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $previewTabUrl,
  $previewTarget,
  clearSessionPreviewRegistry,
  type PreviewTarget,
  registerSessionPreview
} from '@/store/preview'
import type { RpcEvent } from '@/types/alice'

import { usePreviewRouting } from './use-preview-routing'

function urlTarget(url: string): PreviewTarget {
  return { kind: 'url', label: url, source: url, url }
}

let handleEvent: (event: RpcEvent) => void = () => undefined

function PreviewRoutingHarness({ onEvent }: { onEvent: (handler: (event: RpcEvent) => void) => void }) {
  const activeSessionIdRef = useRef<string | null>('session-1')

  const routing = usePreviewRouting({
    activeSessionIdRef,
    baseHandleGatewayEvent: vi.fn()
  })

  useEffect(() => {
    onEvent(routing.handleDesktopGatewayEvent)
  }, [onEvent, routing.handleDesktopGatewayEvent])

  return null
}

function renderHarness() {
  render(
    <PreviewRoutingHarness
      onEvent={handler => {
        handleEvent = handler
      }}
    />
  )
}

describe('usePreviewRouting', () => {
  const navigate = vi.fn(async () => true)

  beforeEach(() => {
    $previewTarget.set(null)
    $previewTabUrl.set(null)
    window.localStorage.clear()
    clearSessionPreviewRegistry()
    handleEvent = () => undefined
    navigate.mockClear()

    Object.defineProperty(window, 'aliceDesktop', {
      configurable: true,
      value: { browser: { navigate } }
    })
  })

  afterEach(() => {
    cleanup()
    $previewTarget.set(null)
    $previewTabUrl.set(null)
    window.localStorage.clear()
    clearSessionPreviewRegistry()
    vi.restoreAllMocks()
  })

  it('does not restore a registered preview into a pane on boot', () => {
    registerSessionPreview('session-1', urlTarget('http://localhost:5173/'), 'tool-result')

    renderHarness()

    // The rail that used to restore itself is gone; previews only appear when
    // the user (or an explicit open) asks for one.
    expect($previewTarget.get()).toBeNull()
  })

  it('does not auto-open a preview from tool results', () => {
    renderHarness()

    act(() =>
      handleEvent({
        payload: { inline_diff: '\u001b[38;2;218;165;32ma/preview-demo.html -> b/preview-demo.html\u001b[0m\n' },
        session_id: 'session-1',
        type: 'tool.complete'
      })
    )
    act(() => handleEvent({ payload: { path: './dist/index.html' }, session_id: 'session-1', type: 'tool.complete' }))

    expect($previewTarget.get()).toBeNull()
    expect(window.localStorage.getItem('alice.desktop.sessionPreviews.v1')).toBeNull()
  })

  it('reloads the preview tab when the agent rewrites the served artifact', () => {
    $previewTarget.set(urlTarget('http://localhost:5173/'))
    $previewTabUrl.set('http://localhost:5173/')

    renderHarness()

    act(() =>
      handleEvent({
        payload: { inline_diff: '\u001b[38;2;218;165;32ma/index.html -> b/index.html\u001b[0m\n' },
        session_id: 'session-1',
        type: 'tool.complete'
      })
    )

    expect(navigate).toHaveBeenCalledWith('http://localhost:5173/')
  })

  it('ignores file diffs while no url preview is open', () => {
    renderHarness()

    act(() =>
      handleEvent({
        payload: { inline_diff: '\u001b[38;2;218;165;32ma/index.html -> b/index.html\u001b[0m\n' },
        session_id: 'session-1',
        type: 'tool.complete'
      })
    )

    expect(navigate).not.toHaveBeenCalled()
  })
})
