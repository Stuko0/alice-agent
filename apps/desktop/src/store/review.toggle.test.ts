import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { $busy, $currentCwd } from '@/store/session'

const git = vi.hoisted(() => ({
  diff: vi.fn(async () => ''),
  list: vi.fn(async () => ({ files: [] as { added: number; path: string; removed: number; staged: boolean }[] })),
  remoteInfo: vi.fn(async () => null),
  shipInfo: vi.fn(async () => ({ ghReady: false, pr: null }))
}))

vi.mock('@/lib/desktop-git', () => ({
  desktopGit: () => ({
    remoteInfo: git.remoteInfo,
    review: {
      diff: git.diff,
      list: git.list,
      shipInfo: git.shipInfo
    }
  })
}))

const {
  $reviewFiles,
  $reviewOpen,
  REVIEW_PANE_ID,
  closeReview,
  openReview,
  refreshReview,
  wireReview
} = await import('./review')

describe('review pane toggling', () => {
  let reveals: CustomEvent<{ id: string }>[] = []

  const onReveal = (event: Event) => {
    reveals.push(event as CustomEvent<{ id: string }>)
  }

  beforeEach(() => {
    // The edge subscriptions are explicit now (D1); opt in per file.
    wireReview()
    vi.clearAllMocks()
    reveals = []
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, onReveal)
    $reviewOpen.set(false)
    $reviewFiles.set([])
    $currentCwd.set('/work/repo')
  })

  afterEach(() => {
    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, onReveal)
    $busy.set(false)
    $reviewOpen.set(false)
    $currentCwd.set('')
  })

  it('opens once, reveals the pane and probes git once', async () => {
    openReview()

    expect($reviewOpen.get()).toBe(true)
    expect(reveals.map(event => event.detail.id)).toEqual([REVIEW_PANE_ID])

    await vi.waitFor(() => expect(git.list).toHaveBeenCalledTimes(1))
    expect(git.shipInfo).toHaveBeenCalledTimes(1)
  })

  it('a second call while open issues no list/shipInfo probe', async () => {
    openReview()
    await vi.waitFor(() => expect(git.list).toHaveBeenCalledTimes(1))

    openReview()
    await Promise.resolve()

    expect(git.list).toHaveBeenCalledTimes(1)
    expect(git.shipInfo).toHaveBeenCalledTimes(1)
    // Still reveals: in a narrow window the pane may be collapsed even when open.
    expect(reveals).toHaveLength(2)
  })

  it('does not arm the persisted open flag without a workspace', () => {
    $currentCwd.set('')

    openReview()

    expect($reviewOpen.get()).toBe(false)
    expect(git.list).not.toHaveBeenCalled()
    expect(reveals).toHaveLength(0)
  })

  it('re-exposes cached files immediately after close/reopen', async () => {
    git.list.mockResolvedValueOnce({ files: [{ added: 1, path: 'a.ts', removed: 0, staged: false }] })

    openReview()
    await vi.waitFor(() => expect($reviewFiles.get()).toHaveLength(1))

    closeReview()
    expect($reviewOpen.get()).toBe(false)

    openReview()

    // Cached list is painted in the same tick; the refresh is background work.
    expect($reviewFiles.get()).toHaveLength(1)
  })

  it('defers the cwd-triggered refresh while a switch is in flight', async () => {
    $reviewOpen.set(true)
    $busy.set(true)

    const before = git.list.mock.calls.length

    // A session switch flips cwd mid-resume; probing git then competes with the
    // transcript paint. The busy→idle edge owns the refresh.
    $currentCwd.set('/work/next-repo')
    await new Promise(resolve => setTimeout(resolve, 250))

    expect(git.list).toHaveBeenCalledTimes(before)

    $busy.set(false)
    await vi.waitFor(() => expect(git.list.mock.calls.length).toBeGreaterThan(before))
  })

  it('refreshReview never claims "not a repo" without a workspace', async () => {
    $reviewOpen.set(true)
    $currentCwd.set('')

    await refreshReview()

    expect($reviewFiles.get()).toHaveLength(0)
    expect(git.list).not.toHaveBeenCalled()
  })
})
