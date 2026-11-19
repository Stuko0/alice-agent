import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $desktopOnboarding, type OnboardingContext } from '@/store/onboarding'

import { FreeProviderRow } from './free-provider'

function makeCtx(oneshot: () => Promise<{ text?: string }> = async () => ({ text: 'ready' })): OnboardingContext {
  return { onCompleted: vi.fn(), requestGateway: (() => oneshot()) as OnboardingContext['requestGateway'] }
}

function mockApi(handler: (req: { body?: { force?: boolean }; path: string }) => Promise<unknown>) {
  ;(window as any).aliceDesktop = { api: handler }
}

let ctx: OnboardingContext

beforeEach(() => {
  ctx = makeCtx()
})

afterEach(() => {
  cleanup()
  delete (window as any).aliceDesktop

  try {
    window.localStorage.clear()
  } catch {
    // jsdom always has localStorage; ignore if not.
  }

  $desktopOnboarding.set({
    configured: null,
    firstRunSkipped: false,
    flow: { status: 'idle' },
    localEndpoint: false,
    manual: false,
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false
  })
})

describe('FreeProviderRow', () => {
  it('configures, verifies and completes onboarding', async () => {
    const api = vi.fn(async (_req: { path: string }) => ({
      configured: true,
      id: 'pollinations',
      model: 'openai-fast'
    }))

    mockApi(api)

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(ctx.onCompleted).toHaveBeenCalled())

    // The overlay's own poll must agree, so the row closes the flow in the
    // store — otherwise the re-check reopens it and the click looks ignored.
    expect($desktopOnboarding.get().configured).toBe(true)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0][0].path).toBe('/api/setup/free-endpoint')
  })

  it('keeps the modal open when the endpoint cannot answer a completion', async () => {
    ctx = makeCtx(async () => {
      throw new Error('Connection error.')
    })
    mockApi(async () => ({ configured: true }))

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(screen.getByText('Connection error.')).toBeTruthy())

    expect(ctx.onCompleted).not.toHaveBeenCalled()
    expect($desktopOnboarding.get().configured).not.toBe(true)
    expect(screen.getByText('Try again')).toBeTruthy()
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
  })

  it('lets the user configure anyway when the probe is blocked', async () => {
    ctx = makeCtx(async () => {
      throw new Error('must not verify in force mode')
    })

    const api = vi.fn(async (req: { body?: { force?: boolean } }) => {
      if (!req.body?.force) {
        throw new Error('API /api/setup/free-endpoint failed: 502 Could not reach the free endpoint')
      }

      return { configured: true, unverified: true }
    })

    mockApi(api)

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(screen.getByText('Use it anyway')).toBeTruthy())
    fireEvent.click(screen.getByText('Use it anyway'))

    await waitFor(() => expect(ctx.onCompleted).toHaveBeenCalled())
    expect(api.mock.calls[1][0].body).toEqual({ force: true })
  })

  it('treats an unconfigured response as a failure', async () => {
    mockApi(async () => ({ configured: false }))

    render(<FreeProviderRow ctx={ctx} />)
    fireEvent.click(screen.getByText('Free — no account needed'))

    await waitFor(() => expect(screen.getByText(/did not answer/)).toBeTruthy())
    expect(ctx.onCompleted).not.toHaveBeenCalled()
  })
})
