import { type StatusbarItemsOptions, useStatusbarItems } from './hooks/use-statusbar-items'
import type { StatusbarItem } from './statusbar-controls'
import { StatusbarControls } from './statusbar-controls'

/**
 * Owns the statusbar's ~20 atom subscriptions.
 *
 * They used to live in the composition root, so token-usage / busy / subagent
 * updates re-rendered the whole shell. Here they only redraw the statusbar.
 */
export function StatusbarHost({ options }: { options: StatusbarItemsOptions }) {
  const { leftStatusbarItems, statusbarItems }: {
    leftStatusbarItems: readonly StatusbarItem[]
    statusbarItems: readonly StatusbarItem[]
  } = useStatusbarItems(options as StatusbarItemsOptions)

  return <StatusbarControls items={statusbarItems} leftItems={leftStatusbarItems} />
}
