import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { isWailsShell } from '@/lib/desktop-capabilities'
import { $panesFlipped } from '@/store/layout'
import { $currentCwd } from '@/store/session'
import { closeGraphify } from '@/store/graphify'

import { SidebarPanelLabel } from '../../shell/sidebar-label'
import { PaneEmptyState, RightSidebarSectionHeader } from '../index'

export function GraphifyPane() {
  const { t } = useI18n()
  const panesFlipped = useStore($panesFlipped)
  const currentCwd = useStore($currentCwd).trim()

  // The path will be file://.../graphify-out/graph.html
  const graphPath = currentCwd ? `file://${currentCwd}/graphify-out/graph.html` : undefined
  const graphFilePath = currentCwd ? `${currentCwd}/graphify-out/graph.html` : undefined

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
    <aside
      aria-label="Graphify"
      className={cn(
        'before:pointer-events-none relative flex h-full w-full min-w-0 flex-col overflow-hidden border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) pt-(--titlebar-height) text-(--ui-text-tertiary)',
        panesFlipped
          ? 'border-r shadow-[inset_-0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
          : 'border-l shadow-[inset_0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
      )}
    >
      <RightSidebarSectionHeader data-suppress-pane-reveal-side="">
        <div className="flex min-w-0 flex-1">
          <SidebarPanelLabel>Graphify</SidebarPanelLabel>
        </div>
        <Tip label={t.common?.close ?? "Close"}>
          <Button aria-label="Close" className="size-5" onClick={closeGraphify} size="icon-xs" variant="ghost">
            <Codicon name="close" size="0.8125rem" />
          </Button>
        </Tip>
      </RightSidebarSectionHeader>

      {!currentCwd ? (
        <PaneEmptyState label="No project open" />
      ) : wails ? (
        // Wails shell: file:// is blocked by WebKit; load via Go and render srcDoc.
        <div className="flex min-h-0 flex-1 bg-white">
          {loading ? (
            <PaneEmptyState label="Loading graph…" />
          ) : srcDoc ? (
            <iframe
              srcDoc={srcDoc}
              className="size-full border-0"
              sandbox="allow-scripts allow-same-origin"
              title="Graphify"
            />
          ) : (
            <PaneEmptyState label="No graph yet — ask Alice to run graphify" />
          )}
        </div>
      ) : (
        // Electron shell: use the native <webview> for full event support.
        <div className="flex min-h-0 flex-1 bg-white">
          <webview
            src={graphPath}
            style={{ width: '100%', height: '100%', border: 'none' }}
            webpreferences="contextIsolation=yes, nodeIntegration=no"
          />
        </div>
      )}
    </aside>
  )
}
