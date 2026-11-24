import type { AliceReadFileTextResult } from '@/global'

// Small LRU of file reads.
//
// Switching between preview tabs unmounts the pane, so returning to a tab used
// to re-read the file from disk even when nothing changed. Keyed by
// path + mtime this is only safe when the shell can stat cheaply (Wails);
// callers without `statFile` (older Electron) simply skip the cache.

const MAX_ENTRIES = 6

const cache = new Map<string, AliceReadFileTextResult>()

export function previewTextCacheKey(path: string, mtimeMs: number | null | undefined): string {
  return `${path}::${mtimeMs ?? 'unknown'}`
}

export function getCachedPreviewText(key: string): AliceReadFileTextResult | null {
  const hit = cache.get(key)

  if (!hit) {
    return null
  }

  cache.delete(key)
  cache.set(key, hit)

  return hit
}

export function putCachedPreviewText(key: string, result: AliceReadFileTextResult): void {
  cache.delete(key)
  cache.set(key, result)

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value

    if (oldest === undefined) {
      break
    }

    cache.delete(oldest)
  }
}

export function previewTextCacheSize(): number {
  return cache.size
}

export function clearPreviewTextCache(): void {
  cache.clear()
}
