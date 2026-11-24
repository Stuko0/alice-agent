import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { NEW_CHAT_ROUTE, sessionRoute } from '../routes'

function LegacySessionRedirect() {
  const { sessionId } = useParams()

  return <Navigate replace to={sessionId ? sessionRoute(sessionId) : NEW_CHAT_ROUTE} />
}

/**
 * The main column's router.
 *
 * The chat lives OUTSIDE `<Routes>` on purpose: overlay routes (settings,
 * command center, agents, profiles, cron, starmap) used to match `element={null}`
 * and therefore unmounted the whole chat surface. Closing such an overlay with
 * its (X) then remounted `ChatView` — a full transcript rebuild — and re-ran the
 * route-resume effect. Keeping the chat mounted (hidden behind the opaque
 * overlay) makes closing instant and preserves scroll, drafts and the terminal.
 *
 * Page routes (`skills` / `messaging` / `artifacts`) still replace the chat, but
 * they hide it instead of tearing it down: switching back is a repaint.
 */
export function MainPaneRoutes({
  chat,
  chatVisible,
  pages
}: {
  chat: ReactNode
  /** Overlay routes keep the chat painted underneath their opaque card. */
  chatVisible: boolean
  pages: { artifacts: ReactNode; messaging: ReactNode; skills: ReactNode }
}) {
  return (
    <>
      <div className={chatVisible ? 'contents' : 'hidden'} data-slot="chat-host">
        {chat}
      </div>
      <Routes>
        <Route element={pages.skills} path="skills" />
        <Route element={pages.messaging} path="messaging" />
        <Route element={pages.artifacts} path="artifacts" />
        {/* Overlay views render from the `overlays` layer; the route exists only
            so the chat host stays matched. */}
        <Route element={null} path="settings" />
        <Route element={null} path="command-center" />
        <Route element={null} path="agents" />
        <Route element={null} path="profiles" />
        <Route element={null} path="cron" />
        <Route element={null} path="starmap" />
        {/* Session + new-chat routes: the chat host is already rendered above. */}
        <Route element={null} index />
        <Route element={null} path=":sessionId" />
        <Route element={<LegacySessionRedirect />} path="sessions/:sessionId" />
        <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="*" />
      </Routes>
    </>
  )
}
