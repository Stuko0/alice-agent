import { useStore } from '@nanostores/react'

import { compactPath, LiveDuration, usageContextLabel } from '@/lib/statusbar'
import { cn } from '@/lib/utils'
import {
  $busy,
  $currentBranch,
  $currentCwd,
  $currentUsage,
  $gatewayState,
  $sessionStartedAt,
  $turnStartedAt
} from '@/store/session'

const Separator = () => (
  <span aria-hidden="true" className="text-(--ui-stroke-secondary)">
    ·
  </span>
)

/**
 * The Study's margin ribbon: the only persistent status line. It replaces the
 * IDE statusbar with the handful of facts worth keeping in the reading view —
 * model, context, gateway, workspace/branch, elapsed time.
 */
export function Ribbon() {
  const usage = useStore($currentUsage)
  const gatewayState = useStore($gatewayState)
  const cwd = useStore($currentCwd)
  const branch = useStore($currentBranch)
  const busy = useStore($busy)
  const turnStartedAt = useStore($turnStartedAt)
  const sessionStartedAt = useStore($sessionStartedAt)

  const usageLabel = usageContextLabel(usage)
  const workspace = branch || (cwd ? compactPath(cwd, 34) : '')
  const gatewayLive = gatewayState === 'open'

  return (
    <div
      aria-label="Session status"
      className="flex h-6 shrink-0 items-center justify-center gap-2.5 px-4 text-[0.72rem] text-(--ui-text-secondary) tabular-nums"
      data-slot="ribbon"
    >
      {usageLabel ? (
        <span>{usageLabel}</span>
      ) : (
        <span className="font-mono text-(--ui-text-secondary)">context</span>
      )}
      <Separator />
      <span className={cn('inline-flex items-center gap-1', gatewayLive ? 'text-(--theme-midground)' : 'text-(--ui-red)')}>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
        gateway
      </span>
      {workspace ? (
        <>
          <Separator />
          <span className="max-w-56 truncate font-mono">{workspace}</span>
        </>
      ) : null}
      {busy && turnStartedAt ? (
        <>
          <Separator />
          <span className="inline-flex items-center gap-1 text-(--theme-midground)">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            <LiveDuration since={turnStartedAt} />
          </span>
        </>
      ) : sessionStartedAt ? (
        <>
          <Separator />
          <span>
            session <LiveDuration since={sessionStartedAt} />
          </span>
        </>
      ) : null}
    </div>
  )
}
