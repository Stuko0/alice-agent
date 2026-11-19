import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { $terminalTakeover } from '../store'

import { ensureTerminal } from './terminals'
import { TerminalWorkspace } from './workspace'

/**
 * One xterm Terminal mounted at the layout root and CSS-overlayed onto
 * whichever `<TerminalSlot />` is active. Moving the host DOM detaches xterm's
 * WebGL renderer (it observes its own attachment) and resets the screen, so
 * the host stays put and we chase the slot's bounding rect with position:fixed.
 */

const $slot = atom<HTMLElement | null>(null)

const SLOT_CLASS = 'relative flex min-h-0 min-w-0 flex-1 flex-col'

export function TerminalSlot({ className = SLOT_CLASS }: { className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current

    if (!el) {
      return
    }

    $slot.set(el)

    return () => {
      if ($slot.get() === el) {
        $slot.set(null)
      }
    }
  }, [])

  return <div className={className} ref={ref} />
}

interface PersistentTerminalProps {
  onAddSelectionToChat: (text: string, label?: string) => void
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const sameRect = (a: Rect | null, b: Rect) =>
  !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height

// Measures the slot and returns the overlay rect. Kept outside the component so
// the listeners below stay trivial.
function rectFor(slot: HTMLElement): Rect {
  const r = slot.getBoundingClientRect()
  // floor top/left + ceil right/bottom: overlay always covers the slot's full
  // pixel footprint, so half-pixel rects can't leak page bg through.
  const top = Math.floor(r.top)
  const left = Math.floor(r.left)

  return { top, left, width: Math.ceil(r.right) - left, height: Math.ceil(r.bottom) - top }
}

export function PersistentTerminal({ onAddSelectionToChat }: PersistentTerminalProps) {
  const slot = useStore($slot)
  const terminalTakeover = useStore($terminalTakeover)
  const [rect, setRect] = useState<Rect | null>(null)
  const [ready, setReady] = useState(false)
  const rectRef = useRef<Rect | null>(null)

  // VS Code parity: once the pane has ever been opened, keep the terminals
  // mounted — and their shells alive — even while hidden. Hiding the pane just
  // collapses the slot, so the overlay below goes invisible; nothing is torn
  // down. Only an explicit per-tab close kills a PTY. Re-opening re-ensures one
  // terminal exists (covers having closed the last tab).
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (terminalTakeover && ready) {
      setMounted(true)
      ensureTerminal()
    }
  }, [terminalTakeover, ready])

  // Chasing the slot used to be an unbounded requestAnimationFrame loop that ran
  // for the entire app lifetime (the terminal pane is always mounted), forcing a
  // layout read every frame. The rect only changes on a handful of edges —
  // pane resize, rail re-layout, window scroll/resize, hover-reveal — so use
  // targeted triggers plus ONE coalescing rAF per burst instead.
  useLayoutEffect(() => {
    if (!slot) {
      rectRef.current = null
      setRect(null)

      return
    }

    let frame = 0

    const measure = () => {
      frame = 0

      const next = rectFor(slot)

      if (!sameRect(rectRef.current, next)) {
        rectRef.current = next
        setRect(next)

        if (next.width > 0 && next.height > 0) {
          setReady(true)
        }
      }
    }

    const requestMeasure = () => {
      if (frame) {
        return
      }

      frame = window.requestAnimationFrame(measure)
    }

    // First measurement is synchronous: the overlay must be placed in the same
    // commit that mounts the slot, not one frame later (which would flash at 0,0).
    measure()

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(requestMeasure)

    observer?.observe(slot)

    // A pane switching between a rail column and a bottom row moves the slot
    // without resizing it, so observe the document position too.
    window.addEventListener('resize', requestMeasure)
    window.addEventListener('scroll', requestMeasure, { capture: true, passive: true })

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame)
      }

      observer?.disconnect()
      window.removeEventListener('resize', requestMeasure)
      window.removeEventListener('scroll', requestMeasure, { capture: true })
    }
  }, [slot])

  const visible = Boolean(rect && rect.width > 0 && rect.height > 0)

  const style: CSSProperties = {
    position: 'fixed',
    top: rect?.top ?? 0,
    left: rect?.left ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    display: 'flex',
    flexDirection: 'column',
    visibility: visible ? 'visible' : 'hidden',
    pointerEvents: visible ? 'auto' : 'none',
    // Above a Study drawer (z-35) so the persistent xterm is visible inside the
    // floating terminal panel, but below root overlays/dialogs (z-50) which own
    // the window while they are open.
    zIndex: 45,
    // Match the live skin surface so the header strip (transparent) and body
    // read as one cohesive pane instead of revealing a near-black slab behind.
    backgroundColor: 'var(--ui-editor-surface-background)',
    contain: 'layout size paint'
  }

  // Defer the FIRST mount until the pane is open and the slot has real dims —
  // booting xterm/node-pty at 0×0 starts the shell at 80×24 and spawns a visible
  // conhost on Windows. After that `mounted` latches: shells persist while hidden.
  return (
    <div aria-hidden={!visible} style={style}>
      {mounted && <TerminalWorkspace onAddSelectionToChat={onAddSelectionToChat} />}
    </div>
  )
}
