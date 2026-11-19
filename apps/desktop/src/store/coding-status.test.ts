import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AliceRepoStatus } from '@/global'

import { $busy } from './session'
import { $repoStatus, refreshRepoStatus, wireCodingStatus } from './coding-status'
import { $currentCwd } from './session'

const sampleStatus: AliceRepoStatus = {
  branch: 'feature/login',
  defaultBranch: 'main',
  detached: false,
  ahead: 1,
  behind: 0,
  staged: 1,
  unstaged: 2,
  untracked: 0,
  conflicted: 0,
  changed: 3,
  added: 12,
  removed: 4,
  files: []
}

function stubProbe(impl: (cwd: string) => Promise<AliceRepoStatus | null>) {
  ;(window as unknown as { aliceDesktop?: unknown }).aliceDesktop = { git: { repoStatus: impl } }
}

describe('refreshRepoStatus', () => {
  beforeEach(() => {
    // The edge subscriptions are explicit now (D1); opt in per file.
    wireCodingStatus()
    $repoStatus.set(null)
    $currentCwd.set('')
    delete (window as unknown as { aliceDesktop?: unknown }).aliceDesktop
  })

  afterEach(() => {
    $busy.set(false)
    vi.useRealTimers()
    delete (window as unknown as { aliceDesktop?: unknown }).aliceDesktop
  })

  it('defers the cwd-triggered probe while a switch is in flight', async () => {
    // A session switch sets cwd, then resumes. Probing git on that edge competes
    // with the transcript paint; the busy→idle edge must own the refresh.
    vi.useFakeTimers()
    const probe = vi.fn(async () => sampleStatus)
    stubProbe(probe)

    $busy.set(true)
    $currentCwd.set('/work/next-repo')

    await vi.advanceTimersByTimeAsync(250)
    expect(probe).not.toHaveBeenCalled()

    $busy.set(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(probe).toHaveBeenCalledWith('/work/next-repo')
  })

  it('populates $repoStatus from the probe for an explicit cwd', async () => {
    stubProbe(async () => sampleStatus)
    await refreshRepoStatus('/repo')
    expect($repoStatus.get()).toEqual(sampleStatus)
  })

  it('falls back to the active session cwd when none is passed', async () => {
    const probe = vi.fn(async () => sampleStatus)
    stubProbe(probe)
    $currentCwd.set('/active/repo')
    await refreshRepoStatus()
    expect(probe).toHaveBeenCalledWith('/active/repo')
  })

  it('clears status when there is no cwd', async () => {
    stubProbe(async () => sampleStatus)
    $repoStatus.set(sampleStatus)
    await refreshRepoStatus('   ')
    expect($repoStatus.get()).toBeNull()
  })

  it('clears status when the probe is unavailable (remote backend)', async () => {
    $repoStatus.set(sampleStatus)
    await refreshRepoStatus('/repo')
    expect($repoStatus.get()).toBeNull()
  })

  it('clears status when the probe throws', async () => {
    stubProbe(async () => {
      throw new Error('not a repo')
    })
    $repoStatus.set(sampleStatus)
    await refreshRepoStatus('/repo')
    expect($repoStatus.get()).toBeNull()
  })
})
