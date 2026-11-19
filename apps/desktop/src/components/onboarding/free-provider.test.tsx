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
  it('completes the onboarding as soon as the gateway reports ready', async () => {
    const api = vi.fn(async () => ({ configured: true, progress: 100, state: 'ready' }))
    mockApi(api)

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(ctx.onCompleted).toHaveBeenCalled())

    // Ready on the POST itself: no status polling needed.
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('polls the status endpoint and shows the backend error text', async () => {
    const api = vi.fn(async (req: { path: string }) => {
      if (req.path.endsWith('/start')) {
        return { configured: false, progress: 5, state: 'starting', message: 'Downloading Node 22…' }
      }

      return { configured: false, error: 'omniroute: URLError: nodename nor servname provided', state: 'error' }
    })

    mockApi(api)

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(screen.getByText(/nodename nor servname/)).toBeTruthy(), { timeout: 5000 })

    expect(ctx.onCompleted).not.toHaveBeenCalled()
    expect(screen.getByText('Try again')).toBeTruthy()
  }, 10_000)

  it('surfaces the progress message while provisioning', async () => {
    let polls = 0

    const api = vi.fn(async (req: { path: string }) => {
      if (req.path.endsWith('/start')) {
        return { configured: false, progress: 10, state: 'starting', message: 'Downloading Node 22…' }
      }

      polls += 1

      return polls === 1
        ? { configured: false, progress: 55, state: 'starting', message: 'Installing OmniRoute…' }
        : { configured: true, progress: 100, state: 'ready' }
    })

    mockApi(api)

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(screen.getByText('Installing OmniRoute…')).toBeTruthy(), { timeout: 5000 })
    await waitFor(() => expect(ctx.onCompleted).toHaveBeenCalled(), { timeout: 5000 })
  }, 15_000)

  it('reports a failed start request instead of spinning forever', async () => {
    mockApi(async () => {
      throw new Error('API /api/setup/omniroute/start failed: 500 the backend exploded')
    })

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(screen.getByText(/the backend exploded/)).toBeTruthy())
    expect(ctx.onCompleted).not.toHaveBeenCalled()
  })
})
