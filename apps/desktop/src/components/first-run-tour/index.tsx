import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { getGlobalModelOptions, setModelAssignment } from '@/alice'
import { SETTINGS_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Check, ChevronLeft, ChevronRight, Loader2, Settings2, Wrench } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $firstRunTour,
  closeFirstRunTour,
  type FirstRunTourStepId,
  openFirstRunTour,
  setFirstRunTourStep,
  shouldAutoOpenFirstRunTour,
  TOUR_STEPS
} from '@/store/first-run-tour'
import { notifyError } from '@/store/notifications'
import { $desktopOnboarding, startManualOnboarding } from '@/store/onboarding'

interface SetupStatus {
  configured: boolean
  model: null | string
  provider: null | string
  terminal_backend: string
}

interface ToolsetRow {
  description?: string
  enabled: boolean
  label: string
  name: string
}

const TERMINAL_BACKENDS = ['local', 'wsl', 'docker', 'modal'] as const

const api = <T,>(path: string, init?: { body?: unknown; method?: string }) =>
  window.aliceDesktop?.api<T>({
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    method: init?.method,
    path
  }) as Promise<T>

export function FirstRunTour({ navigate }: { navigate: (path: string) => void }) {
  const { t } = useI18n()
  const copy = t.firstRun
  const tour = useStore($firstRunTour)
  const onboarding = useStore($desktopOnboarding)

  const [status, setStatus] = useState<null | SetupStatus>(null)
  const [providers, setProviders] = useState<Array<{ models: string[]; name: string; slug: string }>>([])
  const [toolsets, setToolsets] = useState<null | ToolsetRow[]>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const step = (TOUR_STEPS[tour.step] ?? 'provider') as FirstRunTourStepId

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, options] = await Promise.all([
        api<SetupStatus>('/api/setup/status'),
        getGlobalModelOptions().catch(() => null)
      ])

      setStatus(nextStatus)
      setProviders(
        (options?.providers ?? [])
          .filter(provider => provider.authenticated !== false)
          .map(provider => ({ models: provider.models ?? [], name: provider.name, slug: provider.slug }))
          .filter(provider => provider.models.length > 0)
      )
    } catch {
      // The tour degrades to static guidance when the gateway is unreachable.
    }
  }, [])

  const loadToolsets = useCallback(async () => {
    try {
      setToolsets(await api<ToolsetRow[]>('/api/tools/toolsets'))
    } catch {
      setToolsets([])
    }
  }, [])

  // Open by itself on the first configured launch; never fight onboarding.
  useEffect(() => {
    if (shouldAutoOpenFirstRunTour($firstRunTour.get(), { configured: onboarding.configured === true })) {
      openFirstRunTour()
      void refresh()
    }
  }, [onboarding.configured, refresh])

  useEffect(() => {
    if (!tour.open) {
      return
    }

    void refresh()
  }, [tour.open, refresh])

  useEffect(() => {
    if (tour.open && step === 'tools' && toolsets === null) {
      void loadToolsets()
    }
  }, [loadToolsets, step, toolsets, tour.open])

  const setStep = (next: number) => setFirstRunTourStep(next)

  const finish = () => closeFirstRunTour({ completed: true })

  const saveTerminalBackend = async (backend: string) => {
    setBusy(true)
    setError(null)

    try {
      await api('/api/setup/terminal-backend', { body: { backend }, method: 'POST' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveModel = async (value: string) => {
    const [provider, ...rest] = value.split('::')
    const model = rest.join('::')

    if (!provider || !model) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      await setModelAssignment({ model, provider, scope: 'main' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleToolset = async (row: ToolsetRow) => {
    setBusy(true)
    setError(null)

    try {
      await api(`/api/tools/toolsets/${encodeURIComponent(row.name)}`, {
        body: { enabled: !row.enabled },
        method: 'PUT'
      })
      await loadToolsets()
    } catch (err) {
      notifyError(err, copy.toolsTitle)
    } finally {
      setBusy(false)
    }
  }

  const providerConnected = Boolean(status?.provider)
  const modelChosen = Boolean(status?.model)
  const enabledToolsets = useMemo(() => (toolsets ?? []).filter(row => row.enabled).length, [toolsets])

  if (!tour.open) {
    return null
  }

  const stepIndex = tour.step
  const isLast = stepIndex === TOUR_STEPS.length - 1

  return (
    <div className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]">
      <div
        aria-labelledby="first-run-tour-title"
        aria-modal="true"
        className="flex max-h-[86dvh] w-full max-w-[46rem] flex-col overflow-hidden rounded-xl border border-(--stroke-hairline) bg-(--ui-chat-bubble-background) shadow-ink"
        role="dialog"
      >
        <div className="border-b border-(--stroke-hairline) px-6 pt-5 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[1.05rem] font-semibold tracking-tight" id="first-run-tour-title">
                {copy.title}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.subtitle}</p>
            </div>
            <span className="shrink-0 text-[0.6875rem] font-medium text-muted-foreground tabular-nums">
              {copy.stepOf(stepIndex + 1, TOUR_STEPS.length)}
            </span>
          </div>

          <ol className="mt-4 flex flex-wrap gap-1.5">
            {TOUR_STEPS.map((id, index) => {
              const done =
                (id === 'provider' && providerConnected) ||
                (id === 'model' && modelChosen) ||
                (id === 'terminal' && Boolean(status?.terminal_backend)) ||
                (id === 'tools' && enabledToolsets > 0) ||
                false

              return (
                <li key={id}>
                  <button
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
                      index === stepIndex
                        ? 'border-primary/50 bg-primary/10 text-primary'
                        : 'border-(--ui-stroke-tertiary) text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => setStep(index)}
                    type="button"
                  >
                    {done ? <Check className="size-3" /> : <span className="tabular-nums">{index + 1}</span>}
                    {copy.stepName(id)}
                  </button>
                </li>
              )
            })}
          </ol>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 'provider' ? (
            <Step
              action={
                <Button
                  onClick={() => {
                    startManualOnboarding()
                  }}
                  size="sm"
                  variant={providerConnected ? 'secondary' : 'default'}
                >
                  {providerConnected ? copy.change : copy.connect}
                </Button>
              }
              description={copy.providerDesc}
              done={providerConnected}
              title={copy.providerTitle}
            >
              <p className="text-xs text-muted-foreground">
                {providerConnected ? copy.providerConnected(status?.provider ?? '') : copy.providerMissing}
              </p>
            </Step>
          ) : null}

          {step === 'model' ? (
            <Step
              action={
                <Button disabled={busy} onClick={() => void refresh()} size="sm" variant="secondary">
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  {copy.refresh}
                </Button>
              }
              description={copy.modelDesc}
              done={modelChosen}
              title={copy.modelTitle}
            >
              {providers.length > 0 ? (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {copy.modelPick}
                  <select
                    className="h-9 rounded-md border border-(--ui-stroke-tertiary) bg-transparent px-2 text-[0.8125rem] text-foreground"
                    onChange={event => void saveModel(event.target.value)}
                    value={status?.provider && status.model ? `${status.provider}::${status.model}` : ''}
                  >
                    <option value="">{copy.modelNone}</option>
                    {providers.map(provider => (
                      <optgroup key={provider.slug} label={provider.name}>
                        {provider.models.slice(0, 80).map(model => (
                          <option key={`${provider.slug}::${model}`} value={`${provider.slug}::${model}`}>
                            {model}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="text-xs text-muted-foreground">{copy.modelNone}</p>
              )}
              {status?.provider && status.model ? (
                <p className="mt-2 font-mono text-[0.6875rem] text-muted-foreground">
                  {status.provider} · {status.model}
                </p>
              ) : null}
            </Step>
          ) : null}

          {step === 'terminal' ? (
            <Step description={copy.terminalDesc} done={Boolean(status?.terminal_backend)} title={copy.terminalTitle}>
              <div className="grid gap-1 text-xs text-muted-foreground">
                {copy.terminalPick}
                <select
                  className="h-9 rounded-md border border-(--ui-stroke-tertiary) bg-transparent px-2 text-[0.8125rem] text-foreground"
                  onChange={event => void saveTerminalBackend(event.target.value)}
                  value={status?.terminal_backend || 'local'}
                >
                  {TERMINAL_BACKENDS.map(backend => (
                    <option key={backend} value={backend}>
                      {backend}
                    </option>
                  ))}
                </select>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{copy.terminalHint}</p>
            </Step>
          ) : null}

          {step === 'tools' ? (
            <Step
              action={
                <Button onClick={() => void loadToolsets()} size="sm" variant="secondary">
                  {copy.refresh}
                </Button>
              }
              description={copy.toolsDesc}
              done={enabledToolsets > 0}
              title={copy.toolsTitle}
            >
              {toolsets === null ? (
                <p className="text-xs text-muted-foreground">
                  <Loader2 className="mr-1 inline size-3 animate-spin" />
                  {copy.loading}
                </p>
              ) : toolsets.length === 0 ? (
                <p className="text-xs text-muted-foreground">{copy.toolsEmpty}</p>
              ) : (
                <div className="grid max-h-56 gap-1 overflow-y-auto pr-1">
                  {toolsets.map(row => (
                    <label
                      className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-(--ui-stroke-tertiary) px-2.5 py-1.5 text-xs"
                      key={row.name}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium text-foreground">{row.label}</span>
                        <span className="block truncate text-muted-foreground">{row.description}</span>
                      </span>
                      <input
                        checked={row.enabled}
                        disabled={busy}
                        onChange={() => void toggleToolset(row)}
                        type="checkbox"
                      />
                    </label>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-muted-foreground">{copy.toolsEnabled(enabledToolsets)}</p>
            </Step>
          ) : null}

          {step === 'gateway' ? (
            <Step description={copy.gatewayDesc} done={false} title={copy.gatewayTitle}>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    closeFirstRunTour({ completed: true })
                    navigate(`${SETTINGS_ROUTE}?tab=gateway`)
                  }}
                  size="sm"
                >
                  <Settings2 />
                  {copy.gatewayOpen}
                </Button>
                <Button onClick={() => void refresh()} size="sm" variant="secondary">
                  <Wrench />
                  {copy.refresh}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{copy.gatewayHint}</p>
            </Step>
          ) : null}

          {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-(--stroke-hairline) px-6 py-3">
          <button
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => closeFirstRunTour({ skipped: true })}
            type="button"
          >
            {copy.skip}
          </button>

          <div className="flex items-center gap-2">
            <Button disabled={stepIndex === 0} onClick={() => setStep(stepIndex - 1)} size="sm" variant="ghost">
              <ChevronLeft />
              {copy.back}
            </Button>
            {isLast ? (
              <Button onClick={finish} size="sm">
                {copy.finish}
              </Button>
            ) : (
              <Button onClick={() => setStep(stepIndex + 1)} size="sm">
                {copy.next}
                <ChevronRight />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Step({
  action,
  children,
  description,
  done,
  title
}: {
  action?: React.ReactNode
  children: React.ReactNode
  description: string
  done: boolean
  title: string
}) {
  return (
    <div className="grid gap-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {done ? (
              <span className="grid size-4 place-items-center rounded-full bg-primary/15 text-primary">
                <Check className="size-3" />
              </span>
            ) : null}
            {title}
          </h3>
          <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  )
}
