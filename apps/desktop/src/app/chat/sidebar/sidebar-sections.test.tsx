import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppView } from '../../routes'
import { RecentsHeaderAction } from './recents-header-action'
import { SidebarNav } from './sidebar-nav'

// D3 contract: the sidebar's static chrome must not re-render when the session
// list / working set changes. We count real child renders (the menu rows and the
// header icons) rather than relying on DOM diffs.

const counts = { codicon: 0, navRow: 0 }

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      sidebar: {
        nav: { artifacts: 'Artifacts', messaging: 'Messaging', 'new-session': 'New session', skills: 'Skills' },
        projects: { back: 'Back', newButton: 'New project' },
        showProjects: 'Show projects',
        showSessions: 'Show sessions'
      }
    }
  })
}))

vi.mock('@/components/ui/codicon', () => ({
  Codicon: () => {
    counts.codicon += 1

    return <span data-testid="codicon" />
  }
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children }: { children?: React.ReactNode }) => {
    counts.navRow += 1

    return <button type="button">{children}</button>
  },
  SidebarMenuItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('./projects', () => ({
  ProjectMenu: () => <span data-testid="project-menu" />,
  StartWorkButton: () => <span data-testid="start-work" />
}))

const onNavigate = () => undefined
// Production passes stable handlers here (store functions / useCallback), so the
// memo can bail. Inline arrows would legitimately invalidate it.
const onNewSessionInWorkspace = () => undefined
const openProjectCreate = () => undefined

function NavParent({ view = 'chat' as AppView }) {
  const [tick, setTick] = useState(0)

  return (
    <div data-tick={tick}>
      <button onClick={() => setTick(value => value + 1)} type="button">
        bump
      </button>
      <SidebarNav
        contentVisible
        currentView={view}
        newSessionKbdFlash={false}
        onNavigate={onNavigate}
      />
    </div>
  )
}

function HeaderParent({ agentsGrouped = false }: { agentsGrouped?: boolean }) {
  const [tick, setTick] = useState(0)

  return (
    <div data-tick={tick}>
      <button onClick={() => setTick(value => value + 1)} type="button">
        bump
      </button>
      <RecentsHeaderAction
        activeProjectId="p1"
        agentsGrouped={agentsGrouped}
        hasAgentSessions
        inProject={false}
        onNewSessionInWorkspace={onNewSessionInWorkspace}
        openProjectCreate={openProjectCreate}
        showAllProfiles={false}
      />
    </div>
  )
}

describe('sidebar sections are memoized (D3)', () => {
  beforeEach(() => {
    counts.codicon = 0
    counts.navRow = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('SidebarNav does not re-render when an unrelated parent state changes', () => {
    const { getByText } = render(<NavParent />)

    expect(counts.navRow).toBe(4)

    act(() => {
      getByText('bump').click()
    })

    expect(counts.navRow).toBe(4)
  })

  it('SidebarNav re-renders when its view prop changes (control)', () => {
    const { rerender } = render(<NavParent view="chat" />)

    expect(counts.navRow).toBe(4)

    rerender(<NavParent view="skills" />)

    expect(counts.navRow).toBe(8)
  })

  it('RecentsHeaderAction does not re-render on unrelated parent state', () => {
    const { getByText } = render(<HeaderParent />)

    const afterMount = counts.codicon

    expect(afterMount).toBeGreaterThan(0)

    act(() => {
      getByText('bump').click()
    })

    expect(counts.codicon).toBe(afterMount)
  })

  it('RecentsHeaderAction re-renders when its grouped flag flips (control)', () => {
    const { rerender } = render(<HeaderParent agentsGrouped={false} />)

    const afterMount = counts.codicon

    rerender(<HeaderParent agentsGrouped />)

    expect(counts.codicon).toBeGreaterThan(afterMount)
  })
})
