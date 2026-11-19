import type { ProjectInfo, SessionInfo } from '@/alice'

/**
 * Pure project-mapping helpers shared by the sidebar tree (React) and
 * `store/projects.ts` (data layer). Extracted from
 * `app/chat/sidebar/projects/workspace-groups.ts` for D2: a store must not
 * import page modules.
 */

/** Path split into segments, ignoring trailing slashes and mixed separators. */
export const pathSegments = (path: string): string[] =>
  path
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean)

/** True when `target` equals `folder` or is nested under it (segment-wise). */
export function isPathUnder(folder: string, target: string): boolean {
  const f = pathSegments(folder)
  const t = pathSegments(target)

  if (!f.length || f.length > t.length) {
    return false
  }

  return f.every((seg, i) => seg === t[i])
}

// The `.worktrees` dir for a KANBAN-TASK worktree path, else null. Only matches
// task worktrees (`<repo>/.worktrees/t_<hex>`, the `t_…` id kanban_db mints) so
// the many ephemeral task worktrees collapse into one lane — while user-named
// "New worktree" dirs (`<repo>/.worktrees/<slug>`) stay as their own lanes.
const KANBAN_DIR_RE = /^(.*[/\\]\.worktrees)[/\\]t_[0-9a-f]+[/\\]?$/

export function kanbanWorktreeDir(path: string): null | string {
  return path.match(KANBAN_DIR_RE)?.[1] ?? null
}

/**
 * The project a live session belongs to (overview membership) — explicit project
 * by longest-prefix folder, else the repo root (the auto-project id). An IN-TREE
 * linked worktree (`<repoRoot>/.worktrees/<slug>`) belongs to the SAME project as
 * its repo root (the root is right there in the path), so a freshly-created
 * worktree session surfaces in the overview at once instead of waiting for the
 * next backend refresh.
 */
export function liveSessionProjectId(session: SessionInfo, explicitProjects: ProjectInfo[]): null | string {
  const cwd = (session.cwd || '').trim()

  if (!cwd || kanbanWorktreeDir(cwd)) {
    return null
  }

  // No persisted repo root yet (brand-new session) → the cwd is the root.
  const repoRoot = (session.git_repo_root || '').trim() || cwd
  const underRepo = cwd === repoRoot || cwd.startsWith(`${repoRoot}/`) || cwd.startsWith(`${repoRoot}\\`)

  if (!underRepo) {
    return null
  }

  let projectId = ''
  let bestLen = -1

  for (const project of explicitProjects) {
    if (project.archived) {
      continue
    }

    for (const folder of project.folders) {
      if (isPathUnder(folder.path, cwd) || isPathUnder(folder.path, repoRoot)) {
        const len = pathSegments(folder.path).length

        if (len > bestLen) {
          bestLen = len
          projectId = project.id
        }
      }
    }
  }

  return projectId || repoRoot
}
