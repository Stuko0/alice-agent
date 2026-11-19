import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getMessageReasoning, getSessionMessages, listAllProfileSessions, listSessions } from './alice'

const emptySessionsResponse = {
  limit: 0,
  offset: 0,
  sessions: [],
  total: 0
}

describe('Alice REST session helpers', () => {
  let api: ReturnType<typeof vi.fn>

  beforeEach(() => {
    api = vi.fn().mockResolvedValue(emptySessionsResponse)
    Object.defineProperty(window, 'aliceDesktop', {
      configurable: true,
      value: { api }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'aliceDesktop')
  })

  it('uses a longer timeout for the single-profile session list', async () => {
    await listSessions(50, 1)

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/sessions?limit=50&offset=0&min_messages=1&archived=exclude&order=recent',
        timeoutMs: 60_000
      })
    )
  })

  it('asks for a delta when a cursor is supplied', async () => {
    api.mockResolvedValueOnce({ last_id: 42, messages: [], session_id: 's1' })

    await getSessionMessages('s1', 'default', undefined, undefined, { sinceId: 41 })

    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/sessions/s1/messages?profile=default&since_id=41' }))
  })

  it('requests the untrimmed payload for exports', async () => {
    api.mockResolvedValueOnce({ messages: [], session_id: 's1' })

    await getSessionMessages('s1', 'default', undefined, undefined, { full: true })

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/sessions/s1/messages?profile=default&full=true' })
    )
  })

  it('fetches reasoning for the requested message ids only', async () => {
    api.mockResolvedValueOnce({ reasoning: { '42': 'because' } })

    const out = await getMessageReasoning('s1', [42], 'default')

    expect(out).toEqual({ '42': 'because' })
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/sessions/s1/reasoning?ids=42&profile=default' })
    )
  })

  it('includes reasoning when the technical view asks for it', async () => {
    api.mockResolvedValueOnce({ messages: [], session_id: 's1' })

    await getSessionMessages('s1', 'default', undefined, undefined, { reasoning: true })

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/sessions/s1/messages?profile=default&reasoning=true' })
    )
  })

  it('drops a transcript whose switch was superseded (AbortSignal)', async () => {
    const controller = new AbortController()

    api.mockResolvedValueOnce({ messages: [{ content: 'stale', role: 'user' }], total: 1 })
    controller.abort()

    await expect(getSessionMessages('s1', null, 200, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    // Aborted before it ever hit the bridge.
    expect(api).not.toHaveBeenCalled()
  })

  it('aborts a response that lands after the switch was superseded', async () => {
    const controller = new AbortController()
    let resolveApi: (value: unknown) => void = () => undefined

    api.mockReturnValueOnce(
      new Promise(resolve => {
        resolveApi = resolve
      })
    )

    const pending = getSessionMessages('s1', null, 200, controller.signal)

    controller.abort()
    resolveApi({ messages: [{ content: 'stale', role: 'user' }], total: 1 })

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses a longer timeout for the all-profile session list', async () => {
    await listAllProfileSessions(50, 1)

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/profiles/sessions?limit=50&offset=0&min_messages=1&archived=exclude&order=recent&profile=all',
        timeoutMs: 60_000
      })
    )
  })

  it('tags cross-profile message reads for Electron routing and backend lookup', async () => {
    api.mockResolvedValue({ messages: [], session_id: 'session-1' })

    await getSessionMessages('session-1', 'xiaoxuxu')

    expect(api).toHaveBeenCalledWith({
      path: '/api/sessions/session-1/messages?profile=xiaoxuxu',
      profile: 'xiaoxuxu'
    })
  })
})
