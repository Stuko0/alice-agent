import { beforeEach, describe, expect, it, vi } from 'vitest'

const { codeToHtml } = vi.hoisted(() => ({
  codeToHtml: vi.fn(async (code: string) => `<pre class="shiki">${code}</pre>`)
}))

vi.mock('shiki', () => ({ codeToHtml }))

import { clearHighlightCache, highlightCacheSize, highlightCode } from './shiki-cache'

describe('shiki highlight cache', () => {
  beforeEach(() => {
    clearHighlightCache()
    codeToHtml.mockClear()
  })

  it('tokenises a chunk once and reuses the cached HTML', async () => {
    const first = await highlightCode('const answer = 42', 'typescript')
    const second = await highlightCode('const answer = 42', 'typescript')

    expect(first).toContain('answer')
    expect(second).toBe(first)
    expect(codeToHtml).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by language as well as source', async () => {
    await highlightCode('x = 1', 'python')
    await highlightCode('x = 1', 'ruby')

    expect(codeToHtml).toHaveBeenCalledTimes(2)
  })

  it('bounds the cache with LRU eviction', async () => {
    for (let index = 0; index < 80; index += 1) {
      await highlightCode(`line ${index}`, 'text')
    }

    expect(highlightCacheSize()).toBeLessThanOrEqual(64)
  })

  it('falls back to escaped plain HTML when the grammar is unknown', async () => {
    codeToHtml.mockRejectedValueOnce(new Error('unknown lang'))

    const html = await highlightCode('<script>alert(1)</script>', 'not-a-language')

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
