import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $chatView, chatViewAfterSessionChange, setChatView } from '@/store/graphify'

import { GraphifyCanvas } from '../shell/graphify-canvas'

const HIDDEN = 'hidden'
// `display: contents` keeps the wrapper out of the layout tree when visible, so
// the chat column's flex/grid parent sees the children exactly as before.
const VISIBLE = 'contents'

/**
 * Swaps the chat body for the session's graphify HTML without unmounting either
 * side. Unmounting the chat lost the transcript DOM (and forced a full re-render
 * on return); unmounting the canvas re-read a multi-MB document on every flip.
 * The canvas mounts lazily on the first graph open, then stays mounted (hidden).
 */
export function ChatViewSwitch({
  activeSessionId,
  children
}: {
  activeSessionId: null | string
  children: React.ReactNode
}) {
  const view = useStore($chatView)
  const [graphMounted, setGraphMounted] = useState(view === 'graph')

  useEffect(() => {
    if (view === 'graph') {
      setGraphMounted(true)
    }
  }, [view])

  // Remember the id this view last rendered for. A resume publishes
  // null → runtime id, which is NOT a session switch.
  const [previousSessionId, setPreviousSessionId] = useState<null | string>(activeSessionId)

  useEffect(() => {
    const next = chatViewAfterSessionChange(view, previousSessionId, activeSessionId)

    setPreviousSessionId(activeSessionId)

    if (next !== view) {
      setChatView(next)
    }
    // Intentionally keyed on the session id only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  const graphVisible = view === 'graph'

  return (
    <>
      <div className={graphVisible ? HIDDEN : VISIBLE}>{children}</div>
      {graphMounted ? (
        <div className={graphVisible ? VISIBLE : HIDDEN}>
          <GraphifyCanvas onClose={() => setChatView('chat')} />
        </div>
      ) : null}
    </>
  )
}
