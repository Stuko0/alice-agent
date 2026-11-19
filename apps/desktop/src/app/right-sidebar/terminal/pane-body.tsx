import { useStore } from '@nanostores/react'

import { cn } from '@/lib/utils'

import { $terminalAsRow } from '../store'

import { TerminalPaneChrome } from './chrome'

/**
 * The terminal pane's body. Lives in its own component so the row/column flag
 * (`$terminalAsRow`) is subscribed HERE, not in the composition root: moving the
 * terminal between a rail column and a bottom row must not re-render the shell.
 */
export function TerminalPaneBody() {
  const asRow = useStore($terminalAsRow)

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-(--ui-editor-surface-background)',
        asRow ? 'border-l border-(--ui-stroke-secondary) pt-0' : 'pt-0'
      )}
    >
      <TerminalPaneChrome />
    </div>
  )
}
