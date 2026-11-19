import { memo } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { KbdGroup } from '@/components/ui/kbd'
import { SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useI18n } from '@/i18n'
import { comboTokens } from '@/lib/keybinds/combo'
import { cn } from '@/lib/utils'
import { $newChatProfile } from '@/store/profile'

import { ARTIFACTS_ROUTE, MESSAGING_ROUTE, SKILLS_ROUTE } from '../../routes'
import type { AppView } from '../../routes'
import type { SidebarNavItem } from '../../types'

export const SIDEBAR_NAV: SidebarNavItem[] = [
  {
    action: 'new-session',
    icon: props => <Codicon name="robot" {...props} />,
    id: 'new-session',
    label: ''
  },
  {
    icon: props => <Codicon name="symbol-misc" {...props} />,
    id: 'skills',
    label: '',
    route: SKILLS_ROUTE
  },
  { icon: props => <Codicon name="comment" {...props} />, id: 'messaging', label: '', route: MESSAGING_ROUTE },
  { icon: props => <Codicon name="files" {...props} />, id: 'artifacts', label: '', route: ARTIFACTS_ROUTE }
]

const NEW_SESSION_KBD = comboTokens('mod+n')

interface SidebarNavProps {
  contentVisible: boolean
  currentView: AppView
  newSessionKbdFlash: boolean
  onNavigate: (item: SidebarNavItem) => void
}

/**
 * The fixed top navigation. Extracted and memoized (D3): it depends on the
 * route and a few booleans, but sat inside ChatSidebar's render, so every
 * session-list tick rebuilt all of it. `onNavigate` is stable (a useCallback in
 * the controller), so a list update no longer touches these rows.
 */
export const SidebarNav = memo(function SidebarNav({
  contentVisible,
  currentView,
  newSessionKbdFlash,
  onNavigate
}: SidebarNavProps) {
  const { t } = useI18n()
  const s = t.sidebar

  return (
    <SidebarGroup className="shrink-0 p-0 pb-2 pt-[calc(var(--titlebar-height)+0.375rem)]">
      <SidebarGroupContent>
        <SidebarMenu className="gap-px">
          {SIDEBAR_NAV.map(item => {
            const isInteractive = Boolean(item.action) || Boolean(item.route)

            const active =
              (item.id === 'skills' && currentView === 'skills') ||
              (item.id === 'messaging' && currentView === 'messaging') ||
              (item.id === 'artifacts' && currentView === 'artifacts')

            const isNewSession = item.id === 'new-session'

            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  aria-disabled={!isInteractive}
                  className={cn(
                    // no-drag: these rows sit directly under the titlebar's
                    // [-webkit-app-region:drag] strips (app-shell.tsx), with only
                    // 6px of clearance. Drag regions win hit-testing over DOM
                    // (pointer-events can't override), and on Linux/WSLg the
                    // resolved region has been observed to swallow clicks on the
                    // top rows. Same carve-out as USER_BUBBLE_BASE_CLASS in
                    // thread.tsx.
                    'flex h-7 w-full justify-start gap-2 rounded-md border border-transparent px-2 text-left text-[0.8125rem] font-medium text-(--ui-text-secondary) transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none',
                    active &&
                      'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground shadow-none hover:border-(--ui-stroke-tertiary)!',
                    !isInteractive &&
                      'cursor-default hover:border-transparent hover:bg-transparent hover:text-inherit'
                  )}
                  onClick={() => {
                    // A plain new session lands in whatever profile the live
                    // gateway is on (= the active switcher context). null →
                    // no swap. The switcher header is the single place to
                    // change which profile that is.
                    if (isNewSession) {
                      $newChatProfile.set(null)
                    }

                    onNavigate(item)
                  }}
                  tooltip={s.nav[item.id] ?? item.label}
                  type="button"
                >
                  <item.icon className="size-4 shrink-0 text-[color-mix(in_srgb,currentColor_72%,transparent)]" />
                  {contentVisible && (
                    <>
                      <span className="min-w-0 flex-1 truncate">{s.nav[item.id] ?? item.label}</span>
                      {isNewSession && (
                        <KbdGroup
                          className={cn('ml-auto opacity-55', newSessionKbdFlash && 'opacity-100!')}
                          keys={[...NEW_SESSION_KBD]}
                          size="sm"
                        />
                      )}
                    </>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
})
