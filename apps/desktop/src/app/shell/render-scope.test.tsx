import { useStore } from '@nanostores/react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useMemo } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $paneStates } from '@/store/panes'
import { $reviewOpen } from '@/store/review'

import { MainPaneRoutes } from './main-pane-routes'

// P1.1 invariant: a pane/layout atom changing must NOT re-render the chat
// subtree. The composition root does re-render (it needs the pane state to lay
// the rail out), but the chat element is memoized on data-only dependencies, so
// React bails out by element identity before touching the transcript.

const chat = { renders: 0 }

function ChatProbe() {
  chat.renders += 1

  return <div data-testid="chat-probe" />
}

function CompositionRoot() {
  // Stands in for DesktopController's pane subscriptions.
  const reviewOpen = useStore($reviewOpen)
  const paneStates = useStore($paneStates)

  // Stands in for `const chatView = useMemo(() => <ChatView … />, [dataDeps])`.
  const chatView = useMemo(() => <ChatProbe />, [])

  return (
    <>
      <button onClick={() => $reviewOpen.set(!reviewOpen)} type="button">
        toggle-review
      </button>
      <span data-testid="pane-state">{paneStates.review?.open ? 'open' : 'closed'}</span>
      <MainPaneRoutes
        chat={chatView}
        chatVisible
        pages={{
          artifacts: <div />,
          messaging: <div />,
          skills: <div />
        }}
      />
    </>
  )
}

describe('render scope (P1.1)', () => {
  beforeEach(() => {
    chat.renders = 0
    $reviewOpen.set(false)
    $paneStates.set({})
  })

  afterEach(() => {
    cleanup()
    $reviewOpen.set(false)
  })

  it('a pane atom toggle re-renders the shell but not the chat subtree', () => {
    render(
      <MemoryRouter initialEntries={['/rt-1']}>
        <CompositionRoot />
      </MemoryRouter>
    )

    expect(chat.renders).toBe(1)
    expect(screen.getByTestId('pane-state').textContent).toBe('closed')

    act(() => {
      $reviewOpen.set(true)
    })

    // The shell observed the change…
    expect(screen.getByTestId('pane-state').textContent).toBe('open')
    // …and the chat did not re-render.
    expect(chat.renders).toBe(1)
  })

  it('sash/width state does not re-render the chat either', () => {
    render(
      <MemoryRouter initialEntries={['/rt-1']}>
        <CompositionRoot />
      </MemoryRouter>
    )

    act(() => {
      $paneStates.set({ review: { open: true, widthOverride: 320 } })
    })

    expect(chat.renders).toBe(1)
  })

  it('a data change outside the memo does re-render the chat (control)', () => {
    function ControlRoot() {
      // Deliberately un-memoized: this is what a fresh element per render does.
      return (
        <MainPaneRoutes
          chat={<ChatProbe />}
          chatVisible
          pages={{ artifacts: <div />, messaging: <div />, skills: <div /> }}
        />
      )
    }

    const { rerender } = render(
      <MemoryRouter initialEntries={['/rt-1']}>
        <ControlRoot />
      </MemoryRouter>
    )

    expect(chat.renders).toBe(1)

    rerender(
      <MemoryRouter initialEntries={['/rt-1']}>
        <ControlRoot />
      </MemoryRouter>
    )

    // Sanity check that the probe counts renders at all.
    expect(chat.renders).toBe(2)
  })
})
