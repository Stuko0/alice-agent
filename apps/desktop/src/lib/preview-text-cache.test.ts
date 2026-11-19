import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearPreviewTextCache,
  getCachedPreviewText,
  previewTextCacheKey,
  previewTextCacheSize,
  putCachedPreviewText
} from './preview-text-cache'

const read = (text: string) => ({ path: '/work/file.ts', text, byteSize: text.length })

describe('preview text cache', () => {
  beforeEach(() => clearPreviewTextCache())

  it('returns a cached read for the same path + mtime', () => {
    const key = previewTextCacheKey('/work/file.ts', 1000)
    putCachedPreviewText(key, read('v1'))

    expect(getCachedPreviewText(key)?.text).toBe('v1')
  })

  it('treats a newer mtime as a different file revision', () => {
    putCachedPreviewText(previewTextCacheKey('/work/file.ts', 1000), read('v1'))

    expect(getCachedPreviewText(previewTextCacheKey('/work/file.ts', 2000))).toBeNull()
  })

  it('bounds the cache to six entries (LRU)', () => {
    for (let index = 0; index < 10; index += 1) {
      putCachedPreviewText(previewTextCacheKey(`/work/f${index}.ts`, 1), read(`body ${index}`))
    }

    expect(previewTextCacheSize()).toBe(6)
    expect(getCachedPreviewText(previewTextCacheKey('/work/f9.ts', 1))?.text).toBe('body 9')
    expect(getCachedPreviewText(previewTextCacheKey('/work/f0.ts', 1))).toBeNull()
  })

  it('refreshes recency on read', () => {
    for (let index = 0; index < 6; index += 1) {
      putCachedPreviewText(previewTextCacheKey(`/work/f${index}.ts`, 1), read(`body ${index}`))
    }

    // Touch the oldest, then add one more: the second-oldest must be evicted.
    getCachedPreviewText(previewTextCacheKey('/work/f0.ts', 1))
    putCachedPreviewText(previewTextCacheKey('/work/f6.ts', 1), read('body 6'))

    expect(getCachedPreviewText(previewTextCacheKey('/work/f0.ts', 1))).not.toBeNull()
    expect(getCachedPreviewText(previewTextCacheKey('/work/f1.ts', 1))).toBeNull()
  })
})
