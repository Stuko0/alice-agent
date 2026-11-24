import { describe, expect, it } from 'vitest'

import {
  clearGraphifyHtmlCache,
  getCachedGraphifyHtml,
  graphifyCacheSize,
  putCachedGraphifyHtml
} from './graphify-html-cache'

const entry = (text: string, mtimeMs = 1, byteSize = text.length) => ({
  byteSize,
  mtimeMs,
  text,
  truncated: false
})

describe('graphify html cache', () => {
  it('misses by default and hits after a put', () => {
    clearGraphifyHtmlCache()

    expect(getCachedGraphifyHtml('/a/graph.html', 1, 10)).toBeNull()

    putCachedGraphifyHtml('/a/graph.html', 1, 10, entry('<html>a</html>', 1, 10))

    expect(getCachedGraphifyHtml('/a/graph.html', 1, 10)?.text).toBe('<html>a</html>')
  })

  it('invalidates when mtime or size changes (a regenerated graph)', () => {
    clearGraphifyHtmlCache()
    putCachedGraphifyHtml('/a/graph.html', 1, 10, entry('<html>a</html>', 1, 10))

    expect(getCachedGraphifyHtml('/a/graph.html', 2, 10)).toBeNull()
    expect(getCachedGraphifyHtml('/a/graph.html', 1, 11)).toBeNull()
  })

  it('is bounded and evicts the least recently used entry', () => {
    clearGraphifyHtmlCache()

    putCachedGraphifyHtml('/a', 1, 1, entry('a', 1, 1))
    putCachedGraphifyHtml('/b', 1, 1, entry('b', 1, 1))
    // Touch /a so /b becomes the oldest.
    expect(getCachedGraphifyHtml('/a', 1, 1)?.text).toBe('a')

    putCachedGraphifyHtml('/c', 1, 1, entry('c', 1, 1))

    expect(graphifyCacheSize()).toBe(2)
    expect(getCachedGraphifyHtml('/b', 1, 1)).toBeNull()
    expect(getCachedGraphifyHtml('/a', 1, 1)?.text).toBe('a')
    expect(getCachedGraphifyHtml('/c', 1, 1)?.text).toBe('c')
  })

  it('keeps the truncated flag for the fallback banner', () => {
    clearGraphifyHtmlCache()
    putCachedGraphifyHtml('/a', 1, 10, { ...entry('partial', 1, 10), truncated: true })

    expect(getCachedGraphifyHtml('/a', 1, 10)?.truncated).toBe(true)
  })
})
