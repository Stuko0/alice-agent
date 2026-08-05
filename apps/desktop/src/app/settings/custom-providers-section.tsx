import { useCallback, useEffect, useState } from 'react'

import {
  addCustomProvider,
  deleteCustomProvider,
  listCustomProviders,
  testCustomProvider,
  type CustomProviderSpec
} from '@/alice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Plus, Trash2, Zap } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { notify, notifyError } from '@/store/notifications'

interface ProbeState {
  ok: boolean
  text: string
}

/**
 * Dynamic Provider Registry section for Settings → Providers (keys view).
 * Lists custom providers from ~/.alice/providers.d/ (via config.providers)
 * and lets users add/test/remove them with a small inline form.
 */
export function CustomProvidersSection() {
  const { t } = useI18n()
  const copy = t.settings.providers

  const [providers, setProviders] = useState<CustomProviderSpec[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [probe, setProbe] = useState<Record<string, ProbeState>>({})

  // Inline add-form fields.
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [keyEnv, setKeyEnv] = useState('')
  const [apiMode, setApiMode] = useState<'openai' | 'anthropic'>('openai')

  const refresh = useCallback(async () => {
    try {
      setProviders(await listCustomProviders())
    } catch (err) {
      notifyError(err, copy.customTitle)
    } finally {
      setLoading(false)
    }
  }, [copy.customTitle])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleSave() {
    if (!name.trim() || !baseUrl.trim()) {
      return
    }
    setSaving(true)
    try {
      const spec: CustomProviderSpec = { name: name.trim(), base_url: baseUrl.trim() }
      if (keyEnv.trim()) {
        spec.api_key_env = keyEnv.trim()
      }
      spec.api_mode = apiMode
      await addCustomProvider(spec)
      notify({ kind: 'success', message: copy.customAdded(name.trim()) })
      setName('')
      setBaseUrl('')
      setKeyEnv('')
      setAdding(false)
      await refresh()
    } catch (err) {
      notifyError(err, copy.customAdd)
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(provider: CustomProviderSpec) {
    const id = provider.provider_key ?? provider.name
    setTesting(id)
    try {
      const result = await testCustomProvider(id)
      setProbe(prev => ({
        ...prev,
        [id]: result.ok
          ? { ok: true, text: copy.customProbeOk(result.latency_ms, (result.models ?? []).length) }
          : { ok: false, text: copy.customProbeFail(result.error ?? 'unknown error') }
      }))
    } catch (err) {
      notifyError(err, copy.customTest)
    } finally {
      setTesting(null)
    }
  }

  async function handleRemove(provider: CustomProviderSpec) {
    const id = provider.provider_key ?? provider.name
    if (!window.confirm(copy.customDeleteConfirm(provider.name))) {
      return
    }
    setRemoving(id)
    try {
      await deleteCustomProvider(id)
      notify({ kind: 'success', message: copy.customRemoved(provider.name) })
      await refresh()
    } catch (err) {
      notifyError(err, copy.customDelete)
    } finally {
      setRemoving(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-0.5 py-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {copy.loading}
      </div>
    )
  }

  return (
    <section className="mt-5 border-t border-(--ui-border) pt-4">
      <div className="flex items-center justify-between px-0.5">
        <div>
          <h3 className="text-sm font-semibold text-(--ui-text-primary)">{copy.customTitle}</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{copy.customIntro}</p>
        </div>
        <Button onClick={() => setAdding(v => !v)} size="sm" type="button" variant="secondary">
          <Plus className="size-3.5" />
          {copy.customAdd}
        </Button>
      </div>

      {adding && (
        <div className="mt-3 grid gap-2 rounded-[6px] border border-(--ui-border) p-3">
          <label className="grid gap-1">
            <span className="text-xs font-medium">{copy.customName}</span>
            <Input
              autoFocus
              onChange={e => setName(e.target.value)}
              placeholder={copy.customNamePlaceholder}
              value={name}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium">{copy.customBaseUrl}</span>
            <Input
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={copy.customBaseUrlPlaceholder}
              value={baseUrl}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium">{copy.customKeyEnv}</span>
            <Input
              onChange={e => setKeyEnv(e.target.value)}
              placeholder={copy.customKeyEnvPlaceholder}
              value={keyEnv}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium">{copy.customApiMode}</span>
            <select
              className="h-9 rounded-[6px] border border-(--ui-border) bg-(--ui-control-background) px-2 text-sm"
              onChange={e => setApiMode(e.target.value as 'openai' | 'anthropic')}
              value={apiMode}
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <div className="mt-1 flex items-center justify-end gap-2">
            <Button onClick={() => setAdding(false)} size="sm" type="button" variant="ghost">
              {copy.customCancel}
            </Button>
            <Button disabled={saving || !name.trim() || !baseUrl.trim()} onClick={() => void handleSave()} size="sm" type="button">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {copy.customSave}
            </Button>
          </div>
        </div>
      )}

      {providers.length === 0 ? (
        <p className="px-0.5 pt-2 text-xs text-muted-foreground/70">{copy.customEmpty}</p>
      ) : (
        <ul className="mt-2 grid gap-1.5">
          {providers.map(provider => {
            const id = provider.provider_key ?? provider.name
            const probeState = probe[id]
            return (
              <li
                className="flex items-center justify-between gap-2 rounded-[6px] border border-(--ui-border) px-3 py-2.5"
                key={id}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{provider.name}</span>
                    <span className="shrink-0 rounded bg-(--ui-control-hover-background) px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                      {provider.api_mode === 'anthropic' ? 'anthropic' : 'openai'}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{provider.base_url}</p>
                  {probeState && (
                    <p className={`mt-1 text-xs ${probeState.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                      {probeState.text}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    aria-label={copy.customTest}
                    onClick={() => void handleTest(provider)}
                    size="icon-sm"
                    title={copy.customTest}
                    type="button"
                    variant="ghost"
                  >
                    {testing === id ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                  </Button>
                  <Button
                    aria-label={copy.customDelete}
                    onClick={() => void handleRemove(provider)}
                    size="icon-sm"
                    title={copy.customDelete}
                    type="button"
                    variant="ghost"
                  >
                    {removing === id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
