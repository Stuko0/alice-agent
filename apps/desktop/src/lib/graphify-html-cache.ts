// Graphify HTML is a single self-contained document that can be several MB.
// Reading it through the desktop bridge costs an IPC round-trip + a string copy
// into JS, and the component that renders it unmounts every time the user flips
// back to chat. Cache the last read keyed by (path, mtime, size) so a toggle is
// free and a regenerated graph is picked up automatically.

export interface GraphifyHtmlEntry {
  byteSize: number
  mtimeMs: number
  text: string
  truncated: boolean
}

const MAX_ENTRIES = 2

// Insertion order doubles as LRU order (re-set moves the key to the end).
const entries = new Map<string, GraphifyHtmlEntry>()

export function graphifyCacheKey(path: string, mtimeMs: number, byteSize: number): string {
  return `${path}::${mtimeMs}::${byteSize}`
}

export function getCachedGraphifyHtml(path: string, mtimeMs: number, byteSize: number): GraphifyHtmlEntry | null {
  const key = graphifyCacheKey(path, mtimeMs, byteSize)
  const hit = entries.get(key)

  if (!hit) {
    return null
  }

  entries.delete(key)
  entries.set(key, hit)

  return hit
}

export function putCachedGraphifyHtml(path: string, mtimeMs: number, byteSize: number, entry: GraphifyHtmlEntry): void {
  const key = graphifyCacheKey(path, mtimeMs, byteSize)

  entries.delete(key)
  entries.set(key, entry)

  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next()

    if (oldest.done) {
      break
    }

    entries.delete(oldest.value)
  }
}

/** Test/diagnostic hook. */
export function clearGraphifyHtmlCache(): void {
  entries.clear()
}

export function graphifyCacheSize(): number {
  return entries.size
}
