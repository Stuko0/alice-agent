import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/alice'

import { sessionRowPropsEqual } from './session-row'

// D3 contract: a session row may only re-render when something the user can see
// changed. The list recreates handler closures on every render, so the
// comparator ignores their identity; everything else is compared.
const session = {
  id: 's1',
  last_active: 1,
  message_count: 2,
  preview: 'hello',
  source: 'desktop',
  started_at: 1,
  title: 'A chat'
} as SessionInfo

const base = {
  branchStem: undefined,
  dragging: false,
  isPinned: false,
  isSelected: false,
  isWorking: false,
  onArchive: () => undefined,
  onDelete: () => undefined,
  onPin: () => undefined,
  onResume: () => undefined,
  reorderable: false,
  session
}

describe('sessionRowPropsEqual', () => {
  it('ignores freshly created handler closures', () => {
    expect(
      sessionRowPropsEqual(base, {
        ...base,
        onArchive: () => undefined,
        onDelete: () => undefined,
        onPin: () => undefined,
        onResume: () => undefined
      })
    ).toBe(true)
  })

  it('re-renders when the working indicator flips', () => {
    expect(sessionRowPropsEqual(base, { ...base, isWorking: true })).toBe(false)
  })

  it('re-renders when selection, pinning or the session row itself changes', () => {
    expect(sessionRowPropsEqual(base, { ...base, isSelected: true })).toBe(false)
    expect(sessionRowPropsEqual(base, { ...base, isPinned: true })).toBe(false)
    expect(sessionRowPropsEqual(base, { ...base, session: { ...session, title: 'B' } })).toBe(false)
  })

  it('re-renders when drag state or the tree stem changes', () => {
    expect(sessionRowPropsEqual(base, { ...base, dragging: true })).toBe(false)
    expect(sessionRowPropsEqual(base, { ...base, branchStem: '└─ ' })).toBe(false)
  })

  it('bails out when nothing visible changed', () => {
    expect(sessionRowPropsEqual(base, { ...base })).toBe(true)
  })
})
