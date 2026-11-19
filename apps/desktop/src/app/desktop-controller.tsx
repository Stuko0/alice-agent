import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { BrowserPane as NativeBrowserPane } from '@/app/browser'
import { Pane, PaneMain } from '@/components/pane-shell'
import { useMediaQuery } from '@/hooks/use-media-query'
import { isFocusWithin } from '@/lib/keybinds/combo'
import { $browserOpen, setBrowserOpen } from '@/store/browser'
import { $activeBrowserTabId, closeBrowserTab } from '@/store/browser-tabs'
import { $sidebarOpen, setSidebarOpen, toggleFileBrowserOpen } from '@/store/layout'
import { $toolViewMode } from '@/store/tool-view'
import { useSkinCommand } from '@/themes/use-skin-command'

import { getSessionMessages, triggerCronJob } from '../alice'
import { formatRefValue } from '../components/assistant-ui/directive-text'
import { type ChatMessage, chatMessageText, preserveLocalAssistantErrors, toChatMessages } from '../lib/chat-messages'
import { storedSessionIdForNotification } from '../lib/session-ids'
import { latestSessionTodos } from '../lib/todos'
import { setCronFocusJobId } from '../store/cron'
import {
  $panesFlipped,
  $pinnedSessionIds,
  FILE_BROWSER_MAX_WIDTH,
  FILE_BROWSER_MIN_WIDTH,
  pinSession,
  restoreWorktree,
  unpinSession
} from '../store/layout'
import { respondToApprovalAction } from '../store/native-notifications'
import { setPetActivity } from '../store/pet'
import { setPetScale } from '../store/pet-gallery'
import {
  setPetOverlayOpenAppHandler,
  setPetOverlayScaleHandler,
  setPetOverlaySubmitHandler
} from '../store/pet-overlay'
import { $activeGatewayProfile, $freshSessionRequest, $profileScope, refreshActiveProfile } from '../store/profile'
import { $startWorkSessionRequest, followActiveSessionCwd, resolveNewSessionCwd } from '../store/projects'
import { $reviewOpen, REVIEW_PANE_ID, toggleReview } from '../store/review'
import {
  $activeSessionId,
  $attentionSessionIds,
  $currentCwd,
  $freshDraftReady,
  $gatewayState,
  $messages,
  $resumeExhaustedSessionId,
  $resumeFailedSessionId,
  $selectedStoredSessionId,
  $sessions,
  getRememberedSessionId,
  sessionPinId,
  setAwaitingResponse,
  setBusy,
  setCurrentBranch,
  setCurrentCwd,
  setMessages,
  setRememberedSessionId
} from '../store/session'
import { onSessionsChanged } from '../store/session-sync'
import { clearSessionTodos, setSessionTodos, todoListActive } from '../store/todos'
import { openUpdatesWindow, startUpdatePoller, stopUpdatePoller } from '../store/updates'
import { isSecondaryWindow } from '../store/windows'

import { ChatView } from './chat'
import { requestComposerFocus, requestComposerInsert } from './chat/composer/focus'
import { useComposerActions } from './chat/hooks/use-composer-actions'
import { ChatSidebar } from './chat/sidebar'
import { useGatewayBoot } from './gateway/hooks/use-gateway-boot'
import { useGatewayRequest } from './gateway/hooks/use-gateway-request'
import { useKeybinds } from './hooks/use-keybinds'
import { SIDEBAR_COLLAPSE_MEDIA_QUERY } from './layout-constants'
import { RightSidebarPane } from './right-sidebar'
import { BrowserPane } from './right-sidebar/browser'
import { ReviewPane } from './right-sidebar/review'
import { $browserTabsOpen, $terminalAsRow, $terminalTakeover, setTerminalTakeover } from './right-sidebar/store'
import { TerminalPaneBody } from './right-sidebar/terminal/pane-body'
import { PersistentTerminal } from './right-sidebar/terminal/persistent'
import { closeActiveTerminal } from './right-sidebar/terminal/terminals'
import { CRON_ROUTE, NEW_CHAT_ROUTE, PROFILES_ROUTE, routeSessionId, sessionRoute, SETTINGS_ROUTE } from './routes'
import { useAliceConfig } from './session/hooks/use-alice-config'
import { useContextSuggestions } from './session/hooks/use-context-suggestions'
import { useCwdActions } from './session/hooks/use-cwd-actions'
import { useMessageStream } from './session/hooks/use-message-stream'
import { useModelControls } from './session/hooks/use-model-controls'
import { usePreviewRouting } from './session/hooks/use-preview-routing'
import { usePromptActions } from './session/hooks/use-prompt-actions'
import { useRouteResume } from './session/hooks/use-route-resume'
import { useSessionActions } from './session/hooks/use-session-actions'
import { useSessionFollow } from './session/hooks/use-session-follow'
import { useSessionListActions } from './session/hooks/use-session-list-actions'
import { useSessionStateCache } from './session/hooks/use-session-state-cache'
import { AppShell } from './shell/app-shell'
import { useOverlayRouting } from './shell/hooks/use-overlay-routing'
import { useStatusSnapshot } from './shell/hooks/use-status-snapshot'
import { MainPaneRoutes } from './shell/main-pane-routes'
import { ModelMenuPanel } from './shell/model-menu-panel'
import { OverlaysHost } from './shell/overlays-host'
import { RunningHead } from './shell/running-head'
import { Spine } from './shell/spine'
import type { StatusbarItem } from './shell/statusbar-controls'
import {
  $pinnedDrawers,
  closeOtherStudyDrawers,
  migrateStudyLayoutOnce,
  openPinnedDrawersOnce,
  reconcileStudyDrawersOnce,
  toggleDrawerPin
} from './shell/study-layout'
import type { TitlebarTool } from './shell/titlebar-controls'
import { useGroupRegistry } from './shell/use-group-registry'

const AgentsView = lazy(async () => ({ default: (await import('./agents')).AgentsView }))
const ArtifactsView = lazy(async () => ({ default: (await import('./artifacts')).ArtifactsView }))
const CommandCenterView = lazy(async () => ({ default: (await import('./command-center')).CommandCenterView }))
const CronView = lazy(async () => ({ default: (await import('./cron')).CronView }))
const StarmapView = lazy(async () => ({ default: (await import('./starmap')).StarmapView }))
const MessagingView = lazy(async () => ({ default: (await import('./messaging')).MessagingView }))
const ProfilesView = lazy(async () => ({ default: (await import('./profiles')).ProfilesView }))
migrateStudyLayoutOnce()
reconcileStudyDrawersOnce()
openPinnedDrawersOnce()

const SettingsView = lazy(async () => ({ default: (await import('./settings')).SettingsView }))
const SkillsView = lazy(async () => ({ default: (await import('./skills')).SkillsView }))

// Latest cron-job sessions surfaced in the collapsed "Cron jobs" section. The
// Cron sessions are written by a background scheduler tick (the desktop
// backend), so no user action signals the UI. Poll the bounded cron list on
// this cadence while the app is open + visible so new runs surface promptly
// instead of waiting for the next user-triggered refreshSessions().
const CRON_POLL_INTERVAL_MS = 60_000

export function DesktopController() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()

  // Task-scoped Help overlay (FAB bottom-right).
  const [helpOpen, setHelpOpen] = useState(false)
  // OpenClaw → Alice migration wizard (launched from the Help panel).
  const [migrationOpen, setMigrationOpen] = useState(false)

  const busyRef = useRef(false)
  const creatingSessionRef = useRef(false)

  const gatewayState = useStore($gatewayState)
  const activeSessionId = useStore($activeSessionId)
  const currentCwd = useStore($currentCwd)
  const freshDraftReady = useStore($freshDraftReady)
  const resumeFailedSessionId = useStore($resumeFailedSessionId)
  const resumeExhaustedSessionId = useStore($resumeExhaustedSessionId)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const profileScope = useStore($profileScope)
  const panesFlipped = useStore($panesFlipped)
  // Flipped layout mirrors the default: sessions sidebar → right, file
  // browser + preview rail → left. Same panes, swapped sides.
  const sidebarSide = panesFlipped ? 'right' : 'left'
  const railSide = panesFlipped ? 'left' : 'right'
  // Below SIDEBAR_COLLAPSE_BREAKPOINT_PX there's no room for a docked rail —
  // collapse both sidebars (without touching their stored open state) so the
  // hover-reveal overlay becomes the way in. Restores once it's wide again.
  const narrowViewport = useMediaQuery(SIDEBAR_COLLAPSE_MEDIA_QUERY)

  const routedSessionId = routeSessionId(location.pathname)
  const routeToken = `${location.pathname}:${location.search}:${location.hash}`
  const routeTokenRef = useRef(routeToken)
  routeTokenRef.current = routeToken
  const getRouteToken = useCallback(() => routeTokenRef.current, [])

  const {
    agentsOpen,
    chatOpen,
    closeOverlayToPreviousRoute,
    commandCenterInitialSection,
    commandCenterOpen,
    cronOpen,
    currentView,
    openAgents,
    openCommandCenterSection,
    overlayOpen,
    profilesOpen,
    settingsOpen,
    starmapOpen,
    toggleCommandCenter
  } = useOverlayRouting()


  // Delta cursor for the follow poll: the highest SQLite message id this
  // window has hydrated for a given stored session. Keyed by session so a
  // switch (or a compression rotation) falls back to a full hydrate.
  const tailCursorRef = useRef<{ lastId: number; sessionId: string } | null>(null)
  const pinnedDrawers = useStore($pinnedDrawers)
  const browserOpen = useStore($browserOpen)

  const titlebarToolGroups = useGroupRegistry<TitlebarTool>()
  const statusbarItemGroups = useGroupRegistry<StatusbarItem>()
  const setTitlebarToolGroup = titlebarToolGroups.set
  const setStatusbarItemGroup = statusbarItemGroups.set

  const {
    activeSessionIdRef,
    ensureSessionState,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  } = useSessionStateCache({
    activeSessionId,
    busyRef,
    selectedStoredSessionId,
    setAwaitingResponse,
    setBusy,
    setMessages
  })

  const { connectionRef, gatewayRef, requestGateway } = useGatewayRequest()

  // The native "close preview" menu/shortcut now targets the browser drawer's
  // active tab (Fase 3 absorbed the preview rail).
  useEffect(() => {
    const push = () => {
      window.aliceDesktop?.setPreviewShortcutActive?.(Boolean($browserOpen.get() && $activeBrowserTabId.get()))
    }

    push()

    const unsubscribers = [$browserOpen.listen(push), $activeBrowserTabId.listen(push)]

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    }
  }, [])

  useEffect(() => {
    startUpdatePoller()
    const unsubscribe = window.aliceDesktop?.onOpenUpdatesRequested?.(() => openUpdatesWindow())

    return () => {
      unsubscribe?.()
      stopUpdatePoller()
    }
  }, [])

  // Remember the open chat so a relaunch reopens it instead of an empty new-chat.
  useEffect(() => {
    if (routedSessionId) {
      setRememberedSessionId(routedSessionId)
    }
  }, [routedSessionId])

  // Restore that chat once, on cold start only (we're at the new-chat route and
  // haven't navigated yet). A dead/deleted id self-clears via the exhausted latch
  // below, so we never boot-loop into an error screen.
  const restoredLastSessionRef = useRef(false)
  useEffect(() => {
    if (restoredLastSessionRef.current) {
      return
    }

    restoredLastSessionRef.current = true
    const last = getRememberedSessionId()

    if (last && location.pathname === NEW_CHAT_ROUTE) {
      navigate(sessionRoute(last), { replace: true })
    }
  }, [location.pathname, navigate])

  useEffect(() => {
    if (resumeExhaustedSessionId && getRememberedSessionId() === resumeExhaustedSessionId) {
      setRememberedSessionId(null)
    }
  }, [resumeExhaustedSessionId])

  // Notification click: the main process already focused the window; jump to its
  // session. Notifications are tagged with the gateway *runtime* session id, but
  // the chat route is keyed by the *stored* id — navigating with the runtime id
  // resumes a non-existent stored session ("session not found") and strands the
  // user. Translate runtime -> stored before navigating.
  useEffect(() => {
    const unsubscribe = window.aliceDesktop?.onFocusSession?.(sessionId => {
      if (sessionId) {
        navigate(sessionRoute(storedSessionIdForNotification(sessionId, runtimeIdByStoredSessionIdRef.current)))
      }
    })

    return () => unsubscribe?.()
  }, [navigate, runtimeIdByStoredSessionIdRef])

  // Notification action button (Approve/Reject) — resolve in place, no navigation.
  useEffect(() => {
    const unsubscribe = window.aliceDesktop?.onNotificationAction?.(({ actionId, sessionId }) => {
      void respondToApprovalAction(sessionId ?? null, actionId)
    })

    return () => unsubscribe?.()
  }, [])

  // alice:// deep links (e.g. a docs "Send to App" button for an automation blueprint).
  // Build the equivalent /blueprint slash command from the payload and drop
  // it into the composer — the user reviews/edits, then sends; the agent (or
  // the shared command handler) creates the job. Signal readiness so a link
  // that arrived during boot is flushed exactly once.
  useEffect(() => {
    const unsubscribe = window.aliceDesktop?.onDeepLink?.(payload => {
      if (!payload || payload.kind !== 'blueprint' || !payload.name) {
        return
      }

      const slots = Object.entries(payload.params || {})
        .map(([k, v]) => {
          const sval = /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v

          return `${k}=${sval}`
        })
        .join(' ')

      const command = `/blueprint ${payload.name}${slots ? ' ' + slots : ''}`
      requestComposerInsert(command, { mode: 'block', target: 'main' })
      requestComposerFocus('main')
    })

    // Tell the main process the renderer is ready to receive deep links.
    void window.aliceDesktop?.signalDeepLinkReady?.()

    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'w' || (!event.metaKey && !event.ctrlKey)) {
        return
      }

      // Terminal focused: ⌘W closes the active terminal. Ctrl+W is left untouched
      // for the shell's werase, and nothing else may steal ⌘/Ctrl+W from a
      // focused terminal (so it never closes a preview tab out from under it).
      if (isFocusWithin('[data-terminal]')) {
        if (event.metaKey && !event.ctrlKey) {
          event.preventDefault()
          event.stopPropagation()
          closeActiveTerminal()
        }

        return
      }

      // Otherwise ⌘/Ctrl+W closes the active browser tab when the browser is
      // open. (The preview rail that used to own this shortcut was absorbed by
      // the browser drawer in Fase 3.)
      if ($browserOpen.get()) {
        const activeTabId = $activeBrowserTabId.get()

        if (activeTabId) {
          event.preventDefault()
          event.stopPropagation()
          closeBrowserTab(activeTabId)
        }
      }
    }

    const unsubscribe = window.aliceDesktop?.onClosePreviewRequested?.(() => {
      if ($browserOpen.get()) {
        const activeTabId = $activeBrowserTabId.get()

        if (activeTabId) {
          closeBrowserTab(activeTabId)
        }
      }
    })

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      unsubscribe?.()
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [])

  const {
    loadMoreMessagingForPlatform,
    loadMoreSessions,
    loadMoreSessionsForProfile,
    refreshCronJobs,
    refreshSessions
  } = useSessionListActions({ profileScope })

  // Another window mutated the shared session list (e.g. a chat started in the
  // pop-out). Re-pull so the sidebar reflects it. Pop-outs have no sidebar, so
  // only real windows bother.
  useEffect(() => {
    if (isSecondaryWindow()) {
      return
    }

    return onSessionsChanged(() => void refreshSessions().catch(() => undefined))
  }, [refreshSessions])

  // Sessions created/advanced by the messaging gateway live in another
  // process; this window only learns about them through the session list. Poll
  // while visible so rows (new WhatsApp/Telegram chats, titles, previews)
  // appear without a manual refresh or a session switch.
  useEffect(() => {
    if (isSecondaryWindow()) {
      return
    }

    const tick = () => {
      if (document.visibilityState === 'visible') {
        void refreshSessions().catch(() => undefined)
      }
    }

    const handle = window.setInterval(tick, 10_000)

    return () => window.clearInterval(handle)
  }, [refreshSessions])

  const toggleSelectedPin = useCallback(() => {
    const sessionId = $selectedStoredSessionId.get()

    if (!sessionId) {
      return
    }

    // Pin on the durable lineage-root id so the pin survives auto-compression.
    const session = $sessions.get().find(s => s.id === sessionId || s._lineage_root_id === sessionId)
    const pinId = session ? sessionPinId(session) : sessionId

    if ($pinnedSessionIds.get().includes(pinId)) {
      unpinSession(pinId)
    } else {
      pinSession(pinId)
    }
  }, [])

  const { inferenceStatus, statusSnapshot } = useStatusSnapshot(gatewayState, requestGateway)

  const updateActiveSessionRuntimeInfo = useCallback(
    (info: { branch?: string; cwd?: string }) => {
      const sessionId = activeSessionIdRef.current

      if (!sessionId) {
        return
      }

      updateSessionState(sessionId, state => ({
        ...state,
        branch: info.branch ?? state.branch,
        cwd: info.cwd ?? state.cwd
      }))
    },
    [activeSessionIdRef, updateSessionState]
  )

  const { refreshProjectBranch } = useCwdActions({
    activeSessionId,
    activeSessionIdRef,
    onSessionRuntimeInfo: updateActiveSessionRuntimeInfo,
    requestGateway
  })

  const { refreshAliceConfig, sttEnabled, voiceMaxRecordingSeconds } = useAliceConfig({
    activeSessionIdRef,
    refreshProjectBranch
  })

  const { refreshCurrentModel, selectModel, updateModelOptionsCache } = useModelControls({
    activeSessionId,
    queryClient,
    requestGateway
  })

  const openProviderSettings = useCallback(() => {
    navigate(`${SETTINGS_ROUTE}?tab=providers`)
  }, [navigate])

  const modelMenuContent = useMemo(
    () =>
      gatewayState === 'open' ? (
        <ModelMenuPanel
          gateway={gatewayRef.current || undefined}
          onSelectModel={selectModel}
          requestGateway={requestGateway}
        />
      ) : null,
    [gatewayRef, gatewayState, requestGateway, selectModel]
  )

  useContextSuggestions({
    activeSessionId,
    activeSessionIdRef,
    currentCwd,
    gatewayState,
    requestGateway
  })

  const hydrateFromStoredSession = useCallback(
    async (
      attempts = 1,
      storedSessionId = selectedStoredSessionIdRef.current,
      runtimeSessionId = activeSessionIdRef.current
    ) => {
      if (!storedSessionId || !runtimeSessionId) {
        return
      }

      const storedProfile = $sessions
        .get()
        .find(session => session.id === storedSessionId || session._lineage_root_id === storedSessionId)?.profile

      for (let index = 0; index < Math.max(1, attempts); index += 1) {
        try {
          const latest = await getSessionMessages(storedSessionId, storedProfile, undefined, undefined, {
            reasoning: $toolViewMode.get() === 'technical'
          })

          tailCursorRef.current = {
            lastId: latest.messages.reduce((max, message) => Math.max(max, Number(message.id ?? 0)), 0),
            sessionId: storedSessionId
          }
          const messages = toChatMessages(latest.messages)
          updateSessionState(
            runtimeSessionId,
            state => ({
              ...state,
              messages: preserveLocalAssistantErrors(messages, state.messages)
            }),
            storedSessionId
          )

          // Seed the status stack's todo group from history — but only while
          // the plan is still in flight, so reopening an old chat doesn't pin
          // its finished todo list above the composer forever.
          const todos = latestSessionTodos(messages)

          if (todos && todoListActive(todos)) {
            setSessionTodos(runtimeSessionId, todos)
          } else {
            clearSessionTodos(runtimeSessionId)
          }

          return
        } catch {
          // Best-effort fallback when live stream payloads are empty.
        }

        if (index < attempts - 1) {
          await new Promise(resolve => window.setTimeout(resolve, 250))
        }
      }
    },
    [activeSessionIdRef, selectedStoredSessionIdRef, updateSessionState]
  )

  // Delta hydration for the follow poll. Re-reading the whole transcript on
  // every 2s tick is what made a 739-message session cost 2.8 MB per poll;
  // asking for rows after our cursor drops that to the bytes the sibling
  // process actually wrote. Falls back to the full hydrate when:
  //   - we have no cursor for this session (first load, after a switch),
  //   - the delta starts on a `tool` row (its assistant call landed in the
  //     previous batch, and the tool-part merger expects the pair together),
  //   - anything throws.
  const hydrateTail = useCallback(
    async (storedSessionId: string, runtimeSessionId: null | string) => {
      const cursor = tailCursorRef.current

      if (!runtimeSessionId || !cursor || cursor.sessionId !== storedSessionId || !cursor.lastId) {
        await hydrateFromStoredSession(1, storedSessionId, runtimeSessionId)

        return
      }

      const storedProfile = $sessions
        .get()
        .find(session => session.id === storedSessionId || session._lineage_root_id === storedSessionId)?.profile

      try {
        const delta = await getSessionMessages(storedSessionId, storedProfile, undefined, undefined, {
          reasoning: $toolViewMode.get() === 'technical',
          sinceId: cursor.lastId
        })

        if (!delta.messages.length) {
          return
        }

        if (delta.messages[0]?.role === 'tool') {
          await hydrateFromStoredSession(1, storedSessionId, runtimeSessionId)

          return
        }

        updateSessionState(
          runtimeSessionId,
          state => ({
            ...state,
            messages: preserveLocalAssistantErrors(
              [...state.messages, ...toChatMessages(delta.messages)],
              state.messages
            )
          }),
          storedSessionId
        )

        const lastId =
          delta.last_id ??
          delta.messages.reduce((max, message) => Math.max(max, Number(message.id ?? 0)), cursor.lastId)

        tailCursorRef.current = { lastId, sessionId: storedSessionId }
      } catch {
        await hydrateFromStoredSession(1, storedSessionId, runtimeSessionId)
      }
    },
    [hydrateFromStoredSession, updateSessionState]
  )

  const { handleGatewayEvent } = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession,
    queryClient,
    refreshAliceConfig,
    refreshSessions,
    sessionStateByRuntimeIdRef,
    updateSessionState
  })

  // A sibling process (the messaging gateway) can advance the selected
  // session while this window only sees SQLite. Follow the stored row so the
  // transcript updates without a session switch.
  useSessionFollow({
    activeSessionIdRef,
    busyRef,
    hydrateFromStoredSession,
    hydrateTail,
    requestGateway,
    sessionStateByRuntimeIdRef,
    selectedStoredSessionId
  })

  const { handleDesktopGatewayEvent } = usePreviewRouting({
    activeSessionIdRef,
    baseHandleGatewayEvent: handleGatewayEvent
  })

  const {
    archiveSession,
    branchCurrentSession,
    branchStoredSession,
    createBackendSessionForSend,
    openSettings,
    removeSession,
    resumeSession,
    selectSidebarItem,
    startFreshSessionDraft
  } = useSessionActions({
    activeSessionId,
    activeSessionIdRef,
    busyRef,
    creatingSessionRef,
    ensureSessionState,
    getRouteToken,
    navigate,
    requestGateway,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionId,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  })

  // Single global listener for every rebindable hotkey (incl. profile switching)
  // plus the on-screen keybind editor's capture mode.
  useKeybinds({
    startFreshSession: startFreshSessionDraft,
    toggleCommandCenter,
    toggleSelectedPin
  })

  // A profile switch/create drops to a fresh new-session draft so the previously
  // open session doesn't bleed across contexts. Skip the initial value.
  const freshSessionRequest = useStore($freshSessionRequest)
  const lastFreshRef = useRef(freshSessionRequest)

  useEffect(() => {
    if (freshSessionRequest === lastFreshRef.current) {
      return
    }

    lastFreshRef.current = freshSessionRequest
    startFreshSessionDraft()
  }, [freshSessionRequest, startFreshSessionDraft])

  // Swapping the live gateway to another profile must re-pull that profile's
  // global model + active-profile pill. Both are nanostores, so the blanket
  // invalidateQueries() the profile store fires on swap doesn't touch them —
  // without this the statusbar keeps showing the previous profile's model
  // (the "forgets the LLM setting" report). gatewayState stays 'open' across a
  // swap (background sockets persist), so the open→open effect won't re-run.
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const lastGatewayProfileRef = useRef(activeGatewayProfile)

  useEffect(() => {
    if (activeGatewayProfile === lastGatewayProfileRef.current) {
      return
    }

    lastGatewayProfileRef.current = activeGatewayProfile
    // Force: the new profile has its own default, so reseed even if the composer
    // already shows the previous profile's model.
    void refreshCurrentModel(true)
    void refreshActiveProfile()
  }, [activeGatewayProfile, refreshCurrentModel])

  const composer = useComposerActions({
    activeSessionId,
    currentCwd,
    requestGateway
  })

  const branchInNewChat = useCallback(
    async (messageId?: string) => {
      const branched = await branchCurrentSession(messageId)

      if (branched) {
        await refreshSessions().catch(() => undefined)
      }

      return branched
    },
    [branchCurrentSession, refreshSessions]
  )

  // Clear a failed turn's red error banner from the transcript. Errors are
  // renderer-local state (never persisted), so dismissing is purely a view +
  // session-cache edit. A message that errored before emitting any visible
  // text is a bare error placeholder → drop it entirely; one that streamed
  // partial output then failed keeps its content and just sheds the error.
  // Both the per-runtime cache AND the live $messages view must be updated:
  // `preserveLocalAssistantErrors` re-grafts any still-errored message it
  // finds in the view onto the next session.info flush, so clearing only the
  // cache would let the heartbeat resurrect the banner.
  const dismissError = useCallback(
    (messageId: string) => {
      const runtimeSessionId = activeSessionIdRef.current

      if (!runtimeSessionId) {
        return
      }

      const clearErrorIn = (messages: ChatMessage[]): ChatMessage[] =>
        messages.flatMap(message => {
          if (message.id !== messageId || !message.error) {
            return [message]
          }

          if (!chatMessageText(message).trim() && !message.parts.some(part => part.type !== 'text')) {
            return []
          }

          return [{ ...message, error: undefined, pending: false }]
        })

      // View first: the flush below reads $messages as the "current" baseline
      // for error preservation, so the banner must be gone from it before the
      // cache update triggers a re-sync.
      setMessages(clearErrorIn($messages.get()))

      updateSessionState(runtimeSessionId, state => ({
        ...state,
        messages: clearErrorIn(state.messages)
      }))
    },
    [activeSessionIdRef, updateSessionState]
  )

  const startSessionInWorkspace = useCallback(
    (path: null | string) => {
      startFreshSessionDraft()

      // A worktree lane carries its own path; the trunk "+" can be path-less (the
      // main checkout is implicit), so fall back to the active project's root
      // instead of no-op'ing on null — that was "+ on main does nothing".
      const target = path?.trim() || resolveNewSessionCwd()

      if (!target) {
        return
      }

      // The next message creates the backend session in $currentCwd, so seed
      // it (and the branch) from the workspace the user clicked the + on.
      setCurrentCwd(target)
      void requestGateway<{ branch?: string; cwd?: string }>('config.get', { key: 'project', cwd: target })
        .then(info => {
          const resolved = info.cwd || target

          setCurrentCwd(resolved)
          setCurrentBranch(info.branch || '')

          // An EXPLICIT target (a worktree/lane path — e.g. just-created via
          // "convert a branch" / "new worktree") drills the sidebar into that
          // project so the new lane is visible at once. Without this, a brand-new
          // worktree session is invisible from the all-projects overview (the
          // live overlay skips `.worktrees` rows, and the session.info cwd-follow
          // only fires on a same-session move, not a fresh session). The
          // path-less trunk "+" keeps the current scope untouched.
          if (path?.trim()) {
            restoreWorktree(resolved)
            void followActiveSessionCwd(resolved)
          }
        })
        .catch(() => undefined)
    },
    [requestGateway, startFreshSessionDraft]
  )

  // Composer "branch off into a new worktree": the composer already created the
  // worktree and cleared its draft; open a fresh session anchored to that tree,
  // then prefill the task that kicked it off. startSessionInWorkspace owns the
  // reset+cwd seed (it runs startFreshSessionDraft, which would otherwise stomp
  // the cwd back to the default), so the prefill is dispatched right after — its
  // deferred event lands once the fresh composer has remounted and rebound.
  const startWorkSessionRequest = useStore($startWorkSessionRequest)
  const lastStartWorkTokenRef = useRef(startWorkSessionRequest?.token ?? 0)

  useEffect(() => {
    if (!startWorkSessionRequest || startWorkSessionRequest.token === lastStartWorkTokenRef.current) {
      return
    }

    lastStartWorkTokenRef.current = startWorkSessionRequest.token
    startSessionInWorkspace(startWorkSessionRequest.path)

    if (startWorkSessionRequest.draft) {
      requestComposerInsert(startWorkSessionRequest.draft, { target: 'main' })
    }
  }, [startSessionInWorkspace, startWorkSessionRequest])

  const handleSkinCommand = useSkinCommand()

  const {
    cancelRun,
    editMessage,
    handleThreadMessagesChange,
    reloadFromMessage,
    restoreToMessage,
    steerPrompt,
    submitText,
    transcribeVoiceAudio
  } = usePromptActions({
    activeSessionId,
    activeSessionIdRef,
    branchCurrentSession: branchInNewChat,
    busyRef,
    createBackendSessionForSend,
    handleSkinCommand,
    refreshSessions,
    requestGateway,
    resumeStoredSession: resumeSession,
    selectedStoredSessionIdRef,
    startFreshSessionDraft,
    sttEnabled,
    updateSessionState
  })

  // The popped-out pet drives two actions back into the app: send a prompt, and
  // open the most recent thread. Both are registered ONCE through refs that track
  // the latest callbacks — re-registering on every `submitText`/`resumeSession`
  // identity change left a brief window where the handler was nulled (cleanup
  // before re-register), which could drop a submit fired from the overlay (e.g.
  // creating a session from the new-session screen). The ref form keeps a stable,
  // always-current handler. Primary window only — it owns the overlay.
  const submitTextRef = useRef(submitText)
  submitTextRef.current = submitText
  const resumeSessionRef = useRef(resumeSession)
  resumeSessionRef.current = resumeSession
  const requestGatewayRef = useRef(requestGateway)
  requestGatewayRef.current = requestGateway

  useEffect(() => {
    if (isSecondaryWindow()) {
      return
    }

    setPetOverlaySubmitHandler(text => void submitTextRef.current(text))
    // Alt+wheel resize from the popped-out pet — persist it through this
    // window's gateway (the overlay has none) so it survives restart.
    setPetOverlayScaleHandler(scale => setPetScale(requestGatewayRef.current, scale))
    // Mail icon: $sessions is ordered most-recent-first; the pet is global (not
    // per session) so "most recent" is the right target. main.cjs already raised
    // the window before forwarding this.
    setPetOverlayOpenAppHandler(() => {
      const recent = $sessions.get()[0]

      if (recent?.id) {
        void resumeSessionRef.current(recent.id)
      }
    })

    return () => {
      setPetOverlaySubmitHandler(null)
      setPetOverlayOpenAppHandler(null)
      setPetOverlayScaleHandler(null)
    }
  }, [])

  // Mirror "a session is blocked on the user" (clarify/approval) into the pet's
  // awaitingInput flag so it shows the `waiting` pose. Lives on $petActivity so
  // it rides the same atom the pop-out overlay mirrors — no session list needed
  // there. Every window keeps its own in-window pet in sync.
  useEffect(() => {
    const sync = () => setPetActivity({ awaitingInput: $attentionSessionIds.get().length > 0 })

    sync()

    return $attentionSessionIds.listen(sync)
  }, [])

  useGatewayBoot({
    handleGatewayEvent: handleDesktopGatewayEvent,
    onConnectionReady: c => {
      connectionRef.current = c
    },
    onGatewayReady: g => {
      gatewayRef.current = g
    },
    refreshAliceConfig,
    refreshSessions
  })

  useEffect(() => {
    if (gatewayState === 'open') {
      void refreshCurrentModel()
      void refreshActiveProfile()
      void refreshSessions().catch(() => undefined)
    }
  }, [gatewayState, refreshCurrentModel, refreshSessions])

  // Keep the cron jobs section live without a user action: the scheduler ticks
  // in the background (advancing next-run/state and creating runs), so poll the
  // job list on an interval (and on tab re-focus) while connected.
  useEffect(() => {
    if (gatewayState !== 'open') {
      return
    }

    const tick = () => {
      if (document.visibilityState === 'visible') {
        void refreshCronJobs()
      }
    }

    const intervalId = window.setInterval(tick, CRON_POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', tick)

    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [gatewayState, refreshCronJobs])

  useEffect(() => {
    if (gatewayState === 'open' && !activeSessionId && freshDraftReady) {
      void refreshCurrentModel()
      void refreshAliceConfig()
    }
  }, [activeSessionId, freshDraftReady, gatewayState, refreshCurrentModel, refreshAliceConfig])

  useRouteResume({
    activeSessionId,
    activeSessionIdRef,
    creatingSessionRef,
    currentView,
    freshDraftReady,
    gatewayState,
    locationPathname: location.pathname,
    resumeSession,
    resumeFailedSessionId,
    resumeExhaustedSessionId,
    routedSessionId,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionId,
    selectedStoredSessionIdRef,
    startFreshSessionDraft
  })


  // Stable identities so <ChatSidebar> (memoized in its module) bails out when
  // a pane toggle re-renders this composition root. Rebuilding the session tree
  // on every terminal/git/browser click is what made the UI feel like a reload.
  const sidebarHandlers = useMemo(
    () => ({
      onArchiveSession: (sessionId: string) => void archiveSession(sessionId),
      onBranchSession: (sessionId: string) => void branchStoredSession(sessionId),
      onDeleteSession: (sessionId: string) => void removeSession(sessionId),
      onLoadMoreMessaging: loadMoreMessagingForPlatform,
      onLoadMoreProfileSessions: loadMoreSessionsForProfile,
      onLoadMoreSessions: loadMoreSessions,
      onManageCronJob: (jobId: string) => {
        setCronFocusJobId(jobId)
        navigate(CRON_ROUTE)
      },
      onNavigate: selectSidebarItem,
      onNewSessionInWorkspace: startSessionInWorkspace,
      onResumeSession: (sessionId: string) => navigate(sessionRoute(sessionId)),
      onTriggerCronJob: (jobId: string) => {
        void triggerCronJob(jobId)
          .then(() => refreshCronJobs())
          .catch(() => undefined)
      }
    }),
    [
      archiveSession,
      branchStoredSession,
      loadMoreMessagingForPlatform,
      loadMoreSessions,
      loadMoreSessionsForProfile,
      navigate,
      refreshCronJobs,
      removeSession,
      selectSidebarItem,
      startSessionInWorkspace
    ]
  )

  const sidebar = useMemo(
    () => <ChatSidebar catalogMode currentView={currentView} {...sidebarHandlers} />,
    [currentView, sidebarHandlers]
  )

  const spine = useMemo(
    () => (
      <Spine
        onBrowser={() => {
          const next = !$browserOpen.get()
          closeOtherStudyDrawers('browser')
          setBrowserOpen(next)
        }}
        onCatalog={() => {
          const next = !$sidebarOpen.get()
          closeOtherStudyDrawers('sessions')
          setSidebarOpen(next)
        }}
        onFiles={() => {
          closeOtherStudyDrawers('files')
          toggleFileBrowserOpen()
        }}
        onNewSession={() => startFreshSessionDraft()}
        onProfiles={() => navigate(PROFILES_ROUTE)}
        onReview={() => {
          closeOtherStudyDrawers('review')
          toggleReview()
        }}
        onSettings={openSettings}
        onTerminal={() => {
          closeOtherStudyDrawers('terminal')
          setTerminalTakeover(!$terminalTakeover.get())
        }}
      />
    ),
    [navigate, openSettings, startFreshSessionDraft]
  )

  const runningHead = useMemo(
    () => (
      <RunningHead
        onDeleteSession={() => {
          if (selectedStoredSessionId) {
            void removeSession(selectedStoredSessionId)
          }
        }}
        onTogglePin={toggleSelectedPin}
      />
    ),
    [openSettings, removeSession, selectedStoredSessionId, toggleSelectedPin]
  )

  // The persistent xterm layer (one host per terminal tab), CSS-overlaid onto the
  // pane's <TerminalSlot />. Lives in main's stacking context (not the root overlay
  // layer) so pane resize handles still paint above it. Terminals own their state
  // (incl. a snapshotted cwd) independent of the session, so switching sessions
  // never rebuilds or closes them; toggling the pane never rebuilds the shells.
  const mainOverlays = useMemo(
    () => <PersistentTerminal onAddSelectionToChat={composer.addTerminalSelectionAttachment} />,
    [composer.addTerminalSelectionAttachment]
  )

  const overlays = useMemo(
    () => (
      <OverlaysHost
        agentsOpen={agentsOpen}
        closeOverlayToPreviousRoute={closeOverlayToPreviousRoute}
        commandCenterInitialSection={commandCenterInitialSection}
        commandCenterOpen={commandCenterOpen}
        cronOpen={cronOpen}
        gateway={gatewayRef.current || undefined}
        gatewayState={gatewayState}
        helpOpen={helpOpen}
        migrationOpen={migrationOpen}
        navigate={navigate}
        openProviderSettings={openProviderSettings}
        profilesOpen={profilesOpen}
        refreshAliceConfig={refreshAliceConfig}
        refreshCurrentModel={refreshCurrentModel}
        removeSession={removeSession}
        requestGateway={requestGateway}
        resumeSession={resumeSession}
        selectModel={selectModel}
        setHelpOpen={setHelpOpen}
        setMigrationOpen={setMigrationOpen}
        settingsOpen={settingsOpen}
        starmapOpen={starmapOpen}
        updateModelOptionsCache={updateModelOptionsCache}
      />
    ),
    [
      agentsOpen,
      closeOverlayToPreviousRoute,
      commandCenterInitialSection,
      commandCenterOpen,
      cronOpen,
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
      settingsOpen,
      starmapOpen,
      updateModelOptionsCache
    ]
  )

  // The chat element is memoized on the values that can actually change its
  // output. Pane state (open/closed, preview target, sash widths) is deliberately
  // NOT a dependency: a pane toggle re-renders this composition root, and a fresh
  // <ChatView> element would re-render the whole transcript and defeat
  // ChatRuntimeBoundary's element-identity bailout. With a stable element React
  // skips the chat subtree entirely on those re-renders.
  const chatView = useMemo(
    () => (
      <ChatView
        gateway={gatewayRef.current}
        maxVoiceRecordingSeconds={voiceMaxRecordingSeconds}
        modelMenuContent={modelMenuContent}
        onAddContextRef={composer.addContextRefAttachment}
        onAddUrl={url => composer.addContextRefAttachment(`@url:${formatRefValue(url)}`, url)}
        onAttachDroppedItems={composer.attachDroppedItems}
        onAttachImageBlob={composer.attachImageBlob}
        onBranchInNewChat={branchInNewChat}
        onCancel={cancelRun}
        onDeleteSelectedSession={() => {
          if (selectedStoredSessionId) {
            void removeSession(selectedStoredSessionId)
          }
        }}
        onDismissError={dismissError}
        onEdit={editMessage}
        onPasteClipboardImage={opts => composer.pasteClipboardImage(opts)}
        onPickFiles={() => void composer.pickContextPaths('file')}
        onPickFolders={() => void composer.pickContextPaths('folder')}
        onPickImages={() => void composer.pickImages()}
        onReload={reloadFromMessage}
        onRemoveAttachment={id => void composer.removeAttachment(id)}
        onRestoreToMessage={restoreToMessage}
        onRetryResume={sessionId => void resumeSession(sessionId, true)}
        onSteer={steerPrompt}
        onSubmit={submitText}
        onThreadMessagesChange={handleThreadMessagesChange}
        onToggleSelectedPin={toggleSelectedPin}
        onTranscribeAudio={transcribeVoiceAudio}
      />
    ),
    [
      branchInNewChat,
      cancelRun,
      composer.addContextRefAttachment,
      composer.attachDroppedItems,
      composer.attachImageBlob,
      composer.pasteClipboardImage,
      composer.pickContextPaths,
      composer.pickImages,
      composer.removeAttachment,
      dismissError,
      editMessage,
      gatewayRef,
      handleThreadMessagesChange,
      modelMenuContent,
      reloadFromMessage,
      removeSession,
      resumeSession,
      restoreToMessage,
      selectedStoredSessionId,
      steerPrompt,
      submitText,
      toggleSelectedPin,
      transcribeVoiceAudio,
      voiceMaxRecordingSeconds
    ]
  )

  const fileBrowserPane = useMemo(
    () => (
    <Pane
      defaultOpen={false}
      disabled={!chatOpen}
      drawer
      drawerWidth={380}
      id="file-browser"
      key="file-browser"
      maxWidth={FILE_BROWSER_MAX_WIDTH}
      minWidth={FILE_BROWSER_MIN_WIDTH}
      onTogglePin={() => toggleDrawerPin('files')}
      pinned={pinnedDrawers.includes('files')}
      resizable
      side="right"
    >
      {/* Key on the project (cwd) so switching projects unmounts the old tree and
          mounts a fresh one straight into its skeleton — no stale-then-blip. */}
      <RightSidebarPane
        key={currentCwd || 'no-cwd'}
        onActivateFile={path => composer.insertContextPathInlineRef(path)}
        onActivateFolder={path => composer.insertContextPathInlineRef(path, true)}
      />
    </Pane>
  
    ),
    [chatOpen, narrowViewport, railSide, currentCwd, composer.insertContextPathInlineRef, pinnedDrawers]
  )

  const reviewPane = useMemo(
    () => (
    <Pane
      defaultOpen
      // The diff pane only makes sense in a workspace, so force it shut when the
      // session is detached — "No diffs" then only ever shows inside a project,
      // never as a second empty panel next to the file browser.
      // Docked (wide): `reviewOpen` gates it. Narrow: drop `reviewOpen` from the
      // gate so the pane stays mounted as a collapsed overlay — `toggleReview`
      // then slides it in/out via the forced-reveal pin, exactly like ⌘B for the
      // sidebar. Still requires a repo (no diffs to show otherwise).
      disabled={!chatOpen || !currentCwd.trim()}
      drawer
      drawerWidth={390}
      id={REVIEW_PANE_ID}
      key="review"
      maxWidth={FILE_BROWSER_MAX_WIDTH}
      minWidth={FILE_BROWSER_MIN_WIDTH}
      onTogglePin={() => toggleDrawerPin('review')}
      openAtom={$reviewOpen}
      pinned={pinnedDrawers.includes('review')}
      resizable
      // Mobile overlay sits at its min width — compact, doesn't bury the chat.
      side="right"
    >
      <ReviewPane key={currentCwd || 'no-cwd'} />
    </Pane>
  
    ),
    [chatOpen, currentCwd, pinnedDrawers]
  )

  const browserPane = useMemo(
    () => (
    <Pane
      defaultOpen
      id="browser-tabs"
      key="browser-tabs"
      maxWidth={FILE_BROWSER_MAX_WIDTH}
      minWidth={220}
      openAtom={$browserTabsOpen}
      resizable
      side={railSide}
      width={320}
    >
      <BrowserPane />
    </Pane>
  
    ),
    [railSide]
  )

  const terminalPane = useMemo(
    () => (
    <Pane
      bottomRowAtom={$terminalAsRow}
      defaultOpen
      disabled={!chatOpen}
      divider
      drawer
      drawerWidth={560}
      height="38vh"
      id="terminal-sidebar"
      key="terminal-sidebar"
      maxHeight="80vh"
      maxWidth="80vw"
      minHeight="8rem"
      minWidth="22vw"
      onTogglePin={() => toggleDrawerPin('terminal')}
      openAtom={$terminalTakeover}
      pinned={pinnedDrawers.includes('terminal')}
      resizable
      side="right"
    >
      <TerminalPaneBody />
    </Pane>
  
    ),
    [chatOpen, pinnedDrawers]
  )

  return (
    <AppShell
      mainOverlays={mainOverlays}
      onOpenSettings={openSettings}
      overlays={overlays}
      runningHead={runningHead}
      spine={spine}
    >
      {!isSecondaryWindow() && (
        <Pane
          drawer
          drawerWidth={540}
          id="chat-sidebar"
          maxWidth={720}
          minWidth={280}
          onTogglePin={() => toggleDrawerPin('sessions')}
          openAtom={$sidebarOpen}
          pinned={pinnedDrawers.includes('sessions')}
          resizable
          side="left"
          warmOnIdle
        >
          {sidebar}
        </Pane>
      )}
      {!isSecondaryWindow() && (
        <Pane
          drawer
          drawerWidth={720}
          id="browser"
          maxWidth={1100}
          minWidth={360}
          openAtom={$browserOpen}
          side="left"
        >
          <NativeBrowserPane visible={browserOpen && chatOpen && !overlayOpen} />
        </Pane>
      )}
      <PaneMain>
        <MainPaneRoutes
          chat={chatView}
          chatVisible={chatOpen || overlayOpen}
          pages={{
            artifacts: (
              <Suspense fallback={null}>
                <ArtifactsView setStatusbarItemGroup={setStatusbarItemGroup} />
              </Suspense>
            ),
            messaging: (
              <Suspense fallback={null}>
                <MessagingView setStatusbarItemGroup={setStatusbarItemGroup} />
              </Suspense>
            ),
            skills: (
              <Suspense fallback={null}>
                <SkillsView setStatusbarItemGroup={setStatusbarItemGroup} />
              </Suspense>
            )
          }}
        />
      </PaneMain>
      {/*
        Order within a side maps to column order. Default (rail on the right):
        main | terminal | file-browser. Flipped (rail on the left): mirror to
        file-browser | terminal | main so terminal stays adjacent to the chat.
        The preview rail that used to sit between terminal and file-browser was
        absorbed by the browser drawer (left side) in Fase 3.
      */}
      {panesFlipped ? fileBrowserPane : terminalPane}
      {browserPane}
      {reviewPane}
      {panesFlipped ? terminalPane : fileBrowserPane}
    </AppShell>
  )
}
