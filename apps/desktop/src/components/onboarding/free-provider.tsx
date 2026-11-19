import { useState } from 'react'

import { useI18n } from '@/i18n'
import { ChevronRight, Loader2, Zap } from '@/lib/icons'
import type { OnboardingContext } from '@/store/onboarding'

/**
 * Free, no-account provider.
 *
 * This used to drive a local OmniRoute gateway: download Node, npm-install a
 * large dependency tree, spawn a server. That is a lot of machinery — and a
 * lot of ways to fail — for "let me try the app before I own an API key".
 *
 * A keyless public endpoint needs nothing but a URL, which is exactly what the
 * `custom` provider already is. The backend probes it with one chat request and
 * writes base_url/model into config.yaml; nothing is installed or spawned.
 */
interface FreeEndpointResult {
  configured?: boolean
  label?: string
  model?: string
}

interface FreeProviderRowProps {
  ctx: OnboardingContext
}

export function FreeProviderRow({ ctx }: FreeProviderRowProps) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

    try {
      const result = await api<FreeEndpointResult>({
        method: 'POST',
        path: '/api/setup/free-endpoint'
      })

      if (!result?.configured) {
        setError(t.onboarding.freeProviderFailed)

        return
      }

      ctx.onCompleted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

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
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {busy ? t.onboarding.freeProviderStarting : t.onboarding.freeProviderPitch}
          </p>
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
