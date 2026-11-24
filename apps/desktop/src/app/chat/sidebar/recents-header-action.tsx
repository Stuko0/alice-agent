import { memo } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { setSidebarAgentsGrouped, setSidebarRecentsOpen } from '@/store/layout'
import { exitProjectScope } from '@/store/projects'

import type { SidebarProjectTree } from './projects'
import { ProjectMenu, StartWorkButton } from './projects'

// Section-header action icons stay hidden until the whole header row is hovered
// (group/section lives on SidebarSectionHeader), mirroring the artifacts/file
// browser header affordances. focus-visible keeps them keyboard-reachable.
const HEADER_ACTION_BTN =
  'text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground group-hover/section:opacity-100 focus-visible:opacity-100'

// The view toggle (overview group toggle / in-project back) is the one control
// that stays visible at all times — it's the stable navigation affordance, not
// a hover-revealed action.
const HEADER_NAV_BTN =
  'text-(--ui-text-tertiary) opacity-70 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100 focus-visible:opacity-100'

interface RecentsHeaderActionProps {
  activeProjectId: null | string
  agentsGrouped: boolean
  /** `agentSessions.length > 0` — collapsed to a boolean so list identity churn
   * cannot invalidate the memo. */
  hasAgentSessions: boolean
  enteredProject?: SidebarProjectTree
  inProject: boolean
  onNewSessionInWorkspace: (path: null | string) => void
  openProjectCreate: () => void
  showAllProfiles: boolean
}

/**
 * The recents section's header controls, extracted and memoized (D3): this block
 * is rebuilt on every ChatSidebar render (session list, working set, scroll
 * state), even though it only depends on the project scope and two view flags.
 */
export const RecentsHeaderAction = memo(function RecentsHeaderAction({
  activeProjectId,
  agentsGrouped,
  enteredProject,
  hasAgentSessions,
  inProject,
  onNewSessionInWorkspace,
  openProjectCreate,
  showAllProfiles
}: RecentsHeaderActionProps) {
  const { t } = useI18n()
  const s = t.sidebar

  if (inProject && enteredProject) {
    return (
      <div className="group/workspace flex shrink-0 items-center gap-0.5">
        {enteredProject.path && (
          <StartWorkButton onStarted={onNewSessionInWorkspace} repoPath={enteredProject.path} />
        )}
        <ProjectMenu
          isActive={enteredProject.id === activeProjectId}
          onExitScope={exitProjectScope}
          project={enteredProject}
          scoped
        />
        <div className="grid size-6 place-items-center">
          <Button
            aria-label={s.showProjects}
            className={HEADER_NAV_BTN}
            onClick={event => {
              event.stopPropagation()
              exitProjectScope()
            }}
            size="icon-xs"
            variant="ghost"
          >
            <Codicon name="list-unordered" size="0.75rem" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {!showAllProfiles ? (
        <Button
          aria-label={agentsGrouped ? s.projects.newButton : s.nav['new-session']}
          className={HEADER_ACTION_BTN}
          onClick={event => {
            event.stopPropagation()

            if (agentsGrouped) {
              openProjectCreate()
            } else {
              onNewSessionInWorkspace(null)
            }
          }}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="add" size="0.75rem" />
        </Button>
      ) : null}
      <div className="grid size-6 place-items-center">
        {!showAllProfiles && hasAgentSessions ? (
          <Button
            aria-label={agentsGrouped ? s.showSessions : s.showProjects}
            className={cn(
              HEADER_NAV_BTN,
              agentsGrouped && 'bg-(--ui-control-active-background) text-foreground opacity-100'
            )}
            onClick={event => {
              event.stopPropagation()
              setSidebarRecentsOpen(true)
              setSidebarAgentsGrouped(!agentsGrouped)
            }}
            size="icon-xs"
            variant="ghost"
          >
            <Codicon name={agentsGrouped ? 'list-unordered' : 'root-folder'} size="0.75rem" />
          </Button>
        ) : null}
      </div>
    </div>
  )
})
