import { useStore } from '@nanostores/react'
import { type FormEvent, useCallback, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { cn } from '@/lib/utils'
import { $panesFlipped } from '@/store/layout'

import {
  $browserTabs,
  closeBrowserTab,
  upsertBrowserTab,
  type BrowserTab,
} from '@/store/browser-tabs'
import { RightSidebarSectionHeader } from '../index'
import { SidebarPanelLabel } from '../../shell/sidebar-label'

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname + u.pathname.replace(/\/$/, '')
  } catch {
    return url
  }
}

function TabRow({
  tab,
  onNavigate,
  onOpenExternal,
  onClose,
}: {
  tab: BrowserTab
  onNavigate: (url: string) => void
  onOpenExternal: (url: string) => void
  onClose: (id: string) => void
}) {
  const domain = (() => {
    try {
      return new URL(tab.url).hostname
    } catch {
      return tab.url
    }
  })()

  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-(--ui-control-hover-background)">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Codicon name="globe" size="0.75rem" className="shrink-0 text-(--ui-text-tertiary)" />
          <button
            className="truncate text-[0.77rem] font-medium leading-5 text-foreground hover:underline text-left"
            onClick={() => onNavigate(tab.url)}
            title={tab.url}
            type="button"
          >
            {tab.title || tab.url}
          </button>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="truncate text-[0.65rem] text-(--ui-text-tertiary)">{domain}</span>
          <span className="shrink-0 text-[0.6rem] text-(--ui-text-quaternary)">{formatTime(tab.lastActiveAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          aria-label="Open in system browser"
          className="text-(--ui-text-tertiary) hover:text-foreground"
          onClick={() => onOpenExternal(tab.url)}
          size="icon-xs"
          title="Open in system browser"
          variant="ghost"
        >
          <Codicon name="link-external" size="0.8125rem" />
        </Button>
        <Button
          aria-label="Close tab"
          className="text-(--ui-text-tertiary) hover:text-foreground"
          onClick={() => onClose(tab.id)}
          size="icon-xs"
          title="Close tab"
          variant="ghost"
        >
          <Codicon name="close" size="0.8125rem" />
        </Button>
      </div>
    </div>
  )
}

export function BrowserPane() {
  const tabs = useStore($browserTabs)
  const panesFlipped = useStore($panesFlipped)
  const { t } = useI18n()
  const [inputUrl, setInputUrl] = useState('')
  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  const [loadingEmbed, setLoadingEmbed] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const openUrl = useCallback((url: string) => {
    setActiveUrl(url)
    setLoadingEmbed(true)
    upsertBrowserTab(url, displayUrl(url))
  }, [])

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault()
    let url = inputUrl.trim()
    if (!url) return
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      url = 'https://' + url
    }
    setInputUrl('')
    openUrl(url)
  }, [inputUrl, openUrl])

  const handleIframeLoad = useCallback(() => {
    setLoadingEmbed(false)
  }, [])

  const iframeSrc = activeUrl

  return (
    <aside
      aria-label="Browser tabs"
      className={cn(
        'before:pointer-events-none relative flex h-full w-full min-w-0 flex-col overflow-hidden border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) pt-(--titlebar-height) text-(--ui-text-tertiary)',
        panesFlipped
          ? 'border-r shadow-[inset_-0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
          : 'border-l shadow-[inset_0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
      )}
    >
      <RightSidebarSectionHeader>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SidebarPanelLabel>Browser Tabs</SidebarPanelLabel>
          {tabs.length > 0 && (
            <span className="rounded-full bg-(--ui-bg-tertiary) px-1.5 text-[0.6rem] font-medium tabular-nums text-(--ui-text-quaternary)">
              {tabs.length}
            </span>
          )}
        </div>
        {tabs.length > 0 && (
          <Button
            aria-label="Clear all tabs"
            className="text-(--ui-text-tertiary) hover:text-foreground"
            onClick={() => { $browserTabs.set([]); setActiveUrl(null) }}
            size="icon-xs"
            title="Clear all"
            variant="ghost"
          >
            <Codicon name="clear-all" size="0.8125rem" />
          </Button>
        )}
      </RightSidebarSectionHeader>

      <form className="flex shrink-0 gap-1 px-2 pb-2" onSubmit={handleSubmit}>
        <Input
          className="min-w-0 flex-1 text-[0.77rem]"
          onChange={e => setInputUrl(e.target.value)}
          placeholder="Enter a URL…"
          ref={inputRef}
          type="text"
          value={inputUrl}
        />
        <Button
          className="shrink-0"
          disabled={!inputUrl.trim()}
          size="sm"
          title="Navigate"
          type="submit"
        >
          <Codicon name="arrow-right" size="0.8125rem" />
        </Button>
      </form>

      {/* Tab list */}
      {tabs.length > 0 && (
        <div className="flex flex-col gap-0.5 border-b border-(--ui-stroke-secondary) px-1.5 py-1">
          {tabs.map(tab => (
            <TabRow
              key={tab.id}
              tab={tab}
              onNavigate={openUrl}
              onOpenExternal={openExternalLink}
              onClose={closeBrowserTab}
            />
          ))}
        </div>
      )}

      {/* Embedded webview */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {iframeSrc ? (
          <>
            {/* Navigation toolbar */}
            <div className="flex shrink-0 items-center gap-1 border-b border-(--ui-stroke-secondary) bg-(--ui-surface-background) px-2 py-1">
              <Button
                className="text-(--ui-text-tertiary) hover:text-foreground"
                disabled={!activeUrl}
                onClick={() => {
                  if (iframeRef.current?.contentWindow) {
                    try { iframeRef.current.contentWindow.history.back() } catch {}
                  }
                }}
                size="icon-xs"
                title="Back"
                variant="ghost"
              >
                <Codicon name="arrow-left" size="0.75rem" />
              </Button>
              <Button
                className="text-(--ui-text-tertiary) hover:text-foreground"
                disabled={!activeUrl}
                onClick={() => {
                  if (iframeRef.current?.contentWindow) {
                    try { iframeRef.current.contentWindow.history.forward() } catch {}
                  }
                }}
                size="icon-xs"
                title="Forward"
                variant="ghost"
              >
                <Codicon name="arrow-right" size="0.75rem" />
              </Button>
              <span className="min-w-0 flex-1 truncate px-1 text-[0.65rem] text-(--ui-text-quaternary)">
                {loadingEmbed ? 'Loading…' : activeUrl}
              </span>
              <Button
                className="text-(--ui-text-tertiary) hover:text-foreground"
                onClick={() => openExternalLink(activeUrl)}
                size="icon-xs"
                title="Open in system browser"
                variant="ghost"
              >
                <Codicon name="link-external" size="0.75rem" />
              </Button>
            </div>
            {/* The iframe */}
            <iframe
              className="min-h-0 flex-1 border-0 bg-white"
              onLoad={handleIframeLoad}
              ref={iframeRef}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              src={iframeSrc}
              title={activeUrl}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4">
            <SidebarPanelLabel className="pl-0 text-(--ui-text-quaternary)">
              Enter a URL above to browse
            </SidebarPanelLabel>
          </div>
        )}
      </div>
    </aside>
  )
}
