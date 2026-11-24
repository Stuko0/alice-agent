import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { $terminalBannerHint, dismissBannerHint } from './banner-hint'
import { TerminalSlot } from './persistent'
import { TerminalRail } from './rail'

/** Pane-side terminal chrome: the body slot (which the persistent overlay chases)
 *  plus the tab rail. Lives in the real pane DOM — NOT the z-4 terminal overlay —
 *  so the rail sits above the collapsed sidebars' z-30 hover-reveal triggers
 *  (z-40, like the thread timeline) and suppresses them while hovered.
 *
 *  The rail is mounted UNCONDITIONALLY, even with zero tabs (it shows the "+"
 *  control). Its 36px is part of the slot's width budget from the first frame:
 *  mounting it only once a terminal exists shrank the slot right after the PTY
 *  started, and the resulting SIGWINCH reflowed the shell's startup banner into
 *  unreadable art. Stable geometry first, shell second. */
function TerminalPaneChromeInner() {
  const bannerHint = useStore($terminalBannerHint)

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {bannerHint ? <BannerHintStrip hint={bannerHint} /> : null}
        <TerminalSlot />
      </div>
      <TerminalRail />
    </div>
  )
}

/** One-time offer: a pinned-width shell banner can't fit a narrow pane. */
function BannerHintStrip({ hint }: { hint: NonNullable<ReturnType<typeof $terminalBannerHint.get>> }) {
  const clear = () => {
    void window.aliceDesktop?.terminal?.write(hint.sessionId, 'clear\n')
    dismissBannerHint()
  }

  return (
    <div className="m-2 mb-1 flex shrink-0 items-center gap-2 rounded-sm border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-2.5 py-1.5 text-[0.72rem] text-(--ui-text-secondary)">
      <span className="min-w-0 flex-1">
        This shell&apos;s startup banner is wider than the pane.
      </span>
      <button
        className="rounded-sm px-2 py-0.5 font-medium text-foreground hover:bg-(--chrome-action-hover)"
        onClick={clear}
        type="button"
      >
        Clear screen
      </button>
      <button
        aria-label="Dismiss"
        className="grid size-5 place-items-center rounded-sm text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
        onClick={dismissBannerHint}
        type="button"
      >
        ×
      </button>
    </div>
  )
}

export const TerminalPaneChrome = memo(TerminalPaneChromeInner)
