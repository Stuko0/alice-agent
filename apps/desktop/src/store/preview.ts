import { atom, computed } from 'nanostores'

import { startDesktopPreviewServer } from '@/lib/desktop-fs'
import { persistedKey } from '@/lib/persisted-keys'
import { persistCoalesced } from '@/lib/storage'

import { setBrowserOpen } from './browser'
import { $browserTabs, closeBrowserTab, openFileTab, openWebTab } from './browser-tabs'
import { $activeSessionId, $selectedStoredSessionId } from './session'

/**
 * Preview intent + registry.
 *
 * There is no preview rail any more: opening a preview routes into the browser
 * drawer — a `web` tab for URLs / runnable artifacts (served from the loopback
 * preview origin), a `file` tab rendered by the rich local previewer for
 * everything else. This store keeps the "what is the user previewing" state
 * (composer status row, session dismissal) around the browser tabs.
 */
export interface PreviewTarget {
  binary?: boolean
  byteSize?: number
  /** Inline image bytes (a `data:` URL) when the renderer already holds them —
   * e.g. a pasted/dropped screenshot whose only on-disk copy is a transient
   * path the preview can't reliably re-read. Rendered directly and NOT
   * persisted to the session-preview registry (it would bloat localStorage). */
  dataUrl?: string
  kind: 'file' | 'url'
  label: string
  large?: boolean
  language?: string
  mimeType?: string
  path?: string
  previewKind?: 'binary' | 'html' | 'image' | 'text'
  renderMode?: 'preview' | 'source'
  source: string
  url: string
}

export type PreviewRecordSource = 'explicit-link' | 'file-browser' | 'manual' | 'tool-result'

export interface SessionPreviewRecord {
  autoOpen?: boolean
  createdAt: number
  dismissedAt?: number
  id: string
  normalized: PreviewTarget
  sessionId: string
  source: PreviewRecordSource
  target: string
}

type SessionPreviewRegistry = Record<string, SessionPreviewRecord[]>

const REGISTRY_STORAGE_KEY = persistedKey('previewRegistry')
const MAX_RECORDS_PER_SESSION = 1
const MAX_SESSIONS = 120

export const $previewTarget = atom<PreviewTarget | null>(null)

/** The browser tab the current preview lives in (web URL, loopback URL or file path). */
export const $previewTabUrl = atom<null | string>(null)

/** True while that tab is still open — the status row's on/off switch. */
export const $previewTabOpen = computed(
  [$browserTabs, $previewTabUrl],
  (tabs, url) => Boolean(url) && tabs.some(tab => tab.url === url)
)

export const $sessionPreviewRegistry = atom<SessionPreviewRegistry>(loadSessionPreviewRegistry())

// `listen`: subscribing at import rewrote the (possibly empty) registry on every boot.
$sessionPreviewRegistry.listen(persistSessionPreviewRegistry)

function isSamePreviewTarget(a: PreviewTarget | null, b: PreviewTarget | null): boolean {
  if (a === b) {
    return true
  }

  if (!a || !b) {
    return false
  }

  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.renderMode === b.renderMode &&
    a.source === b.source &&
    a.url === b.url
  )
}

/** Set the "currently previewed" target without opening anything. */
export function setPreviewTarget(target: PreviewTarget | null) {
  if (isSamePreviewTarget($previewTarget.get(), target)) {
    return
  }

  $previewTarget.set(target)

  if (!target) {
    $previewTabUrl.set(null)
  }
}

function previewPathFor(target: PreviewTarget): string {
  if (target.path) {
    return target.path
  }

  if (/^file:\/\//i.test(target.url)) {
    try {
      return decodeURIComponent(new URL(target.url).pathname)
    } catch {
      return target.url.replace(/^file:\/\//i, '')
    }
  }

  return target.url
}

// Manual/file-browser opens are "peeking at a file" → source view. Tool/explicit
// link opens are runnable artifacts → live preview. Kept on the target so the
// file tab can render HTML source when the preview server isn't available.
function isFilePreviewSource(source: PreviewRecordSource): boolean {
  return source === 'file-browser' || source === 'manual'
}

function previewTargetForSource(target: PreviewTarget, source: PreviewRecordSource): PreviewTarget {
  if (target.kind !== 'file' || target.previewKind !== 'html') {
    return target
  }

  return { ...target, renderMode: isFilePreviewSource(source) ? 'source' : 'preview' }
}

/**
 * Open a preview in the browser drawer.
 *
 * - `url` targets and runnable artifacts (HTML, PDF/binary) load in the native
 *   engine — HTML through the token-scoped loopback preview origin so relative
 *   assets, modules and fetch keep working.
 * - everything else opens a `file` tab rendered by the rich local previewer.
 */
export async function openPreviewTarget(target: PreviewTarget): Promise<void> {
  const label = target.label || target.url
  const filePath = target.kind === 'file' ? previewPathFor(target) : ''

  setPreviewTarget(target)

  if (target.kind === 'file' && (target.previewKind === 'html' || target.previewKind === 'binary')) {
    try {
      const server = await startDesktopPreviewServer(filePath, 'file')

      if (server?.url) {
        $previewTabUrl.set(server.url)
        openWebTab(server.url, { title: label })
        setBrowserOpen(true)

        return
      }
    } catch {
      // Fall through: a source tab beats a dead preview when the loopback
      // server is unavailable (web build, remote fs).
    }
  }

  if (target.kind === 'url' || /^https?:\/\//i.test(target.url)) {
    $previewTabUrl.set(target.url)
    openWebTab(target.url, { title: label })
    setBrowserOpen(true)

    return
  }

  $previewTabUrl.set(filePath)
  openFileTab(filePath, { dataUrl: target.dataUrl, title: label })
  setBrowserOpen(true)
}

function isPreviewTarget(value: unknown): value is PreviewTarget {
  if (!value || typeof value !== 'object') {
    return false
  }

  const r = value as Record<string, unknown>

  return (
    (r.kind === 'file' || r.kind === 'url') &&
    typeof r.label === 'string' &&
    typeof r.source === 'string' &&
    typeof r.url === 'string'
  )
}

function isPreviewRecord(value: unknown): value is SessionPreviewRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const r = value as Record<string, unknown>

  return (
    typeof r.createdAt === 'number' &&
    typeof r.id === 'string' &&
    isPreviewTarget(r.normalized) &&
    typeof r.sessionId === 'string' &&
    ['explicit-link', 'file-browser', 'manual', 'tool-result'].includes(String(r.source)) &&
    typeof r.target === 'string' &&
    (r.dismissedAt === undefined || typeof r.dismissedAt === 'number')
  )
}

function loadSessionPreviewRegistry(): SessionPreviewRegistry {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(REGISTRY_STORAGE_KEY)

    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const out: SessionPreviewRegistry = {}

    for (const [sessionId, records] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(records)) {
        continue
      }

      const valid = records.filter(isPreviewRecord).slice(0, MAX_RECORDS_PER_SESSION)

      if (valid.length > 0) {
        out[sessionId] = valid
      }
    }

    return pruneRegistry(out)
  } catch {
    return {}
  }
}

function persistSessionPreviewRegistry(registry: SessionPreviewRegistry) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    // Drop the inline image bytes before persisting — a screenshot data URL is
    // megabytes and would blow the localStorage quota. On reload the record
    // falls back to reading its `path`/`url`.
    const lean = JSON.stringify(pruneRegistry(registry), (key, value) => (key === 'dataUrl' ? undefined : value))
    // Coalesced: a tool-result burst can register/refresh several records.
    persistCoalesced(REGISTRY_STORAGE_KEY, lean)
  } catch {
    // Session previews are a desktop convenience; storage failures are nonfatal.
  }
}

function pruneRegistry(registry: SessionPreviewRegistry): SessionPreviewRegistry {
  const entries = Object.entries(registry)
    .map(
      ([sessionId, records]) =>
        [sessionId, [...records].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS_PER_SESSION)] as const
    )
    .filter(([, records]) => records.length > 0)
    .sort(([, a], [, b]) => (b[0]?.createdAt ?? 0) - (a[0]?.createdAt ?? 0))
    .slice(0, MAX_SESSIONS)

  return Object.fromEntries(entries)
}

function currentPreviewSessionId(): string {
  return $selectedStoredSessionId.get() || $activeSessionId.get() || ''
}

function recordId(sessionId: string, target: PreviewTarget): string {
  return `${sessionId}:${target.url}`
}

export function registerSessionPreview(
  sessionId: string | null | undefined,
  target: PreviewTarget,
  source: PreviewRecordSource,
  rawTarget = target.source
): SessionPreviewRecord | null {
  const id = sessionId?.trim()

  if (!id) {
    return null
  }

  const current = $sessionPreviewRegistry.get()
  const now = Date.now()
  const records = current[id] ?? []
  const existing = records.find(record => record.normalized.url === target.url)
  const normalized = previewTargetForSource(target, source)

  const nextRecord: SessionPreviewRecord = {
    autoOpen: true,
    createdAt: now,
    id: existing?.id || recordId(id, target),
    normalized,
    sessionId: id,
    source,
    target: rawTarget || target.source
  }

  $sessionPreviewRegistry.set(
    pruneRegistry({
      ...current,
      [id]: [nextRecord]
    })
  )

  return nextRecord
}

export function setSessionPreviewTarget(
  sessionId: string | null | undefined,
  target: PreviewTarget,
  source: PreviewRecordSource,
  rawTarget = target.source
): SessionPreviewRecord | null {
  const record = registerSessionPreview(sessionId, target, source, rawTarget)

  // Fire-and-forget: HTML artifacts resolve their loopback URL asynchronously.
  void openPreviewTarget(record?.normalized ?? previewTargetForSource(target, source))

  return record
}

export function setCurrentSessionPreviewTarget(
  target: PreviewTarget,
  source: PreviewRecordSource,
  rawTarget = target.source
): SessionPreviewRecord | null {
  return setSessionPreviewTarget(currentPreviewSessionId(), target, source, rawTarget)
}

export function getSessionPreviewRecord(sessionId: string | null | undefined): SessionPreviewRecord | null {
  const id = sessionId?.trim()

  if (!id) {
    return null
  }

  return $sessionPreviewRegistry.get()[id]?.find(record => !record.dismissedAt && record.autoOpen !== false) ?? null
}

export function dismissSessionPreview(sessionId: string | null | undefined, url?: string) {
  const id = sessionId?.trim()

  if (!id) {
    return
  }

  const current = $sessionPreviewRegistry.get()
  const records = current[id]

  if (!records?.length) {
    return
  }

  const now = Date.now()
  const targetUrl = url || records.find(record => !record.dismissedAt)?.normalized.url

  if (!targetUrl) {
    return
  }

  const dismissedRecords = records.map(record => ({
    ...record,
    autoOpen: false,
    dismissedAt: now
  }))

  $sessionPreviewRegistry.set({
    ...current,
    [id]: dismissedRecords
  })
}

/** User closed the preview — close its browser tab and persist the dismissal. */
export function dismissPreviewTarget() {
  const current = $previewTarget.get()

  if (current?.url) {
    dismissSessionPreview(currentPreviewSessionId(), current.url)
  }

  const tabUrl = $previewTabUrl.get()

  if (tabUrl) {
    const tab = $browserTabs.get().find(candidate => candidate.url === tabUrl)

    if (tab) {
      closeBrowserTab(tab.id)
    }
  }

  $previewTabUrl.set(null)
  $previewTarget.set(null)
}

export function clearSessionPreviewRegistry() {
  $sessionPreviewRegistry.set({})
  dismissPreviewTarget()
}
