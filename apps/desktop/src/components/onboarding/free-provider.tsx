import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { ChevronRight, Loader2, Zap } from '@/lib/icons'
import type { OnboardingContext } from '@/store/onboarding'

/**
 * Free, no-account provider (OmniRoute).
 *
 * The onboarding used to hide this behind a second wizard: first-time users got
 * the Copilot/API-key modal plus a separate setup driver that offered OmniRoute,
 * and most people closed both without ever finding a way to try Alice without an
 * account. This row keeps the single modal and puts the zero-setup path first.
 *
 * The backend owns the lifecycle (`/api/setup/omniroute/start` provisions a
 * private Node + gateway under `~/.alice/omniroute` and mints a local token), so
 * there is no key to paste and nothing to download by hand.
 *
 * That provisioning is a download plus an npm install — minutes on a first run.
 * The backend therefore answers `start` immediately and reports progress on
 * `/api/setup/omniroute/status`; polling here is what turns "spinner then 500"
 * into "Downloading Node 22… 40%" and a real error message when it fails.
 */

const POLL_MS = 1500
const MAX_WAIT_MS = 15 * 60_000

type SetupState = 'error' | 'idle' | 'ready' | 'starting'

interface OmniRouteStatus {
  configured?: boolean
  error?: string | null
  message?: string
  progress?: number
  state?: SetupState
}

interface FreeProviderRowProps {
  ctx: OnboardingContext
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function FreeProviderRow({ ctx }: FreeProviderRowProps) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  const start = async () => {
    if (busy) {
      return
    }

    const api = window.aliceDesktop?.api

    if (!api) {
      setError('Desktop bridge unavailable.')

      return
    }

    setBusy(true)
    setError(null)
    setMessage(null)
    setProgress(2)

    try {
      const first = await api<OmniRouteStatus>({
        method: 'POST',
        path: '/api/setup/omniroute/start'
      })

      if (!alive.current) {
        return
      }

      let status = first

      setProgress(first.progress ?? 2)
      setMessage(first.message || null)

      const deadline = Date.now() + MAX_WAIT_MS

      while (Date.now() < deadline) {
        if (status.state === 'ready' || status.configured) {
          ctx.onCompleted?.()

          return
        }

        if (status.state === 'error') {
          setError(status.error || t.onboarding.freeProviderFailed)

          return
        }

        await sleep(POLL_MS)

        if (!alive.current) {
          return
        }

        status = await api<OmniRouteStatus>({ path: '/api/setup/omniroute/status' })

        if (!alive.current) {
          return
        }

        setProgress(status.progress ?? 0)
        setMessage(status.message || null)
      }

      setError(t.onboarding.freeProviderTimeout)
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (alive.current) {
        setBusy(false)
      }
    }
  }

  const pitch = busy ? (message ?? t.onboarding.freeProviderStarting) : t.onboarding.freeProviderPitch

  return (
    <div className="grid gap-1">
      <button
        aria-busy={busy || undefined}
        className="group relative flex w-full items-center justify-between gap-4 rounded-[8px] border border-primary/30 bg-primary/[0.04] px-3 py-2.5 text-left transition-colors hover:bg-primary/10 disabled:opacity-70"
        disabled={busy}
        onClick={() => void start()}
        type="button"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Zap className="size-4 shrink-0 text-primary" />
            <span className="text-[length:var(--conversation-text-font-size)] font-semibold">
              {t.onboarding.freeProviderTitle}
            </span>
            <span className="inline-flex items-center gap-1.5 bg-primary px-2 py-0.5 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-primary-foreground">
              {busy ? t.onboarding.freeProviderBadgeBusy : t.onboarding.freeProviderBadge}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{pitch}</p>
          {busy ? (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-primary/15">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
              />
            </div>
          ) : null}
        </div>
        {busy ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-primary transition group-hover:translate-x-0.5" />
        )}
      </button>
      {error ? (
        <div className="grid gap-1 px-1">
          <p className="text-xs text-destructive">{error}</p>
          <button
            className="justify-self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => void start()}
            type="button"
          >
            {t.onboarding.freeProviderRetry}
          </button>
        </div>
      ) : null}
    </div>
  )
}
