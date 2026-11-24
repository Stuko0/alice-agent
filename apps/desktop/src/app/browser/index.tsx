import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { openExternalLink } from '@/lib/external-link'
import { IS_MAC } from '@/lib/keybinds/combo'
import { cn } from '@/lib/utils'
import {
  $browserConsole,
  $browserState,
  type BrowserState,
  recordBrowserConsoleError,
  setBrowserOpen,
  setBrowserState
} from '@/store/browser'
import { browserSurfaceVisible, surfaceLayerPresent, watchSurfaceLayers } from '@/store/browser-surface'
import {
  $activeBrowserTabId,
  $browserTabs,
  activateBrowserTab,
  closeBrowserTab,
  openFileTab,
  openWebTab,
  updateBrowserTabTitle,
  updateBrowserTabUrl
} from '@/store/browser-tabs'

import { FileTabView } from './file-tab'

/** How long we wait for the native surface before falling back to an iframe. */
export const FALLBACK_AFTER_MS = 8_000

function normalizeDraft(raw: string): string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return ''
  }

  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export function BrowserPane({ visible }: { visible: boolean }) {
  const tabs = useStore($browserTabs)
  const activeId = useStore($activeBrowserTabId)
  const state = useStore($browserState)
  const consoleState = useStore($browserConsole)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(false)
  const wasVisibleRef = useRef(false)
  const [mounting, setMounting] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [iframeSrc, setIframeSrc] = useState('')
  const [draft, setDraft] = useState('')

  const active = tabs.find(tab => tab.id === activeId) ?? null
  const isWeb = active?.kind === 'web'
  const webUrl = active?.kind === 'web' ? active.url : ''
  // The native view paints above the DOM, so any dialog/menu/palette on screen
  // forces it off until that layer closes. Read from the DOM (Radix marks its
  // open content) so a stale React counter can never leave it hidden.
  const [overlayLayer, setOverlayLayer] = useState(surfaceLayerPresent)
  useEffect(() => watchSurfaceLayers(setOverlayLayer), [])
  const nativeVisible = browserSurfaceVisible({ baseVisible: visible && isWeb, overlays: overlayLayer })

  const browser = typeof window === 'undefined' ? undefined : window.aliceDesktop?.browser
  const available = Boolean(browser)

  const rect = () => {
    const element = hostRef.current

    if (!element) {
      return null
    }

    const bounds = element.getBoundingClientRect()

    // GTK positions widgets in window-logical pixels. WebKit's
    // getBoundingClientRect() under CSS `zoom` (our display scale) already
    // reports those post-zoom values — `innerWidth` stays pre-zoom — so the
    // rect goes through untouched. Dividing by zoom would shrink and shift it.
    return {
      height: Math.round(bounds.height),
      width: Math.round(bounds.width),
      x: Math.round(bounds.left),
      y: Math.round(bounds.top)
    }
  }

  // Opening the drawer with no tabs gives the user a blank tab to type into.
  useEffect(() => {
    if (visible && !wasVisibleRef.current && tabs.length === 0) {
      openWebTab('')
    }

    wasVisibleRef.current = visible
  }, [tabs.length, visible])

  // Closing the last tab leaves nothing to show, so the drawer closes with it
  // (⌘/Ctrl+W on the last tab behaves like a browser window's last tab).
  useEffect(() => {
    if (visible && wasVisibleRef.current && tabs.length === 0) {
      setBrowserOpen(false)
    }
  }, [tabs.length, visible])

  // Address bar shows the engine's real URL for web tabs (the truth after
  // redirects/links); file tabs show their path.
  useEffect(() => {
    if (!isWeb || !active?.url) {
      // File tabs show their path; a blank new tab must NOT inherit the
      // previous page's URL from the shared engine.
      setDraft(active?.url ?? '')

      return
    }

    setDraft(state.url && state.url !== 'about:blank' ? state.url : active.url)
  }, [active?.url, isWeb, state.url])

  // State from the native view (url/title/loading) + one bootstrap read.
  useEffect(() => {
    if (!browser) {
      return
    }

    const off = browser.onState((next: BrowserState) => {
      if (next && typeof next === 'object') {
        setBrowserState(next)
      }
    })

    void browser.status().then((next: BrowserState | null) => {
      if (next) {
        setBrowserState(next)
      }
    })

    return off
  }, [browser])

  // Console errors surfaced by the page shim. Kept in the chrome instead of a
  // devtools console: the release build has no inspector.
  useEffect(() => {
    if (!browser) {
      return
    }

    const off = browser.onConsoleError(error => {
      if (error && typeof error === 'object') {
        recordBrowserConsoleError(error)
      }
    })

    return off
  }, [browser])

  // Shortcuts captured by the native surface (it owns the keyboard while the
  // page has focus). Re-dispatch them as real keydowns so the app's single
  // keybind listener handles them exactly like a DOM-originated press.
  useEffect(() => {
    if (!browser) {
      return
    }

    return browser.onShortcut(shortcut => {
      if (shortcut === 'palette') {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            code: 'KeyK',
            ctrlKey: !IS_MAC,
            key: 'k',
            metaKey: IS_MAC
          })
        )

        return
      }

      if (shortcut === 'escape') {
        // Escape from the page means "give the keyboard back to the app": the
        // pane's own Escape handling (close the drawer) must NOT also run, or
        // dismissing something inside the page would close the browser.
        browser.blur()
      }
    })
  }, [browser])

  // Release the native surface when the pane unmounts. It never clears the
  // persistent profile (cookies/localStorage stay).
  useEffect(() => {
    return () => browser?.close()
  }, [browser])

  // Show/hide the native surface. It always paints above the WebView content,
  // so it must disappear whenever a React overlay owns the window — and while a
  // file tab is active.
  useEffect(() => {
    browser?.setVisible(nativeVisible)
  }, [browser, nativeVisible])

  // Mount on first open of a web tab, retrying while the Go side waits for the
  // GTK window.
  useEffect(() => {
    if (!browser || !nativeVisible || mountedRef.current) {
      return
    }

    let cancelled = false

    const attempt = (tries: number) => {
      if (cancelled) {
        return
      }

      const bounds = rect()

      if (!bounds) {
        window.setTimeout(() => attempt(tries), 100)

        return
      }

      setMounting(true)
      void browser.mount(bounds).then((next: BrowserState) => {
        if (cancelled) {
          return
        }

        if (next?.ready) {
          mountedRef.current = true
          setMounting(false)
          setBrowserState(next)

          return
        }

        if (tries < 40) {
          window.setTimeout(() => attempt(tries + 1), 250)
        } else {
          setMounting(false)
        }
      })
    }

    window.requestAnimationFrame(() => attempt(0))

    return () => {
      cancelled = true
    }
  }, [browser, nativeVisible])

  // A web tab with a URL owns the engine: navigating between tabs is a plain
  // load (history is not preserved per tab by design).
  useEffect(() => {
    if (!browser || !nativeVisible || !active || active.kind !== 'web') {
      return
    }

    // A blank tab owns the shared engine too: leaving the previous page under
    // an empty tab reads as a bug.
    const target = active.url ? normalizeDraft(active.url) : 'about:blank'

    if (!target || state.url === target) {
      return
    }

    void browser.navigate(target)
  }, [active, browser, nativeVisible, state.url])

  // Title sync only. Tab URLs are user-owned (submit/activation/agent): letting
  // the engine write them let a late "load finished" from the previous tab
  // hijack the newly activated one.
  useEffect(() => {
    if (!active || active.kind !== 'web' || !state.url || state.loading) {
      return
    }

    const strip = (value: string) => value.replace(/\/$/, '')

    if (strip(state.url) !== strip(active.url)) {
      return
    }

    if (state.title && state.title !== active.title) {
      updateBrowserTabTitle(active.id, state.title)
    }
  }, [active, state.loading, state.title, state.url])

  // If the GTK embedding never comes up (unsupported shell, missing headers,
  // a Wails hierarchy change), degrade to a plain iframe instead of a dead
  // pane. The iframe can't bypass X-Frame-Options, but a local dev server or a
  // framing-friendly page still renders.
  useEffect(() => {
    if (state.ready) {
      setFallback(false)

      return
    }

    if (!nativeVisible || !browser) {
      return
    }

    const timer = window.setTimeout(() => setFallback(true), FALLBACK_AFTER_MS)

    return () => window.clearTimeout(timer)
  }, [browser, nativeVisible, state.ready])

  const showIframe = isWeb && (!available || (!state.ready && fallback))

  // Keep the native surface glued to the placeholder while the drawer resizes.
  useEffect(() => {
    if (!browser || !nativeVisible) {
      return
    }

    const element = hostRef.current

    if (!element) {
      return
    }

    const sync = () => {
      const bounds = rect()

      if (bounds) {
        browser.setBounds(bounds)
      }
    }

    const frame = window.requestAnimationFrame(sync)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)

    observer?.observe(element)
    window.addEventListener('resize', sync)

    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [browser, nativeVisible])

  const go = () => {
    const raw = draft.trim()

    if (!raw) {
      return
    }

    // A local path (or file:// URL) opens a file tab in the React previewer —
    // the browser's equivalent of "open file", with no native dialog needed.
    const filePath = raw.startsWith('file://')
      ? raw.slice('file://'.length)
      : raw.startsWith('/')
        ? raw
        : ''

    if (filePath) {
      openFileTab(filePath)

      return
    }

    const target = normalizeDraft(raw)

    if (!active) {
      openWebTab(target)

      return
    }

    if (active.kind === 'file') {
      openWebTab(target)

      return
    }

    updateBrowserTabUrl(active.id, target)

    if (state.ready && browser) {
      void browser.navigate(target)

      return
    }

    // Fallback path: the iframe is the page, so move it directly.
    setIframeSrc(target)
  }

  const openExternal = () => {
    const target = active?.kind === 'web' ? active.url : ''

    if (target) {
      openExternalLink(target)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Tabs */}
      <div className="flex h-8 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-(--ui-stroke-tertiary) px-1 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map(tab => {
          const isActive = tab.id === activeId

          return (
            <div
              className={cn(
                'group/tab flex min-w-0 max-w-44 shrink-0 items-center gap-1 rounded-t-sm border border-b-0 px-2 text-[0.7rem]',
                isActive
                  ? 'border-(--ui-stroke-secondary) bg-(--ui-bg-editor) text-foreground'
                  : 'border-transparent text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
              )}
              key={tab.id}
            >
              <button
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => {
                  activateBrowserTab(tab.id)
                }}
                title={tab.url}
                type="button"
              >
                {tab.title || tab.url || 'New tab'}
              </button>
              <button
                aria-label={`Close ${tab.title || tab.url || 'tab'}`}
                className="grid size-4 shrink-0 place-items-center rounded-sm opacity-0 hover:bg-(--ui-control-hover-background) group-hover/tab:opacity-100"
                onClick={() => closeBrowserTab(tab.id)}
                type="button"
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          aria-label="New tab"
          className="grid size-7 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => openWebTab('')}
          type="button"
        >
          ＋
        </button>
      </div>

      {/* Chrome: nav + address + status */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-(--ui-stroke-tertiary) px-2">
        <button
          aria-label="Back"
          className="grid size-6 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => browser?.back()}
          type="button"
        >
          <Codicon name="arrow-left" size="0.85rem" />
        </button>
        <button
          aria-label="Forward"
          className="grid size-6 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => browser?.forward()}
          type="button"
        >
          <Codicon name="arrow-right" size="0.85rem" />
        </button>
        <button
          aria-label={state.loading ? 'Stop' : 'Reload'}
          className="grid size-6 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => (state.loading ? browser?.stop() : browser?.reload())}
          type="button"
        >
          <Codicon name={state.loading ? 'close' : 'refresh'} size="0.85rem" />
        </button>

        {consoleState.count > 0 ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-sm border border-(--ui-red) px-1.5 py-0.5 text-[0.66rem] text-(--ui-red)"
            title={consoleState.last?.message ?? 'Console errors'}
          >
            ⚠ {consoleState.count}
          </span>
        ) : null}

        <form
          className="min-w-0 flex-1"
          onSubmit={event => {
            event.preventDefault()
            go()
          }}
        >
          <input
            aria-label="Address"
            className="h-6 w-full rounded-sm border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-2 text-[0.72rem] text-foreground outline-none placeholder:text-(--ui-text-tertiary) focus:border-(--ui-stroke-secondary)"
            onChange={event => setDraft(event.target.value)}
            placeholder="https://example.com"
            spellCheck={false}
            value={draft}
          />
        </form>

        <button
          aria-label="Open in external browser"
          className="grid size-6 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground disabled:opacity-40"
          disabled={!active || active.kind !== 'web' || !active.url}
          onClick={openExternal}
          type="button"
        >
          <Codicon name="link-external" size="0.85rem" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-(--ui-bg-editor)">
        {active?.kind === 'file' ? (
          <FileTabView dataUrl={active.dataUrl} label={active.title} path={active.url} />
        ) : (
          <div
            className={cn('relative size-full', !state.ready && 'grid place-items-center')}
            ref={hostRef}
          >
            {showIframe ? (
              <div className="flex size-full flex-col">
                <div className="shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) px-2 py-1 text-[0.68rem] text-(--ui-text-tertiary)">
                  Native engine unavailable — showing an iframe fallback.
                </div>
                <iframe
                  className="size-full flex-1 border-0 bg-white"
                  src={iframeSrc || 'about:blank'}
                  title="Browser (iframe fallback)"
                />
              </div>
            ) : !available ? (
              <p className="max-w-sm px-6 text-center text-[0.75rem] text-(--ui-text-tertiary)">
                The native browser is unavailable in this shell.
              </p>
            ) : !state.ready ? (
              <p className="text-[0.75rem] text-(--ui-text-tertiary)">
                {mounting ? 'Starting native browser…' : 'Waiting for the window…'}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
