import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appViewForPath, isOverlayView } from '../routes'

import { MainPaneRoutes } from './main-pane-routes'

const chat = { mounts: 0, unmounts: 0 }

function ChatBody() {
  useEffect(() => {
    chat.mounts += 1

    return () => {
      chat.unmounts += 1
    }
  }, [])

  return <div data-testid="chat-body" />
}

function Go({ to }: { to: string }) {
  const navigate = useNavigate()

  return (
    <button onClick={() => navigate(to)} type="button">
      {`go:${to}`}
    </button>
  )
}

function Harness() {
  const { pathname } = useLocation()
  const view = appViewForPath(pathname)

  return (
    <>
      <Go to="/settings" />
      <Go to="/skills" />
      <Go to="/rt-2" />
      <MainPaneRoutes
        chat={<ChatBody />}
        chatVisible={view === 'chat' || isOverlayView(view)}
        pages={{
          artifacts: <div data-testid="page-artifacts" />,
          messaging: <div data-testid="page-messaging" />,
          skills: <div data-testid="page-skills" />
        }}
      />
    </>
  )
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>
  )
}

describe('MainPaneRoutes', () => {
  beforeEach(() => {
    chat.mounts = 0
    chat.unmounts = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the chat mounted while an overlay route is open', () => {
    renderAt('/rt-1')

    expect(chat.mounts).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'go:/settings' }))

    expect(chat.mounts).toBe(1)
    expect(chat.unmounts).toBe(0)
    expect(screen.getByTestId('chat-body')).toBeTruthy()
    // Still painted under the opaque overlay card.
    expect(screen.getByTestId('chat-body').parentElement?.className).toContain('contents')
  })

  it('hides — but does not unmount — the chat on a page route', () => {
    renderAt('/rt-1')

    fireEvent.click(screen.getByRole('button', { name: 'go:/skills' }))

    expect(screen.getByTestId('page-skills')).toBeTruthy()
    expect(chat.mounts).toBe(1)
    expect(chat.unmounts).toBe(0)
    expect(screen.getByTestId('chat-body').parentElement?.className).toContain('hidden')
  })

  it('survives a session-to-session navigation without remounting the chat', () => {
    renderAt('/rt-1')

    fireEvent.click(screen.getByRole('button', { name: 'go:/rt-2' }))

    expect(chat.mounts).toBe(1)
    expect(chat.unmounts).toBe(0)
  })
})
