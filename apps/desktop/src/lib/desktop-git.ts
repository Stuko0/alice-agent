import type {
  AliceGitBranch,
  AliceGitRemoteInfo,
  AliceGitWorktree,
  AliceRepoStatus,
  AliceReviewList,
  AliceReviewShipInfo
} from '@/global'

import { desktopFsProfile, isDesktopFsRemoteMode } from './desktop-fs'

// Remote-aware git facade. Locally the desktop runs git through Electron
// (window.aliceDesktop.git); on a remote gateway that's the wrong filesystem,
// so we mirror the same surface over the dashboard REST API (/api/git/*) — the
// coding rail, worktree lanes, review pane, and branch ops then act on the
// BACKEND repo where sessions actually run. Mirrors desktop-fs.ts.

type GitBridge = NonNullable<NonNullable<Window['aliceDesktop']>['git']>

function desktopApi<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const desktop = window.aliceDesktop

  if (!desktop) {
    throw new Error('Alice Desktop bridge is unavailable')
  }

  return desktop.api<T>(
    body ? { body, method: 'POST', path, profile: desktopFsProfile() } : { path, profile: desktopFsProfile() }
  )
}

function gitGet<T>(route: string, params: Record<string, boolean | null | string | undefined>): Promise<T> {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      query.set(key, String(value))
    }
  }

  return desktopApi<T>(`/api/git/${route}?${query.toString()}`)
}

function gitPost<T>(route: string, body: Record<string, unknown>): Promise<T> {
  return desktopApi<T>(`/api/git/${route}`, body)
}

const remoteGit: GitBridge = {
  worktreeList: async repoPath =>
    (await gitGet<{ worktrees: AliceGitWorktree[] }>('worktrees', { path: repoPath })).worktrees,

  worktreeAdd: (repoPath, options) => gitPost('worktree/add', { path: repoPath, ...options }),

  worktreeRemove: (repoPath, worktreePath, options) =>
    gitPost('worktree/remove', { force: options?.force ?? false, path: repoPath, worktreePath }),

  branchSwitch: (repoPath, branch) => gitPost('branch/switch', { branch, path: repoPath }),

  branchList: async repoPath =>
    (await gitGet<{ branches: AliceGitBranch[] }>('branches', { path: repoPath })).branches,

  remoteInfo: repoPath => gitGet<AliceGitRemoteInfo>('remote', { path: repoPath }),

  askpassRespond: (requestId, answer) =>
    gitPost<{ status: string }>('askpass/respond', { answer, request_id: requestId }),

  repoStatus: repoPath => gitGet<AliceRepoStatus | null>('status', { path: repoPath }),

  fileDiff: async (repoPath, filePath) =>
    (await gitGet<{ diff: string }>('file-diff', { file: filePath, path: repoPath })).diff,

  review: {
    list: (repoPath, scope, baseRef) =>
      gitGet<AliceReviewList>('review/list', { base: baseRef, path: repoPath, scope }),

    diff: async (repoPath, filePath, scope, baseRef, staged) =>
      (await gitGet<{ diff: string }>('review/diff', { base: baseRef, file: filePath, path: repoPath, scope, staged }))
        .diff,

    stage: (repoPath, filePath) => gitPost('review/stage', { file: filePath ?? null, path: repoPath }),

    unstage: (repoPath, filePath) => gitPost('review/unstage', { file: filePath ?? null, path: repoPath }),

    revert: (repoPath, filePath) => gitPost('review/revert', { file: filePath ?? null, path: repoPath }),

    revParse: async (repoPath, ref) =>
      (await gitGet<{ sha: null | string }>('review/rev-parse', { path: repoPath, ref })).sha,

    commit: (repoPath, message, push) => gitPost('review/commit', { message, path: repoPath, push }),

    commitContext: repoPath => gitGet('review/commit-context', { path: repoPath }),

    push: repoPath => gitPost('review/push', { path: repoPath }),

    shipInfo: repoPath => gitGet<AliceReviewShipInfo>('review/ship-info', { path: repoPath }),

    createPr: repoPath => gitPost('review/create-pr', { path: repoPath })
  },

  // Repo discovery is a local-disk crawl; on a remote gateway the backend
  // already merges session-derived repos, so this is a no-op.
  scanRepos: async () => []
}

// Always-routes-through-HTTP implementation of `remoteInfo`. The local
// Electron bridge (`window.aliceDesktop.git`) doesn't expose `remoteInfo` —
// the gateway REST API is the single source of truth for the origin remote,
// so we go through `desktop.api` regardless of whether the FS is local or
// remote. This keeps the desktop-git surface area uniform and prevents
// "n.remoteInfo is not a function" crashes when the user opens the Git
// statusbar button on a local session.
function httpRemoteInfo(repoPath: string): Promise<AliceGitRemoteInfo> {
  const desktop = window.aliceDesktop
  if (!desktop) {
    return Promise.reject(new Error('Alice Desktop bridge is unavailable'))
  }
  return desktop.api<AliceGitRemoteInfo>({
    path: `/api/git/remote?path=${encodeURIComponent(repoPath)}`,
    profile: desktopFsProfile()
  })
}

// Same story for `askpassRespond`: the gateway long-poll endpoint accepts
// the user's answer via plain HTTP. We wrap it the same way as
// `httpRemoteInfo` so the renderer doesn't have to care whether the
// desktop is in local or remote mode.
function httpAskpassRespond(requestId: string, answer: string): Promise<{ status: string }> {
  const desktop = window.aliceDesktop
  if (!desktop) {
    return Promise.reject(new Error('Alice Desktop bridge is unavailable'))
  }
  return desktop.api<{ status: string }>({
    body: { answer, request_id: requestId },
    method: 'POST',
    path: '/api/git/askpass/respond',
    profile: desktopFsProfile()
  })
}

export function desktopGit(): GitBridge | undefined {
  if (isDesktopFsRemoteMode()) {
    return remoteGit
  }
  // Local mode: wrap the Electron bridge and override methods that the
  // native bridge doesn't expose yet (remoteInfo + askpassRespond) with
  // the HTTP path. Other methods stay on the native bridge (faster).
  const local = window.aliceDesktop?.git
  if (!local) {
    return undefined
  }
  return { ...local, askpassRespond: httpAskpassRespond, remoteInfo: httpRemoteInfo }
}
