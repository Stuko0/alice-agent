import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $panesFlipped } from '@/store/layout'
import { $currentCwd } from '@/store/session'
import { closeGraphify } from '@/store/graphify'

import { SidebarPanelLabel } from '../../shell/sidebar-label'
import { PaneEmptyState, RightSidebarSectionHeader } from '../index'

// We need a way to check if file exists, but for an iframe we can just try to load it.
// However, it's cleaner to just render it.

export function GraphifyPane() {
  const { t } = useI18n()
  const panesFlipped = useStore($panesFlipped)
  const currentCwd = useStore($currentCwd).trim()
  
  // We don't have a direct Node fs call here in the React view without an IPC handler,
  // but we can just blindly attempt to load the file in an iframe.
  // The path will be file://.../graphify-out/graph.html
  const graphPath = currentCwd ? `file://${currentCwd}/graphify-out/graph.html` : undefined

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
      ) : (
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
