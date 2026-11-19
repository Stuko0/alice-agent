import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { $terminalTakeover } from '@/app/right-sidebar/store'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { $browserOpen } from '@/store/browser'
import { $browserUnread } from '@/store/browser-tabs'
import { $hapticsMuted, toggleHapticsMuted } from '@/store/haptics'
import { toggleKeybindPanel } from '@/store/keybinds'
import { $fileBrowserOpen, $sidebarOpen } from '@/store/layout'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $reviewOpen } from '@/store/review'
import { $currentCwd, $gatewayState } from '@/store/session'

import { AGENTS_ROUTE, CRON_ROUTE, PROFILES_ROUTE } from '../routes'

interface SpineProps {
  onBrowser: () => void
  onCatalog: () => void
  onNewSession: () => void
  onFiles: () => void
  onProfiles: () => void
  onReview: () => void
  onSettings: () => void
  onTerminal: () => void
}

const SPINE_HINT_KEY = 'alice.desktop.spine-hint.v1'

/** Hover label used by the non-suit controls (the suits have their own). */
function SpineHoverLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-[3.35rem] z-50 whitespace-nowrap rounded-sm border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2 py-1 text-[0.72rem] text-foreground opacity-0 shadow-[var(--shadow-ink)] transition-opacity duration-100 group-hover/spine:opacity-100">
      {children}
    </span>
  )
}

interface SpineItem {
  active: boolean
  glyph: string
  id: string
  label: string
  onSelect: () => void
}

/**
 * The Study's navigation spine: one 72px rail with the four card suits.
 *
 * ♠ sessions · ♥ review · ♦ preview · ♣ terminal. Labels appear on hover and
 * carry the accessible name; the glyph itself is aria-hidden.
 */
export function Spine({ onBrowser, onCatalog, onFiles, onNewSession, onProfiles, onReview, onSettings, onTerminal }: SpineProps) {
  const catalogOpen = useStore($sidebarOpen)
  const reviewOpen = useStore($reviewOpen)
  const filesOpen = useStore($fileBrowserOpen)
  const browserOpen = useStore($browserOpen)
  const browserUnread = useStore($browserUnread)
  const terminalOpen = useStore($terminalTakeover)
  const gatewayState = useStore($gatewayState)
  const activeProfile = useStore($activeGatewayProfile)
  const cwd = useStore($currentCwd)

  const navigate = useNavigate()
  const hapticsMuted = useStore($hapticsMuted)

  // One-time coach mark: name the four suits for a first-run user, then never
  // again. Any interaction or seven seconds dismisses it.
  const [hintOpen, setHintOpen] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    try {
      return window.localStorage.getItem(SPINE_HINT_KEY) === null
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (!hintOpen) {
      return
    }

    const dismiss = () => {
      setHintOpen(false)

      try {
        window.localStorage.setItem(SPINE_HINT_KEY, '1')
      } catch {
        // Storage unavailable: the hint simply stays per-session.
      }
    }

    const timer = window.setTimeout(dismiss, 12_000)

    window.addEventListener('pointerdown', dismiss, { once: true })
    window.addEventListener('keydown', dismiss, { once: true })

    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', dismiss)
    }
  }, [hintOpen])

  const anyDrawerOpen = catalogOpen || reviewOpen || terminalOpen || filesOpen || browserOpen

  useEffect(() => {
    if (!hintOpen || !anyDrawerOpen) {
      return
    }

    setHintOpen(false)

    try {
      window.localStorage.setItem(SPINE_HINT_KEY, '1')
    } catch {
      // Storage unavailable: the hint simply stays per-session.
    }
  }, [anyDrawerOpen, hintOpen])

  const go = (path: string) => {
    triggerHaptic('open')
    navigate(path)
  }

  const items = useMemo<SpineItem[]>(
    () => [
      { active: catalogOpen, glyph: '♠', id: 'sessions', label: 'Sessions', onSelect: onCatalog },
      { active: reviewOpen, glyph: '♥', id: 'review', label: 'Review', onSelect: onReview },
      { active: filesOpen, glyph: '♦', id: 'files', label: 'Files', onSelect: onFiles },
      { active: terminalOpen, glyph: '♣', id: 'terminal', label: 'Terminal', onSelect: onTerminal },
      { active: browserOpen, glyph: '✦', id: 'browser', label: 'Browser', onSelect: onBrowser }
    ],
    [browserOpen, catalogOpen, filesOpen, onBrowser, onCatalog, onFiles, onReview, onTerminal, reviewOpen, terminalOpen]
  )

  const initial = (normalizeProfileKey(activeProfile) || 'default').slice(0, 1).toUpperCase()
  const gatewayLive = gatewayState === 'open'

  return (
    <nav
      aria-label="Primary"
      className="relative z-10 flex w-(--spine-width,72px) shrink-0 flex-col items-center gap-1 border-r border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) pb-3 pt-2"
    >
      {items.map(item => (
        <button
          aria-label={item.label}
          aria-pressed={item.active}
          className={cn(
            'group/spine relative grid size-11 place-items-center rounded-md text-[1.15rem] leading-none text-(--ui-text-tertiary) transition-colors duration-100 hover:bg-(--ui-control-hover-background) hover:text-foreground',
            item.active && 'bg-(--ui-control-active-background) text-(--accent-text) shadow-[inset_2px_0_0_var(--theme-primary)]'
          )}
          key={item.id}
          onClick={() => {
            // Perf probe anchor (see <Pane>): time from the click to the
            // drawer's first painted frame.
            if (typeof window !== 'undefined') {
              ;(window as unknown as { __aliceDrawerClickAt?: number }).__aliceDrawerClickAt = performance.now()
            }

            item.onSelect()
          }}
          type="button"
        >
          <span aria-hidden="true" className="font-serif">
            {item.glyph}
          </span>
          {item.id === 'browser' && browserUnread > 0 ? (
            <span
              aria-label={`${browserUnread} new browser page${browserUnread === 1 ? '' : 's'}`}
              className="absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-(--theme-primary) px-1 font-sans text-[0.55rem] font-semibold leading-4 text-(--ui-bg-chrome)"
            >
              {browserUnread > 9 ? '9+' : browserUnread}
            </span>
          ) : null}
          <span
            className={cn(
              'pointer-events-none absolute left-[3.35rem] z-50 whitespace-nowrap rounded-sm border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2 py-1 text-[0.72rem] text-foreground shadow-[var(--shadow-ink)] transition-opacity duration-100',
              hintOpen ? 'opacity-100' : 'opacity-0 group-hover/spine:opacity-100'
            )}
          >
            {item.label}
          </span>
        </button>
      ))}

      <div className="flex-1" />

      <button
        aria-label="New session"
        className="group/spine relative grid size-11 place-items-center rounded-md text-[1.05rem] text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
        onClick={onNewSession}
        type="button"
      >
        ＋
        <SpineHoverLabel>New session</SpineHoverLabel>
      </button>

      <button
        aria-label={`Profile: ${normalizeProfileKey(activeProfile) || 'default'}`}
        className="group/spine relative grid size-8 place-items-center rounded-full bg-(--theme-primary) font-[family-name:var(--font-display)] text-[0.7rem] text-(--dt-primary-foreground) hover:brightness-110"
        onClick={onProfiles}
        title={cwd ? `Profile · ${cwd}` : 'Profiles'}
        type="button"
      >
        {initial}
        <span
          aria-hidden="true"
          className={cn(
            'absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-(--ui-chat-surface-background)',
            gatewayLive ? 'bg-(--theme-midground)' : 'bg-(--ui-red)'
          )}
        />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Application menu"
            className="group/spine relative grid size-11 place-items-center rounded-md text-[0.95rem] text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
            type="button"
          >
            <span aria-hidden="true">⚙</span>
            <SpineHoverLabel>Settings &amp; app</SpineHoverLabel>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52" side="right">
          <DropdownMenuItem onSelect={onSettings}>
            <Codicon name="settings-gear" size="0.8rem" /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go(PROFILES_ROUTE)}>
            <Codicon name="account" size="0.8rem" /> Profiles
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go(CRON_ROUTE)}>
            <Codicon name="clock" size="0.8rem" /> Cron
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go(AGENTS_ROUTE)}>
            <Codicon name="hubot" size="0.8rem" /> Agents
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => toggleKeybindPanel()}>
            <Codicon name="keyboard" size="0.8rem" /> Keyboard shortcuts
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              triggerHaptic('tap')
              toggleHapticsMuted()
            }}
          >
            <Codicon name={hapticsMuted ? 'unmute' : 'mute'} size="0.8rem" />{' '}
            {hapticsMuted ? 'Unmute haptics' : 'Mute haptics'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onFiles}>
            <Codicon name="files" size="0.8rem" /> Files
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  )
}
