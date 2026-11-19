import type * as React from 'react'

import type { Suit } from '@/components/motifs'
import { SuitMark } from '@/components/motifs'
import { cn } from '@/lib/utils'

interface SidebarPanelLabelProps extends React.ComponentProps<'span'> {
  dotClassName?: string
  /** Decorative section suit; replaces the generic dither dot when set. */
  motif?: Suit
}

export function SidebarPanelLabel({ children, className, dotClassName, motif, ...props }: SidebarPanelLabelProps) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-2 pl-2 text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-(--accent-text)',
        className
      )}
      {...props}
    >
      {motif ? (
        <SuitMark className="text-(--ui-text-secondary) opacity-80" suit={motif} />
      ) : (
        <span aria-hidden="true" className={cn('dither inline-block size-2 shrink-0 rounded-[1px]', dotClassName)} />
      )}
      <span className="min-w-0 truncate leading-none">{children}</span>
    </span>
  )
}
