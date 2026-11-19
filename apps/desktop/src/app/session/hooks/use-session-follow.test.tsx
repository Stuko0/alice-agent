import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $awaitingResponse, $busy, setMessages, setSessions } from '@/store/session'

import { useSessionFollow } from './use-session-follow'

const getSession = vi.fn()

vi.mock('@/alice', () => ({
  getSession: (id: string, profile?: null | string) => getSession(id, profile)
}))

function Harness({
  hydrate,
  hydrateTail,
  selected = 'stored-1',
  runtimeId = 'runtime-1',
  messages = 3,
  status = 'idle',
  requestGateway = vi.fn().mockResolvedValue({ sessions: [{ id: runtimeId, session_key: 'stored-1', status }] })
}: {
  hydrate: (attempts?: number, stored?: null | string, runtime?: null | string) => Promise<void>
  hydrateTail?: (stored: string, runtime: null | string) => Promise<void>
  selected?: null | string
  runtimeId?: null | string
  messages?: number
  status?: string
  requestGateway?: ReturnType<typeof vi.fn>
}) {
  const activeSessionIdRef = { current: runtimeId }
  const busyRef = { current: false }

  const sessionStateByRuntimeIdRef = {
    current: new Map([[runtimeId ?? 'runtime-1', { messages: Array.from({ length: messages }, (_, i) => ({ id: `m${i}` })) }]])
  }

  useSessionFollow({
    activeSessionIdRef,
    busyRef,
    hydrateFromStoredSession: hydrate,
    hydrateTail,
    requestGateway: requestGateway as never,
    sessionStateByRuntimeIdRef,
    selectedStoredSessionId: selected
  })

  return null
}

async function tick(ms = 2_000) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  getSession.mockReset()
  setSessions([{ id: 'stored-1', message_count: 5, profile: 'default' } as never])
  setMessages([])
  $busy.set(false)
  $awaitingResponse.set(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setSessions([])
})

describe('useSessionFollow', () => {
  it('re-hydrates when the stored session grew in another process', async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    getSession.mockResolvedValue({ id: 'stored-1', message_count: 9 })

    render(<Harness hydrate={hydrate} />)
    await tick()

    expect(getSession).toHaveBeenCalledWith('stored-1', 'default')
    expect(hydrate).toHaveBeenCalledWith(1, 'stored-1', 'runtime-1')
  })

  it('uses the delta tail fetch when the stored session grew', async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    const hydrateTail = vi.fn().mockResolvedValue(undefined)
    getSession.mockResolvedValue({ id: 'stored-1', message_count: 9 })

    render(<Harness hydrate={hydrate} hydrateTail={hydrateTail} />)
    await tick()

    expect(hydrateTail).toHaveBeenCalledWith('stored-1', 'runtime-1')
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('does nothing while the count is unchanged', async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    getSession.mockResolvedValue({ id: 'stored-1', message_count: 3 })

    render(<Harness hydrate={hydrate} messages={3} />)
    await tick()

    expect(hydrate).not.toHaveBeenCalled()
  })

  it('never shrinks the transcript on a smaller stored count', async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    getSession.mockResolvedValue({ id: 'stored-1', message_count: 1 })

    render(<Harness hydrate={hydrate} messages={5} />)
    await tick()

    expect(hydrate).not.toHaveBeenCalled()
  })

  it('steps aside while a live turn owns the view', async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    getSession.mockResolvedValue({ id: 'stored-1', message_count: 9 })
    $busy.set(true)

    render(<Harness hydrate={hydrate} status="running" />)
    await tick()

    expect(getSession).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('heals a stale busy flag when the backend reports the session idle', async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    getSession.mockResolvedValue({ id: 'stored-1', message_count: 9 })
    $busy.set(true)
    $awaitingResponse.set(true)

    render(<Harness hydrate={hydrate} status="idle" />)
    await tick()

    expect($busy.get()).toBe(false)
    expect($awaitingResponse.get()).toBe(false)
    expect(hydrate).toHaveBeenCalledWith(1, 'stored-1', 'runtime-1')
  })

  it('does not poll without a selected session', async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)

    render(<Harness hydrate={hydrate} selected={null} />)
    await tick()

    expect(getSession).not.toHaveBeenCalled()
  })
})
