import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { desktopSupports } from '@/lib/desktop-capabilities'
import { getCachedGraphifyHtml, putCachedGraphifyHtml } from '@/lib/graphify-html-cache'
import { $currentCwd } from '@/store/session'

// Fullscreen graphify view. The same content the right-rail graphify pane loads,
// lifted into the chat shell when the user flips the `chat-view` toggle to
// 'graph'.
//
// Wails (WebKit) blocks `file://` from the `wails://localhost` origin, so the
// document is served by the tokenised loopback preview origin (same hardened
// server the preview pane uses). That path has no size cap and streams the
// file, which matters because a real `graphify-out/graph.html` is many MB —
// the old `readFileText` route silently truncated at 512 KB (`truncated` was
// ignored) and re-read the document on every toggle.
export function GraphifyCanvas({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const currentCwd = useStore($currentCwd).trim()
  const graphPath = currentCwd ? `file://${currentCwd}/graphify-out/graph.html` : null
  const graphFilePath = currentCwd ? `${currentCwd}/graphify-out/graph.html` : null
  // Prefer the tokenised loopback origin whenever the bridge exposes it (Wails).
  // Electron never gets the binding, so it keeps the native file:// document —
  // no shell-identity check, just a capability probe.
  const canServe = desktopSupports('previewLocalServer') && Boolean(window.aliceDesktop?.previewStartForFile)

  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!graphFilePath) {
      setSrcDoc(null)
      setServerUrl(null)
      setMissing(false)
      setLoading(false)

      return
    }

    const desktop = window.aliceDesktop
    let cancelled = false
    let serverId: null | string = null

    setLoading(true)
    setTruncated(false)
    setMissing(false)

    const load = async () => {
      // Preferred path: loopback origin. No size cap, no multi-MB string copy
      // into the renderer, and the iframe streams it.
      if (canServe && desktop?.previewStartForFile) {
        try {
          const started = await desktop.previewStartForFile(graphFilePath)

          if (cancelled) {
            if (started?.id) {
              void desktop.previewStop?.(started.id)
            }

            return
          }

          if (started?.url) {
            serverId = started.id || null
            setServerUrl(started.url)
            setSrcDoc(null)
            setLoading(false)

            return
          }
        } catch {
          // Fall through to the bounded read (older bridge / server refused).
        }
      }

      // Fallback: one bounded read, cached by (path, mtime, size).
      const stat = await desktop?.statFile?.(graphFilePath).catch(() => null)

      if (cancelled) {
        return
      }

      if (!stat || stat.isDir) {
        setMissing(true)
        setLoading(false)

        return
      }

      const cached = getCachedGraphifyHtml(graphFilePath, stat.mtimeMs, stat.byteSize)

      if (cached) {
        setSrcDoc(cached.text)
        setTruncated(cached.truncated)
        setLoading(false)

        return
      }

      try {
        const result = await desktop?.readFileText?.(graphFilePath)

        if (cancelled) {
          return
        }

        if (!result?.text) {
          setMissing(true)

          return
        }

        putCachedGraphifyHtml(graphFilePath, stat.mtimeMs, stat.byteSize, {
          byteSize: stat.byteSize,
          mtimeMs: stat.mtimeMs,
          text: result.text,
          truncated: Boolean(result.truncated)
        })
        setSrcDoc(result.text)
        setTruncated(Boolean(result.truncated))
      } catch {
        if (!cancelled) {
          setMissing(true)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true

      if (serverId) {
        void desktop?.previewStop?.(serverId)
      }
    }
  }, [canServe, graphFilePath])

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-(--ui-sidebar-surface-background)">
      <div className="flex items-center justify-between gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Codicon className="text-muted-foreground" name="type-hierarchy" size="0.875rem" />
          <span className="truncate text-sm font-medium">Graphify</span>
          {currentCwd ? (
            <span className="truncate font-mono text-[0.7rem] text-muted-foreground">{currentCwd}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Tip label={t.common?.close ?? 'Close'}>
            <Button aria-label="Back to chat" className="size-6" onClick={onClose} size="icon-xs" variant="ghost">
              <Codicon name="close" size="0.75rem" />
            </Button>
          </Tip>
        </div>
      </div>
      {truncated ? (
        <div
          className="border-b border-(--ui-stroke-secondary) bg-primary/10 px-3 py-1.5 text-[0.7rem] text-foreground"
          role="status"
        >
          {t.preview.truncated}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {!currentCwd ? (
          <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
            <div>
              <Codicon className="mx-auto mb-2 opacity-60" name="type-hierarchy" size="1.5rem" />
              <p>No workspace open — graphify needs an active session cwd.</p>
              <p className="mt-1 text-xs">Open a project or session to view its graph.</p>
            </div>
          </div>
        ) : canServe || srcDoc ? (
          loading ? (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading graph…</div>
          ) : serverUrl ? (
            <iframe
              aria-label="Graphify"
              className="size-full border-0"
              sandbox="allow-scripts allow-same-origin"
              src={serverUrl}
              title="Graphify"
            />
          ) : srcDoc ? (
            <iframe
              aria-label="Graphify"
              className="size-full border-0"
              sandbox="allow-scripts allow-same-origin"
              srcDoc={srcDoc}
              title="Graphify"
            />
          ) : missing ? (
            <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
              <div>
                <Codicon className="mx-auto mb-2 opacity-60" name="type-hierarchy" size="1.5rem" />
                <p>No graph yet — ask Alice to run graphify.</p>
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading graph…</div>
          )
        ) : (
          // Electron shell: file:// works natively.
          <iframe aria-label="Graphify" className="size-full border-0" src={graphPath ?? undefined} title="Graphify" />
        )}
      </div>
    </div>
  )
}
