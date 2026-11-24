import { type ReactNode, useEffect, useRef, useState } from 'react'

import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { PAGE_INSET_X } from '../layout-constants'

interface OverlaySplitLayoutProps {
  children: ReactNode
  className?: string
}

interface OverlaySidebarProps {
  children: ReactNode
  className?: string
}

interface OverlayMainProps {
  children: ReactNode
  className?: string
}

interface OverlayNavItemProps {
  active: boolean
  icon: IconComponent
  /** Study cabinet: a two-digit section number shown instead of the icon. */
  index?: string
  label: string
  // Renders as an indented child of another nav item: smaller icon and a
  // lighter active state so it never competes with the boxed parent item.
  nested?: boolean
  onClick: () => void
  trailing?: ReactNode
}

// Below this width the two-column cabinet turns into a stacked one. Measured
// from the overlay's own box (not a media query) because display scale is CSS
// zoom: the viewport still reports its unzoomed width, so `@media`/`@container`
// rules never see 150%.
const STACK_BELOW_PX = 760

export function OverlaySplitLayout({ children, className }: OverlaySplitLayoutProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [stacked, setStacked] = useState(false)

  useEffect(() => {
    const element = ref.current

    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width

      setStacked(width > 0 && width < STACK_BELOW_PX)
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex w-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" ref={ref}>
      <div
        className={cn(
          'grid h-full w-full min-h-0 min-w-0 flex-1 overflow-hidden bg-transparent',
          stacked
            ? 'grid-cols-1 grid-rows-[minmax(6rem,18rem)_minmax(0,1fr)]'
            : 'grid-cols-[clamp(13rem,20vw,18.25rem)_minmax(0,1fr)]',
          className
        )}
        data-split-stacked={stacked ? 'true' : undefined}
      >
        {children}
      </div>
    </div>
  )
}

export function OverlaySidebar({ children, className }: OverlaySidebarProps) {
  return (
    <aside
      className={cn(
        // pt clears the in-card close button (the OverlayView now insets the
        // whole card below the OS titlebar); the bg fills from the card's top
        // edge so there's no surface-colored gap above the sidebar.
        'flex min-h-0 flex-col gap-px overflow-y-auto border-r border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) px-3 pb-3 pt-[calc(var(--titlebar-height)/2+1.25rem)]',
        className
      )}
    >
      {children}
    </aside>
  )
}

export function OverlayMain({ children, className }: OverlayMainProps) {
  return (
    <main
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent pb-3 pt-[calc(var(--titlebar-height)/2+1rem)]',
        PAGE_INSET_X,
        className
      )}
    >
      {children}
    </main>
  )
}

export function OverlayNavItem({ active, icon: Icon, index, label, nested, onClick, trailing }: OverlayNavItemProps) {
  return (
    <button
      className={cn(
        'flex w-full items-center justify-start gap-2.5 rounded-sm border px-2.5 text-left text-[length:var(--conversation-text-font-size)] font-normal transition-colors',
        nested ? 'h-7 border-transparent pl-9' : 'h-8 border-transparent',
        active
          ? 'bg-(--ui-bg-tertiary) font-medium text-foreground shadow-[inset_2px_0_0_var(--theme-primary)]'
          : 'bg-transparent text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground',
        nested && !active && 'text-(--ui-text-tertiary)'
      )}
      onClick={onClick}
      type="button"
    >
      {index ? (
        <span
          aria-hidden="true"
          className={cn(
            'w-4 shrink-0 font-[family-name:var(--font-display)] text-[0.72rem] tracking-[0.12em] tabular-nums',
            active ? 'text-(--accent-text)' : 'text-(--ui-text-quaternary)'
          )}
        >
          {index}
        </span>
      ) : (
        <Icon
          className={cn(
            'shrink-0',
            nested ? 'size-3.5' : 'size-4',
            active ? 'text-foreground/80' : 'text-muted-foreground/80'
          )}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}
