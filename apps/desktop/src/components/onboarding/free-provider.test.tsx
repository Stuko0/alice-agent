import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OnboardingContext } from '@/store/onboarding'

import { FreeProviderRow } from './free-provider'

const ctx = { onCompleted: vi.fn(), requestGateway: async () => undefined as never } as OnboardingContext

function mockApi(handler: (req: { path: string }) => Promise<unknown>) {
  ;(window as any).aliceDesktop = { api: handler }
}

afterEach(() => {
  cleanup()
  delete (window as any).aliceDesktop
  ctx.onCompleted = vi.fn()
})

describe('FreeProviderRow', () => {
  it('configures the keyless endpoint and finishes onboarding', async () => {
    const api = vi.fn(async (_req: { path: string }) => ({
      configured: true,
      id: 'pollinations',
      model: 'openai-fast'
    }))

    mockApi(api)

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(ctx.onCompleted).toHaveBeenCalled())

    // One request: the backend probes and writes the config. No polling.
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0][0].path).toBe('/api/setup/free-endpoint')
  })

  it('shows the backend detail when the probe fails', async () => {
    mockApi(async () => {
      throw new Error(
        'API /api/setup/free-endpoint failed: 502 The free endpoint is rate-limiting anonymous requests right now.'
      )
    })

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(screen.getByText(/rate-limiting anonymous requests/)).toBeTruthy())

    expect(ctx.onCompleted).not.toHaveBeenCalled()
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  it('treats an unconfigured response as a failure', async () => {
    mockApi(async () => ({ configured: false }))

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(screen.getByText(/did not answer/)).toBeTruthy())
    expect(ctx.onCompleted).not.toHaveBeenCalled()
  })
})
