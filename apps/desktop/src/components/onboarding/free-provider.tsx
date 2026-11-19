import { useState } from 'react'

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
 */
export async function startFreeProvider(): Promise<{ message?: string; ok: boolean }> {
  const api = window.aliceDesktop?.api

  if (!api) {
    return { ok: false, message: 'Desktop bridge unavailable.' }
  }

  try {
    const result = await api<{ configured?: boolean }>({
      body: JSON.stringify({}),
      method: 'POST',
      path: '/api/setup/omniroute/start'
    })

    if (!result?.configured) {
      return { ok: false, message: 'OmniRoute did not finish starting.' }
    }

    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export function FreeProviderRow({ ctx }: { ctx: OnboardingContext }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    if (busy) {
      return
    }

    setBusy(true)
    setError(null)

    const result = await startFreeProvider()

    setBusy(false)

    if (!result.ok) {
      setError(result.message ?? t.onboarding.freeProviderFailed)

      return
    }

    ctx.onCompleted?.()
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
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Zap className="size-4 shrink-0 text-primary" />
            <span className="text-[length:var(--conversation-text-font-size)] font-semibold">
              {t.onboarding.freeProviderTitle}
            </span>
            <span className="inline-flex items-center gap-1.5 bg-primary px-2 py-0.5 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-primary-foreground">
              {t.onboarding.freeProviderBadge}
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
      {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
