import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { sessionTitle } from '@/lib/chat-runtime'
import { openCommandPalette } from '@/store/command-palette'
import { $selectedStoredSessionId, $sessions } from '@/store/session'


interface RunningHeadProps {
  onDeleteSession: () => void
  onTogglePin: () => void
}

/**
 * Minimal running head: wordmark + session title on the left, a model chip and
 * the command palette on the right. Window chrome stays native; the old
 * button clusters moved into the spine and the ⋯ menu.
 */
export function RunningHead({ onDeleteSession, onTogglePin }: RunningHeadProps) {
  const sessions = useStore($sessions)
  const selectedId = useStore($selectedStoredSessionId)

  const selected = sessions.find(s => s.id === selectedId || s._lineage_root_id === selectedId)
  const title = selected ? sessionTitle(selected) : 'New session'

  return (
    <header
      className="relative z-20 flex h-(--titlebar-height,40px) w-full shrink-0 items-center gap-3 border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) pl-[max(0.9rem,var(--titlebar-content-inset,0rem))] pr-[calc(var(--titlebar-tools-right,0.75rem)+0.75rem)] [-webkit-app-region:drag]"
      data-slot="running-head"
    >
      <span className="font-[family-name:var(--font-display)] text-[1.05rem] font-semibold uppercase tracking-[0.14em] text-foreground">
        Alice
      </span>
      <span aria-hidden="true" className="text-(--ui-text-quaternary)">
        ·
      </span>
      <span className="min-w-0 truncate text-[0.8rem] text-(--ui-text-secondary)">{title}</span>

      <span className="flex-1" />

      <button
        aria-label="Open command palette"
        className="hidden h-7 items-center gap-1 rounded-sm border border-(--ui-stroke-secondary) px-2 text-[0.72rem] text-(--ui-text-tertiary) hover:text-foreground md:inline-flex [-webkit-app-region:no-drag]"
        onClick={() => openCommandPalette()}
        type="button"
      >
        <Codicon name="search" size="0.7rem" />
        <span className="font-mono">⌘K</span>
      </button>

      {selectedId ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
          <Button
            aria-label="More"
            className="text-(--ui-text-tertiary) [-webkit-app-region:no-drag]"
            size="icon-titlebar"
            variant="ghost"
          >
            ⋯
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={onTogglePin}>
            <Codicon name="pin" size="0.8rem" /> Pin / unpin
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDeleteSession}>
            <Codicon name="trash" size="0.8rem" /> Delete session
          </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <span aria-hidden="true" className="hidden items-center gap-1.5 md:flex">
        <i className="size-2 rounded-full border border-(--ui-stroke-secondary)" />
        <i className="size-2 rounded-full border border-(--ui-stroke-secondary)" />
        <i className="size-2 rounded-full border border-(--ui-stroke-secondary) bg-(--theme-primary)" />
      </span>
    </header>
  )
}
