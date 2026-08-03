import { Tip } from '@/components/ui/tooltip'

type RemoteInfo = {
  branch: null | string
  prUrl: null | string
  provider: 'azure-devops' | 'bitbucket' | 'gitea' | 'github' | 'gitlab' | 'none' | 'other'
  remote: null | string
} | null

// Small chip in the review-pane header that names the git host (GitHub /
// GitLab / Gitea / Bitbucket / Azure DevOps) and the current branch. Clicking
// the chip opens the PR/MR creation page in the user's browser. Hides when
// the repo has no origin (or no provider is recognized).
export function ReviewProviderChip({ remoteInfo }: { remoteInfo: RemoteInfo }) {
  if (!remoteInfo || remoteInfo.provider === 'none') {
    return null
  }
  const label =
    remoteInfo.provider === 'github'
      ? 'GitHub'
      : remoteInfo.provider === 'gitlab'
        ? 'GitLab'
        : remoteInfo.provider === 'gitea'
          ? 'Gitea'
          : remoteInfo.provider === 'bitbucket'
            ? 'Bitbucket'
            : remoteInfo.provider === 'azure-devops'
              ? 'Azure DevOps'
              : 'Self-hosted Git'

  const tooltip = remoteInfo.remote ?? label

  return (
    <Tip label={`${label} · ${tooltip}`}>
      <button
        className="flex max-w-[10rem] shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.62rem] font-medium uppercase tracking-wide text-(--ui-text-secondary) hover:text-(--ui-text-primary)"
        disabled={!remoteInfo.prUrl}
        onClick={() => {
          if (remoteInfo.prUrl) {
            void window.lydiaDesktop?.openExternal(remoteInfo.prUrl)
          }
        }}
        type="button"
      >
        <span className="truncate">{label}</span>
        {remoteInfo.branch ? (
          <span className="truncate font-mono text-[0.6rem] opacity-80">:{remoteInfo.branch}</span>
        ) : null}
      </button>
    </Tip>
  )
}
