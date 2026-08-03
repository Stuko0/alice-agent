import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { desktopGit } from './desktop-git'

const repoStatus = vi.fn(async () => ({ branch: 'main' }))
const worktreeList = vi.fn(async () => [{ branch: 'main', detached: false, isMain: true, locked: false, path: '/r' }])
const localGit = { repoStatus, review: { stage: vi.fn() }, worktreeList }

const api = vi.fn(async ({ path }: { path: string }) => {
  if (path.startsWith('/api/git/status')) {
    return { branch: 'remote-main' }
  }

  if (path.startsWith('/api/git/worktrees')) {
    return { worktrees: [{ branch: 'main', detached: false, isMain: true, locked: false, path: '/srv/r' }] }
  }

  if (path.startsWith('/api/git/review/diff')) {
    return { diff: 'remote-diff' }
  }

  if (path.startsWith('/api/git/remote')) {
    return { branch: 'main', provider: 'github', prUrl: 'https://github.com/foo/bar/compare/main', remote: 'git@github.com:foo/bar.git' }
  }

  if (path.startsWith('/api/git/askpass/respond')) {
    return { status: 'ok' }
  }

  return { ok: true }
})

describe('desktop git facade', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { lydiaDesktop: { api, git: localGit } })
    $connection.set(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    $connection.set(null)
  })

  it('uses Electron git locally', async () => {
    $connection.set({ mode: 'local' } as never)

    await expect(desktopGit()?.repoStatus('/work')).resolves.toEqual({ branch: 'main' })
    expect(repoStatus).toHaveBeenCalledWith('/work')
    expect(api).not.toHaveBeenCalled()
  })

  it('routes reads through the backend REST mirror on a remote gateway', async () => {
    $connection.set({ mode: 'remote' } as never)

    await expect(desktopGit()?.repoStatus('/srv/work')).resolves.toEqual({ branch: 'remote-main' })
    expect(api).toHaveBeenCalledWith({ path: '/api/git/status?path=%2Fsrv%2Fwork' })

    // List endpoints unwrap their envelope to the bare array the bridge returns.
    await expect(desktopGit()?.worktreeList('/srv/work')).resolves.toEqual([
      { branch: 'main', detached: false, isMain: true, locked: false, path: '/srv/r' }
    ])

    // review.diff unwraps { diff } to a string.
    await expect(desktopGit()?.review.diff('/srv/work', 'a.txt', 'uncommitted', null, false)).resolves.toBe(
      'remote-diff'
    )

    expect(repoStatus).not.toHaveBeenCalled()
  })

  it('targets the active profile backend so a remote profile never touches the local repo', async () => {
    $connection.set({ mode: 'remote', profile: 'remote-docker' } as never)

    await desktopGit()?.repoStatus('/srv/work')
    await desktopGit()?.review.stage('/srv/work', 'a.txt')

    expect(api).toHaveBeenCalledWith({ path: '/api/git/status?path=%2Fsrv%2Fwork', profile: 'remote-docker' })
    expect(api).toHaveBeenCalledWith({
      body: { file: 'a.txt', path: '/srv/work' },
      method: 'POST',
      path: '/api/git/review/stage',
      profile: 'remote-docker'
    })
  })

  it('sends mutations as POST bodies on a remote gateway', async () => {
    $connection.set({ mode: 'remote' } as never)

    await desktopGit()?.review.stage('/srv/work', 'a.txt')

    expect(api).toHaveBeenCalledWith({
      body: { file: 'a.txt', path: '/srv/work' },
      method: 'POST',
      path: '/api/git/review/stage'
    })
    expect(localGit.review.stage).not.toHaveBeenCalled()
  })

  // Regression: the local Electron bridge doesn't expose `remoteInfo`. The
  // facade used to return it as-is, so opening the Git statusbar button on a
  // local session threw "n.remoteInfo is not a function". The facade must
  // route `remoteInfo` through the gateway HTTP API in BOTH local and
  // remote modes.
  it('exposes remoteInfo on the local bridge via the HTTP route', async () => {
    $connection.set({ mode: 'local' } as never)

    const info = await desktopGit()?.remoteInfo('/work')

    expect(info).toEqual({
      branch: 'main',
      provider: 'github',
      prUrl: 'https://github.com/foo/bar/compare/main',
      remote: 'git@github.com:foo/bar.git'
    })
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/git/remote?path=%2Fwork' })
    )
  })

  it('exposes remoteInfo on a remote gateway via the HTTP route', async () => {
    $connection.set({ mode: 'remote' } as never)

    const info = await desktopGit()?.remoteInfo('/srv/work')

    expect(info?.provider).toBe('github')
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/git/remote?path=%2Fsrv%2Fwork' })
    )
  })

  // The git-credential modal posts the user's answer here from both
  // local and remote modes. The local-mode wrap (added when we wired
  // the askpass shim) used to forget `askpassRespond`, so opening the
  // modal would throw "n.askpassRespond is not a function". This
  // regression test pins both paths.
  it('posts askpass answers through the HTTP route in local mode', async () => {
    $connection.set({ mode: 'local' } as never)

    const result = await desktopGit()?.askpassRespond('req-1', 'hunter2')

    expect(result).toEqual({ status: 'ok' })
    expect(api).toHaveBeenCalledWith({
      body: { answer: 'hunter2', request_id: 'req-1' },
      method: 'POST',
      path: '/api/git/askpass/respond'
    })
  })

  it('posts askpass answers through the HTTP route in remote mode', async () => {
    $connection.set({ mode: 'remote' } as never)

    const result = await desktopGit()?.askpassRespond('req-2', '')

    // Empty answer is the cancel path — git aborts the operation.
    expect(result).toEqual({ status: 'ok' })
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ body: { answer: '', request_id: 'req-2' } })
    )
  })
})
