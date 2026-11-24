import { useQueryClient } from '@tanstack/react-query'
import { Suspense } from 'react'

import type { AliceGateway } from '@/alice'
import { BootFailureOverlay } from '@/components/boot-failure-overlay'
import { DesktopInstallOverlay } from '@/components/desktop-install-overlay'
import { GatewayConnectingOverlay } from '@/components/gateway-connecting-overlay'
import { HelpFab, HelpOverlay } from '@/components/help-overlay'
import { MigrationWizard } from '@/components/migration-wizard'
import { FirstRunTour } from '@/components/first-run-tour'
import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { RemoteDisplayBanner } from '@/components/remote-display-banner'
import { setCurrentModel, setCurrentProvider } from '@/store/session'
import { isSecondaryWindow } from '@/store/windows'

import { AgentsView } from '../agents'
import { CommandCenterView } from '../command-center'
import type { CommandCenterSection } from '../command-center'
import { CommandPalette } from '../command-palette'
import { CronView } from '../cron'
import { ModelPickerOverlay } from '../model-picker-overlay'
import { ModelVisibilityOverlay } from '../model-visibility-overlay'
import { PetGenerateOverlay } from '../pet-generate/pet-generate-overlay'
import { ProfilesView } from '../profiles'
import { FileActionDialogs } from '../right-sidebar/file-actions'
import { RemoteFolderPicker } from '../right-sidebar/files/remote-picker'
import { sessionRoute } from '../routes'
import { SessionPickerOverlay } from '../session-picker-overlay'
import { SessionSwitcher } from '../session-switcher'
import { SettingsView } from '../settings'
import { StarmapView } from '../starmap'
import { UpdatesOverlay } from '../updates-overlay'

export interface OverlaysHostProps {
  agentsOpen: boolean
  closeOverlayToPreviousRoute: () => void
  commandCenterInitialSection?: CommandCenterSection
  commandCenterOpen: boolean
  cronOpen: boolean
  gateway: AliceGateway | undefined
  gatewayState: string
  helpOpen: boolean
  migrationOpen: boolean
  navigate: (path: string) => void
  openProviderSettings: () => void
  profilesOpen: boolean
  refreshAliceConfig: () => void
  refreshCurrentModel: () => void
  removeSession: (sessionId: string) => Promise<unknown> | void
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  resumeSession: (sessionId: string, focus?: boolean) => Promise<unknown>
  selectModel: (selection: { model: string; provider: string }) => void
  setHelpOpen: (open: boolean) => void
  setMigrationOpen: (open: boolean) => void
  settingsOpen: boolean
  starmapOpen: boolean
  updateModelOptionsCache: (provider: string, model: string, refresh: boolean) => void
}

/**
 * Every fixed-position overlay, in one owner. Extracted from the composition
 * root (Phase 2) so overlay state (help/migration/settings/command center) only
 * re-renders this subtree instead of the whole shell.
 */
export function OverlaysHost(props: OverlaysHostProps) {
  const {
    agentsOpen,
    closeOverlayToPreviousRoute,
    commandCenterInitialSection,
    commandCenterOpen,
    cronOpen,
    gateway,
    gatewayState,
    helpOpen,
    migrationOpen,
    navigate,
    openProviderSettings,
    profilesOpen,
    refreshAliceConfig,
    refreshCurrentModel,
    removeSession,
    requestGateway,
    resumeSession,
    selectModel,
    setHelpOpen,
    setMigrationOpen,
    settingsOpen,
    starmapOpen,
    updateModelOptionsCache
  } = props

  const queryClient = useQueryClient()

  const onConfigSaved = () => {
    refreshAliceConfig()
    refreshCurrentModel()
  }

  return (
    <>
      <RemoteDisplayBanner />
      {!isSecondaryWindow() && <DesktopInstallOverlay />}
      {/* First-run tour: provider → model → terminal → tools → gateway. Sits
      below the onboarding picker (z-1300) so "Connect a provider" opens that
      flow on top instead of replacing the tour. It self-opens only until the
      user finishes or skips it once. */}
      {!isSecondaryWindow() && <FirstRunTour navigate={navigate} />}
      {!isSecondaryWindow() && (
        <DesktopOnboardingOverlay
          enabled={gatewayState === 'open'}
          onCompleted={() => {
            void refreshAliceConfig()
            void refreshCurrentModel()
            void queryClient.invalidateQueries({ queryKey: ['model-options'] })
          }}
          requestGateway={requestGateway}
        />
      )}
      <ModelPickerOverlay gateway={gateway || undefined} onSelect={selectModel} />
      <SessionPickerOverlay onResume={resumeSession} />
      <ModelVisibilityOverlay gateway={gateway || undefined} onOpenProviders={openProviderSettings} />
      <UpdatesOverlay />
      <GatewayConnectingOverlay />
      <BootFailureOverlay />
      <HelpFab onClick={() => setHelpOpen(true)} />
      <HelpOverlay
        onClose={() => setHelpOpen(false)}
        onOpenMigration={() => {
          setHelpOpen(false)
          setMigrationOpen(true)
        }}
        open={helpOpen}
      />
      <MigrationWizard onClose={() => setMigrationOpen(false)} open={migrationOpen} />
      <CommandPalette />
      <PetGenerateOverlay />
      <SessionSwitcher />
      <FileActionDialogs />
      <RemoteFolderPicker />

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsView
            gateway={gateway}
            onClose={closeOverlayToPreviousRoute}
            onConfigSaved={() => {
              void refreshAliceConfig()
              void refreshCurrentModel()
              void queryClient.invalidateQueries({ queryKey: ['model-options'] })
            }}
            onMainModelChanged={(provider, model) => {
              setCurrentProvider(provider)
              setCurrentModel(model)
              updateModelOptionsCache(provider, model, true)
              void refreshCurrentModel()
              void queryClient.invalidateQueries({ queryKey: ['model-options'] })
            }}
          />
        </Suspense>
      )}

      {commandCenterOpen && (
        <Suspense fallback={null}>
          <CommandCenterView
            initialSection={commandCenterInitialSection}
            onClose={closeOverlayToPreviousRoute}
            onDeleteSession={async sessionId => {
              await removeSession(sessionId)
            }}
            onNavigateRoute={path => navigate(path)}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
          />
        </Suspense>
      )}

      {agentsOpen && (
        <Suspense fallback={null}>
          <AgentsView onClose={closeOverlayToPreviousRoute} />
        </Suspense>
      )}

      {cronOpen && (
        <Suspense fallback={null}>
          <CronView
            onClose={closeOverlayToPreviousRoute}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
          />
        </Suspense>
      )}

      {profilesOpen && (
        <Suspense fallback={null}>
          <ProfilesView onClose={closeOverlayToPreviousRoute} />
        </Suspense>
      )}

      {starmapOpen && (
        <Suspense fallback={null}>
          <StarmapView onClose={closeOverlayToPreviousRoute} />
        </Suspense>
      )}
    </>
  )
}
