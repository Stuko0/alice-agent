import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { getAliceConfigRecord, getGlobalModelOptions } from '@/alice'
import { SETTINGS_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Check, ChevronRight, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type AdvancedSetupId,
  type AdvancedSetupInput,
  buildAdvancedSetupItems,
  pendingAdvancedSetupCount,
  setAdvancedSetupPending
} from '@/store/advanced-setup'

import { SettingsContent } from './primitives'

interface SetupStatus {
  configured: boolean
  model: null | string
  provider: null | string
  terminal_backend: string
}

interface ToolsetRow {
  configured?: boolean
  enabled: boolean
  name: string
}

interface McpServerRow {
  name: string
}

interface StatusResponse {
  gateway_platforms?: Record<string, unknown>
}

const settingsTab = (tab: string) => `${SETTINGS_ROUTE}?tab=${tab}`

/** Where each item lives, so the row can deep-link without a mapping table elsewhere. */
const TAB_FOR: Record<AdvancedSetupId, string> = {
  gateway: 'gateway',
  memory: 'config:memory',
  mcp: 'mcp',
  provider: 'config:model',
  terminal: 'config:workspace',
  toolKeys: 'keys',
  voice: 'config:voice'
}

const api = <T,>(path: string) => window.aliceDesktop?.api<T>({ path }) as Promise<T>

function configValue(record: Record<string, unknown>, section: string, key: string): unknown {
  const value = record[section]

  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}

export function AdvancedSetupSettings() {
  const { t } = useI18n()
  const copy = t.settings.advancedSetup
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<null | string>(null)
  const [input, setInput] = useState<AdvancedSetupInput | null>(null)
  const [providersAuthenticated, setProvidersAuthenticated] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const [status, config, toolsets, mcp, gatewayStatus, options] = await Promise.all([
        api<SetupStatus>('/api/setup/status'),
        getAliceConfigRecord().catch(() => ({}) as Record<string, unknown>),
        api<ToolsetRow[]>('/api/tools/toolsets').catch(() => [] as ToolsetRow[]),
        api<{ servers: McpServerRow[] }>('/api/mcp/servers').catch(() => ({ servers: [] })),
        api<StatusResponse>('/api/status').catch(() => ({}) as StatusResponse),
        getGlobalModelOptions().catch(() => null)
      ])

      const toolsetsMissingKeys = (toolsets ?? []).filter(row => row.enabled && row.configured === false).length

      setProvidersAuthenticated((options?.providers ?? []).filter(p => p.authenticated !== false).length)

      setInput({
        configured: Boolean(status?.configured),
        gatewayPlatforms: Object.keys(gatewayStatus?.gateway_platforms ?? {}).length,
        mcpServers: (mcp?.servers ?? []).length,
        memoryProvider: String(configValue(config, 'memory', 'provider') ?? '').trim(),
        terminalBackend: String(status?.terminal_backend ?? '').trim(),
        toolsetsMissingKeys,
        voiceConfigured:
          Boolean(String(configValue(config, 'tts', 'provider') ?? '').trim()) ||
          configValue(config, 'stt', 'enabled') === true
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const items = useMemo(() => (input ? buildAdvancedSetupItems(input) : []), [input])
  const pending = pendingAdvancedSetupCount(items)

  useEffect(() => {
    setAdvancedSetupPending(pending)
  }, [pending])

  const meta: Record<AdvancedSetupId, { desc: string; label: string }> = {
    gateway: { desc: copy.gatewayDesc, label: copy.gatewayLabel },
    memory: { desc: copy.memoryDesc, label: copy.memoryLabel },
    mcp: { desc: copy.mcpDesc, label: copy.mcpLabel },
    provider: { desc: copy.providerDesc, label: copy.providerLabel },
    terminal: { desc: copy.terminalDesc, label: copy.terminalLabel },
    toolKeys: { desc: copy.toolKeysDesc, label: copy.toolKeysLabel },
    voice: { desc: copy.voiceDesc, label: copy.voiceLabel }
  }

  return (
    <SettingsContent>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{copy.intro}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {loading ? copy.loading : pending === 0 ? copy.allDone : copy.pendingCount(pending)}
          </p>
        </div>
        <Button disabled={loading} onClick={() => void load()} size="sm" variant="secondary">
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {copy.refresh}
        </Button>
      </div>

      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}

      <div className="mt-4 grid gap-2">
        {(loading && !input ? [] : items).map(item => {
          const { desc, label } = meta[item.id]

          return (
            <div
              className="flex items-start justify-between gap-4 rounded-xl border border-(--stroke-hairline) px-4 py-3"
              key={item.id}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span
                    className={cn(
                      'grid size-4 shrink-0 place-items-center rounded-full text-[0.625rem]',
                      item.done ? 'bg-primary/15 text-primary' : 'bg-amber-500/15 text-amber-500'
                    )}
                  >
                    {item.done ? <Check className="size-3" /> : '!'}
                  </span>
                  {label}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{desc}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    'text-[0.6875rem] font-medium uppercase tracking-wide',
                    item.done ? 'text-muted-foreground' : 'text-amber-500'
                  )}
                >
                  {item.done ? copy.statusDone : copy.statusPending}
                </span>
                <Button onClick={() => navigate(settingsTab(TAB_FOR[item.id]))} size="sm" variant="ghost">
                  {copy.open}
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {providersAuthenticated === 0 && pending > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{copy.providerHint}</p>
      ) : null}
    </SettingsContent>
  )
}
