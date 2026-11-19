import { codeToHtml } from 'shiki'

// Shiki output cache.
//
// The preview pane re-renders source chunks as they scroll in and out of the
// virtual window, and markdown re-renders fenced blocks whenever a section is
// re-mounted. Without a cache every one of those passes re-tokenises the same
// text. Shiki's `defaultColor: 'light-dark()'` emits self-contained HTML whose
// colors follow the OS scheme, so the cached string can be injected directly.
//
// The cache is bounded (LRU) and keyed by language + source text: source code
// is the key, so there is no hash-collision risk of showing the wrong snippet.

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const
const MAX_ENTRIES = 64

const cache = new Map<string, Promise<string>>()

function cacheKey(code: string, lang: string): string {
  return `${lang}\u0000${code}`
}

function touch(key: string, value: Promise<string>): void {
  // Re-insert to refresh LRU order.
  cache.delete(key)
  cache.set(key, value)

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value

    if (oldest === undefined) {
      break
    }

    cache.delete(oldest)
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function highlightCode(code: string, language: string): Promise<string> {
  const lang = language || 'text'
  const key = cacheKey(code, lang)
  const cached = cache.get(key)

  if (cached) {
    touch(key, cached)

    return cached
  }

  const highlighted = codeToHtml(code, {
    defaultColor: 'light-dark()',
    lang,
    themes: THEMES
  }).catch(() => `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`)

  touch(key, highlighted)

  return highlighted
}

export function highlightCacheSize(): number {
  return cache.size
}

export function clearHighlightCache(): void {
  cache.clear()
}
