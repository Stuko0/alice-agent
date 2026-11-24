// D1 invariant: importing a store must not schedule git/gh/network work. The
// edge subscriptions live in `wireStores()` and start explicitly from main.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const git = vi.hoisted(() => ({
  remoteInfo: vi.fn(async () => null),
  repoStatus: vi.fn(async () => null),
  reviewList: vi.fn(async () => ({ files: [] })),
  shipInfo: vi.fn(async () => ({ ghReady: false, pr: null }))
}))

vi.mock('@/lib/desktop-git', () => ({
  desktopGit: () => ({
    remoteInfo: git.remoteInfo,
    repoStatus: git.repoStatus,
    review: {
      diff: vi.fn(async () => ''),
      list: git.reviewList,
      shipInfo: git.shipInfo
    }
  })
}))

const fetchSpy = vi.fn()

const bridgeCalls = () =>
  git.repoStatus.mock.calls.length +
  git.reviewList.mock.calls.length +
  git.shipInfo.mock.calls.length +
  git.remoteInfo.mock.calls.length

describe('store wiring (D1)', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    git.repoStatus.mockClear()
    git.reviewList.mockClear()
    git.shipInfo.mockClear()
    git.remoteInfo.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('importing the probe stores schedules no bridge or network work', async () => {
    await import('./coding-status')
    await import('./review')
    await import('./profile')

    // Give any (unwanted) debounced timer a chance to fire.
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(bridgeCalls()).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('wireStores() is idempotent and starts the git probes exactly once', async () => {
    const { wireStores } = await import('./wire')
    const { $currentCwd } = await import('./session')

    wireStores()
    wireStores()

    $currentCwd.set('/work/repo')

    await vi.waitFor(() => expect(git.repoStatus).toHaveBeenCalledTimes(1))
  })

  it('the wired cwd edge ignores changes while a session switch is busy', async () => {
    // Sequential: `wire` pulls `session` itself, so importing it afterwards
    // guarantees the same module instance the subscriptions captured.
    const { wireStores } = await import('./wire')
    const { $busy, $currentCwd } = await import('./session')

    wireStores()
    $busy.set(true)
    $currentCwd.set('/work/busy-repo')

    await new Promise(resolve => setTimeout(resolve, 150))
    expect(git.repoStatus).not.toHaveBeenCalled()

    $busy.set(false)
    await vi.waitFor(() => expect(git.repoStatus).toHaveBeenCalled())
  })
})
