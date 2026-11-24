import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { flushCoalescedPersistence, onPersistenceEvent } from '@/lib/storage'

import {
  $paneOpen,
  $paneStates,
  $paneWidthOverride,
  clearPaneWidthOverride,
  ensurePaneRegistered,
  forgetPane,
  getPaneStateSnapshot,
  setPaneOpen,
  setPaneWidthOverride,
  togglePane
} from './panes'

const STORAGE_KEY = 'alice.desktop.paneStates.v1'

describe('panes store', () => {
  beforeEach(() => {
    $paneStates.set({})
    window.localStorage.clear()
  })

  afterEach(() => {
    $paneStates.set({})
    window.localStorage.clear()
  })

  describe('ensurePaneRegistered', () => {
    it('adds a pane with defaults when missing', () => {
      ensurePaneRegistered('files', { open: true })

      expect(getPaneStateSnapshot('files')).toEqual({ open: true, widthOverride: undefined })
    })

    it('is a no-op when the pane already exists', () => {
      ensurePaneRegistered('files', { open: false })
      ensurePaneRegistered('files', { open: true })

      expect(getPaneStateSnapshot('files')?.open).toBe(false)
    })

    it('preserves an existing widthOverride when re-registering', () => {
      ensurePaneRegistered('files', { open: true })
      setPaneWidthOverride('files', 360)
      ensurePaneRegistered('files', { open: false })

      expect(getPaneStateSnapshot('files')?.widthOverride).toBe(360)
    })
  })

  describe('forgetPane', () => {
    it('drops a retired pane from the persisted state', () => {
      ensurePaneRegistered('preview', { open: true, widthOverride: 480 })
      ensurePaneRegistered('files', { open: true })

      forgetPane('preview')

      expect($paneStates.get()).toEqual({ files: { open: true } })

      flushCoalescedPersistence()

      expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain('preview')
    })

    it('is a no-op for an unknown pane', () => {
      ensurePaneRegistered('files', { open: true })

      forgetPane('nope')

      expect($paneStates.get()).toEqual({ files: { open: true } })
    })
  })

  describe('setPaneOpen / togglePane', () => {
    it('updates the pane open flag', () => {
      ensurePaneRegistered('files', { open: false })
      setPaneOpen('files', true)

      expect(getPaneStateSnapshot('files')?.open).toBe(true)
    })

    it('togglePane flips the current value', () => {
      ensurePaneRegistered('files', { open: false })
      togglePane('files')
      togglePane('files')
      togglePane('files')

      expect(getPaneStateSnapshot('files')?.open).toBe(true)
    })

    it('togglePane on an unregistered id starts from false', () => {
      togglePane('ephemeral')

      expect(getPaneStateSnapshot('ephemeral')?.open).toBe(true)
    })

    it('preserves widthOverride across open/close changes', () => {
      ensurePaneRegistered('files', { open: true })
      setPaneWidthOverride('files', 280)
      setPaneOpen('files', false)
      setPaneOpen('files', true)

      expect(getPaneStateSnapshot('files')?.widthOverride).toBe(280)
    })
  })

  describe('width overrides', () => {
    it('setPaneWidthOverride stores the px value', () => {
      ensurePaneRegistered('files', { open: true })
      setPaneWidthOverride('files', 300)

      expect(getPaneStateSnapshot('files')?.widthOverride).toBe(300)
    })

    it('clearPaneWidthOverride removes the override', () => {
      ensurePaneRegistered('files', { open: true })
      setPaneWidthOverride('files', 300)
      clearPaneWidthOverride('files')

      expect(getPaneStateSnapshot('files')?.widthOverride).toBeUndefined()
    })

    it('persists the width override alongside the open flag', () => {
      // The store deliberately persists the resize width too (a relaunch keeps
      // the sash where the user left it). Writes are coalesced, so flush first.
      ensurePaneRegistered('files', { open: true })
      setPaneWidthOverride('files', 300)
      flushCoalescedPersistence()

      const persisted = window.localStorage.getItem(STORAGE_KEY)

      expect(persisted).not.toBeNull()
      expect(JSON.parse(persisted ?? '{}')).toEqual({ files: { open: true, widthOverride: 300 } })
    })

    it('coalesces a drag burst into a single persisted write', () => {
      ensurePaneRegistered('files', { open: true })
      flushCoalescedPersistence()

      const writes: string[] = []

      const stop = onPersistenceEvent(event => {
        if (event.op === 'write' && event.key === STORAGE_KEY) {
          writes.push(event.value ?? '')
        }
      })

      // 20 pointermove-equivalent updates, as a sash drag produces.
      for (let width = 200; width < 400; width += 10) {
        setPaneWidthOverride('files', width)
      }

      flushCoalescedPersistence()
      stop()

      expect(writes).toHaveLength(1)
      expect(JSON.parse(writes[0]).files.widthOverride).toBe(390)
    })

    it('open flag is persisted across changes', () => {
      ensurePaneRegistered('files', { open: false })
      setPaneOpen('files', true)
      flushCoalescedPersistence()

      const persisted = window.localStorage.getItem(STORAGE_KEY)

      expect(persisted).not.toBeNull()
      expect(JSON.parse(persisted ?? '{}')).toEqual({ files: { open: true } })
    })
  })

  describe('derived atoms', () => {
    it('$paneOpen reflects the pane state', () => {
      const open$ = $paneOpen('files')
      expect(open$.get()).toBe(false)

      ensurePaneRegistered('files', { open: true })
      expect(open$.get()).toBe(true)

      setPaneOpen('files', false)
      expect(open$.get()).toBe(false)
    })

    it('$paneWidthOverride reflects the width', () => {
      const width$ = $paneWidthOverride('files')
      expect(width$.get()).toBeUndefined()

      ensurePaneRegistered('files', { open: true })
      setPaneWidthOverride('files', 240)
      expect(width$.get()).toBe(240)
    })

    it('$paneOpen returns the same atom instance for repeated calls', () => {
      expect($paneOpen('files')).toBe($paneOpen('files'))
    })
  })
})
