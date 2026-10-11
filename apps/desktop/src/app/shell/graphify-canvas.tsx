import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { isWailsShell } from '@/lib/desktop-capabilities'
import { $currentCwd } from '@/store/session'
import { closeGraphify, setChatView } from '@/store/graphify'

// Fullscreen graphify view. The same content the right-rail `GraphifyPane`
// loads as an iframe, lifted into the chat shell when the user flips the
// `chat-view` toggle to 'graph'. We re-implement the URL derivation here
// (instead of importing the pane) so this view is independent of the
// right-rail's open/close state and doesn't double-mount the iframe.
export function GraphifyCanvas({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const currentCwd = useStore($currentCwd).trim()
  const graphPath = currentCwd ? `file://${currentCwd}/graphify-out/graph.html` : null
  const graphFilePath = currentCwd ? `${currentCwd}/graphify-out/graph.html` : null

  // In Wails, file:// is blocked by WebKit's Same-Origin Policy (the app
  // origin is wails://localhost). Read the HTML via Go and render via srcDoc.
  const wails = isWailsShell()
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!wails || !graphFilePath) {
      setSrcDoc(null)
      return
    }
    let cancelled = false
    setLoading(true)
    window.aliceDesktop?.readFileText?.(graphFilePath)
      .then(result => {
        if (!cancelled) setSrcDoc(result?.text ?? null)
      })
      .catch(() => {
        if (!cancelled) setSrcDoc(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [wails, graphFilePath])

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-(--ui-sidebar-surface-background)">
      <div className="flex items-center justify-between gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Codicon className="text-muted-foreground" name="type-hierarchy" size="0.875rem" />
          <span className="truncate text-sm font-medium">Graphify</span>
          {currentCwd ? (
            <span className="truncate font-mono text-[0.7rem] text-muted-foreground">
              {currentCwd}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Tip label={t.common?.close ?? 'Close'}>
            <Button
              aria-label="Back to chat"
              className="size-6"
              onClick={() => {
                setChatView('chat')
                onClose()
              }}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name="close" size="0.75rem" />
            </Button>
          </Tip>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {!currentCwd ? (
          <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
            <div>
              <Codicon className="mx-auto mb-2 opacity-60" name="type-hierarchy" size="1.5rem" />
              <p>No workspace open — graphify needs an active session cwd.</p>
              <p className="mt-1 text-xs">
                Open a project or session to view its graph.
              </p>
            </div>
          </div>
        ) : wails ? (
          // Wails shell: file:// is blocked by WebKit; serve HTML via Go.
          loading ? (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              Loading graph…
            </div>
          ) : srcDoc ? (
            <iframe
              aria-label="Graphify"
              className="size-full border-0"
              sandbox="allow-scripts allow-same-origin"
              srcDoc={srcDoc}
              title="Graphify"
            />
          ) : (
            <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
              <div>
                <Codicon className="mx-auto mb-2 opacity-60" name="type-hierarchy" size="1.5rem" />
                <p>No graph yet — ask Alice to run graphify.</p>
              </div>
            </div>
          )
        ) : (
          // Electron shell: file:// URL works natively.
          <iframe
            aria-label="Graphify"
            className="size-full border-0"
            src={graphPath ?? undefined}
            title="Graphify"
          />
        )}
      </div>
    </div>
  )
}

// Re-export for callers that import from this module.
export { closeGraphify, setChatView }
