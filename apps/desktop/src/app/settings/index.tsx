import { useStore } from '@nanostores/react'
import { useRef } from 'react'

import { getAliceConfigDefaults, getAliceConfigRecord, saveAliceConfig } from '@/alice'
import { codiconIcon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Archive, Bell, Download, Globe, Info, KeyRound, RefreshCw, Settings2, Upload, Wrench, Zap } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $advancedSetupPending } from '@/store/advanced-setup'
import { notifyError } from '@/store/notifications'

import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { PAGE_INSET_X } from '../layout-constants'
import { OverlayIconButton } from '../overlays/overlay-chrome'
import { OverlayMain, OverlayNavItem, OverlaySidebar, OverlaySplitLayout } from '../overlays/overlay-split-layout'
import { OverlayView } from '../overlays/overlay-view'

import { AboutSettings } from './about-settings'
import { AdvancedSetupSettings } from './advanced-setup'
import { AppearanceSettings } from './appearance-settings'
import { ConfigSettings } from './config-settings'
import { SECTIONS } from './constants'
import { GatewaySettings } from './gateway-settings'
import { KEYS_VIEWS, KeysSettings, type KeysView } from './keys-settings'
import { McpSettings } from './mcp-settings'
import { NotificationsSettings } from './notifications-settings'
import { PROVIDER_VIEWS, ProvidersSettings, type ProviderView } from './providers-settings'
import { SessionsSettings } from './sessions-settings'
import type { SettingsPageProps, SettingsView as SettingsViewId } from './types'

const CONFIG_VIEWS = SECTIONS.map(s => `config:${s.id}` as SettingsViewId)

// Cabinet order == numbering: the config sections first, then the service
// surfaces, then About. `numberOf` pads to two digits so the index rail reads
// as a table of contents rather than a menu.
const SETTINGS_VIEWS: readonly SettingsViewId[] = [
  ...CONFIG_VIEWS,
  'notifications',
  'providers',
  'gateway',
  'keys',
  'mcp',
  'sessions',
  'advanced',
  'about'
]

function numberOf(view: SettingsViewId): string {
  return String(SETTINGS_VIEWS.indexOf(view) + 1).padStart(2, '0')
}

export function SettingsView({ gateway, onClose, onConfigSaved, onMainModelChanged }: SettingsPageProps) {
  const { t } = useI18n()
  const [activeView, setActiveView] = useRouteEnumParam('tab', SETTINGS_VIEWS, 'config:model' as SettingsViewId)
  const advancedPending = useStore($advancedSetupPending)
  // Providers subnav (Accounts vs API keys) lives in its own param so each
  // sub-view is deep-linkable and survives a refresh.
  const [providerView, setProviderView] = useRouteEnumParam<ProviderView>('pview', PROVIDER_VIEWS, 'accounts')
  const [keysView, setKeysView] = useRouteEnumParam<KeysView>('kview', KEYS_VIEWS, 'tools')

  const openProviderView = (view: ProviderView) => {
    setActiveView('providers')
    setProviderView(view)
  }

  const openKeysView = (view: KeysView) => {
    setActiveView('keys')
    setKeysView(view)
  }

  const activeSection = SECTIONS.find(section => `config:${section.id}` === activeView)

  const activeTitle = activeSection
    ? (t.settings.sections[activeSection.id] ?? activeSection.label)
    : activeView === 'notifications'
      ? t.settings.nav.notifications
      : activeView === 'providers'
        ? t.settings.nav.providers
        : activeView === 'gateway'
          ? t.settings.nav.gateway
          : activeView === 'keys'
            ? t.settings.nav.apiKeys
            : activeView === 'mcp'
              ? t.settings.nav.mcp
              : activeView === 'sessions'
                ? t.settings.nav.archivedChats
                : activeView === 'advanced'
                  ? t.settings.nav.advanced
                  : t.settings.nav.about

  const importInputRef = useRef<HTMLInputElement | null>(null)

  const exportConfig = async () => {
    try {
      const cfg = await getAliceConfigRecord()
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'alice-config.json'
      a.click()
      URL.revokeObjectURL(url)
      triggerHaptic('success')
    } catch (err) {
      notifyError(err, t.settings.exportFailed)
    }
  }

  const resetConfig = async () => {
    if (!window.confirm(t.settings.resetConfirm)) {
      return
    }

    try {
      await saveAliceConfig(await getAliceConfigDefaults())
      triggerHaptic('success')
      onConfigSaved?.()
    } catch (err) {
      notifyError(err, t.settings.resetFailed)
    }
  }

  return (
    <OverlayView closeLabel={t.settings.closeSettings} onClose={onClose}>
      <OverlaySplitLayout>
        <OverlaySidebar>
          <div className="px-2.5 pb-3 font-[family-name:var(--font-display)] text-[0.72rem] uppercase tracking-[0.2em] text-(--ui-text-quaternary)">
            Alice · Settings
          </div>
          {SECTIONS.map(s => {
            const view = `config:${s.id}` as SettingsViewId

            return (
              <OverlayNavItem
                active={activeView === view}
                icon={s.icon}
                index={numberOf(view)}
                key={s.id}
                label={t.settings.sections[s.id] ?? s.label}
                onClick={() => setActiveView(view)}
              />
            )
          })}
          <OverlayNavItem
            active={activeView === 'notifications'}
            icon={Bell}
            index={numberOf('notifications')}
            label={t.settings.nav.notifications}
            onClick={() => setActiveView('notifications')}
          />
          <div className="my-2.5 h-px bg-(--ui-stroke-quaternary)" />
          <OverlayNavItem
            active={activeView === 'providers'}
            icon={Zap}
            index={numberOf('providers')}
            label={t.settings.nav.providers}
            onClick={() => setActiveView('providers')}
          />
          {activeView === 'providers' && (
            <div className="ml-3.5 flex flex-col gap-0.5 pl-1.5">
              <OverlayNavItem
                active={providerView === 'accounts'}
                icon={codiconIcon('account')}
                label={t.settings.nav.providerAccounts}
                nested
                onClick={() => openProviderView('accounts')}
              />
              <OverlayNavItem
                active={providerView === 'keys'}
                icon={KeyRound}
                label={t.settings.nav.providerApiKeys}
                nested
                onClick={() => openProviderView('keys')}
              />
            </div>
          )}
          <OverlayNavItem
            active={activeView === 'gateway'}
            icon={Globe}
            index={numberOf('gateway')}
            label={t.settings.nav.gateway}
            onClick={() => setActiveView('gateway')}
          />
          <OverlayNavItem
            active={activeView === 'keys'}
            icon={KeyRound}
            index={numberOf('keys')}
            label={t.settings.nav.apiKeys}
            onClick={() => setActiveView('keys')}
          />
          {activeView === 'keys' && (
            <div className="ml-3.5 flex flex-col gap-0.5 pl-1.5">
              <OverlayNavItem
                active={keysView === 'tools'}
                icon={Wrench}
                label={t.settings.nav.keysTools}
                nested
                onClick={() => openKeysView('tools')}
              />
              <OverlayNavItem
                active={keysView === 'settings'}
                icon={Settings2}
                label={t.settings.nav.keysSettings}
                nested
                onClick={() => openKeysView('settings')}
              />
            </div>
          )}
          <OverlayNavItem
            active={activeView === 'mcp'}
            icon={Wrench}
            index={numberOf('mcp')}
            label={t.settings.nav.mcp}
            onClick={() => setActiveView('mcp')}
          />
          <OverlayNavItem
            active={activeView === 'sessions'}
            icon={Archive}
            index={numberOf('sessions')}
            label={t.settings.nav.archivedChats}
            onClick={() => setActiveView('sessions')}
          />
          <div className="my-2.5 h-px bg-(--ui-stroke-quaternary)" />
          <OverlayNavItem
            active={activeView === 'advanced'}
            icon={Settings2}
            index={numberOf('advanced')}
            label={t.settings.nav.advanced}
            onClick={() => setActiveView('advanced')}
            trailing={
              advancedPending > 0 ? (
                <span className="rounded-full bg-amber-500/15 px-1.5 text-[0.625rem] font-semibold text-amber-500 tabular-nums">
                  {advancedPending}
                </span>
              ) : null
            }
          />
          <OverlayNavItem
            active={activeView === 'about'}
            icon={Info}
            index={numberOf('about')}
            label={t.settings.nav.about}
            onClick={() => setActiveView('about')}
          />
          <div className="mt-auto flex items-center gap-1 pt-2">
            <Tip label={t.settings.exportConfig}>
              <OverlayIconButton onClick={() => void exportConfig()}>
                <Download className="size-3.5" />
              </OverlayIconButton>
            </Tip>
            <Tip label={t.settings.importConfig}>
              <OverlayIconButton
                onClick={() => {
                  triggerHaptic('open')
                  importInputRef.current?.click()
                }}
              >
                <Upload className="size-3.5" />
              </OverlayIconButton>
            </Tip>
            <Tip label={t.settings.resetToDefaults}>
              <OverlayIconButton
                className="hover:text-destructive"
                onClick={() => {
                  triggerHaptic('warning')
                  void resetConfig()
                }}
              >
                <RefreshCw className="size-3.5" />
              </OverlayIconButton>
            </Tip>
          </div>
        </OverlaySidebar>

        <OverlayMain className="px-0 pb-0 pt-[calc(var(--titlebar-height)/2+0.75rem)]">
          <header className={cn('flex shrink-0 items-baseline gap-3 pb-5', PAGE_INSET_X)}>
            <span className="font-[family-name:var(--font-display)] text-[0.72rem] tracking-[0.2em] text-(--accent-text)">
              {numberOf(activeView)}
            </span>
            <h2 className="font-[family-name:var(--font-display)] text-[1.45rem] leading-none tracking-[0.04em] text-foreground">
              {activeTitle}
            </h2>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">
            {activeView === 'advanced' ? (
              <AdvancedSetupSettings />
            ) : activeView === 'config:appearance' ? (
              <AppearanceSettings />
            ) : activeView === 'about' ? (
              <AboutSettings />
            ) : activeView === 'gateway' ? (
              <GatewaySettings />
            ) : activeView.startsWith('config:') ? (
              <ConfigSettings
                activeSectionId={activeView.slice('config:'.length)}
                importInputRef={importInputRef}
                onConfigSaved={onConfigSaved}
                onMainModelChanged={onMainModelChanged}
              />
            ) : activeView === 'providers' ? (
              <ProvidersSettings onClose={onClose} onViewChange={setProviderView} view={providerView} />
            ) : activeView === 'keys' ? (
              <KeysSettings view={keysView} />
            ) : activeView === 'mcp' ? (
              <McpSettings gateway={gateway} onConfigSaved={onConfigSaved} />
            ) : activeView === 'notifications' ? (
              <NotificationsSettings />
            ) : (
              <SessionsSettings />
            )}
          </div>
        </OverlayMain>
      </OverlaySplitLayout>
    </OverlayView>
  )
}

export { SettingsView as SettingsPage }
