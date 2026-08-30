import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkAliceUpdate,
  getActionStatus,
  getStatus,
  restartGateway,
  setApiRequestProfile,
  updateAlice
} from './alice'

// Contract: every backend-targeted action helper must carry the active gateway
// profile, so a multi-profile / global-remote user's restart, status poll, and
// update hit the backend they're actually on — not the primary/default. The
// System-panel "restart does nothing" bug was these helpers dropping it.
describe('backend action helpers are profile-scoped', () => {
  const api = vi.fn(async (_req: { path: string; profile?: string }) => ({}) as never)

  beforeEach(() => {
    ;(window as { aliceDesktop?: unknown }).aliceDesktop = { api }
    api.mockClear()
  })

  afterEach(() => {
    setApiRequestProfile(null)
    delete (window as { aliceDesktop?: unknown }).aliceDesktop
  })

  const lastProfile = () => api.mock.calls.at(-1)?.[0].profile

  it('omits profile when none is active (single-profile users unaffected)', () => {
    void getStatus()
    expect(lastProfile()).toBeUndefined()
  })

  it('forwards the active profile to every backend action', () => {
    setApiRequestProfile('coder')

    void getStatus()
    void restartGateway()
    void updateAlice()
    void checkAliceUpdate()
    void getActionStatus('gateway-restart')

    for (const call of api.mock.calls) {
      expect(call[0].profile).toBe('coder')
    }
  })
})
