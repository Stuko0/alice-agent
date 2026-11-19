import { beforeEach, describe, expect, it } from 'vitest'

import { $terminalTakeover } from '@/app/right-sidebar/store'
import { $fileBrowserOpen, setSidebarOpen } from '@/store/layout'
import { $paneStates } from '@/store/panes'
import { $reviewOpen } from '@/store/review'

import {
  $pinnedDrawers,
  closeOtherStudyDrawers,
  migrateStudyLayoutOnce,
  reconcileStudyDrawersOnce,
  toggleDrawerPin
} from './study-layout'

// The Study shell replaces the old multi-pane IDE layout with mutually
// exclusive drawers. These are the contracts the shell relies on:
// opening one drawer must not require closing the others by hand, and the
// one-time migration must not keep re-closing a user's drawers on every boot.

const MIGRATION_KEY = 'alice-desktop-study-layout-v1'

function reset(): void {
  $pinnedDrawers.set([])
  $paneStates.set({})
  $reviewOpen.set(false)
  $terminalTakeover.set(false)
  setSidebarOpen(false)
}

describe('study layout migration', () => {
  beforeEach(() => {
    window.localStorage.clear()
    reset()
  })

  it('closes the persisted IDE-era drawers once and records the migration', () => {
    setSidebarOpen(true)
    $reviewOpen.set(true)
    $terminalTakeover.set(true)

    migrateStudyLayoutOnce()

    expect(window.localStorage.getItem(MIGRATION_KEY)).toBe('1')
    expect($paneStates.get()['chat-sidebar']?.open).toBe(false)
    expect($paneStates.get()['file-browser']?.open).toBe(false)
    expect($paneStates.get()['preview']?.open).toBe(false)
    expect($reviewOpen.get()).toBe(false)
    expect($terminalTakeover.get()).toBe(false)
  })

  it('does not touch drawers after the migration has run', () => {
    window.localStorage.setItem(MIGRATION_KEY, '1')

    setSidebarOpen(true)
    $reviewOpen.set(true)
    $terminalTakeover.set(true)

    migrateStudyLayoutOnce()

    expect($paneStates.get()['chat-sidebar']?.open).toBe(true)
    expect($reviewOpen.get()).toBe(true)
    expect($terminalTakeover.get()).toBe(true)
  })
})

describe('drawer exclusivity', () => {
  beforeEach(() => {
    reset()
  })

  it('closes every drawer except the one being opened', () => {
    setSidebarOpen(true)
    $reviewOpen.set(true)
    $terminalTakeover.set(true)

    closeOtherStudyDrawers('files')

    expect($paneStates.get()['chat-sidebar']?.open).toBe(false)
    expect($reviewOpen.get()).toBe(false)
    expect($terminalTakeover.get()).toBe(false)
    // The kept drawer is untouched — its own handler opens it.
    expect($fileBrowserOpen.get()).toBe(false)
  })

  it('is a no-op for the drawer it keeps', () => {
    $reviewOpen.set(true)

    closeOtherStudyDrawers('review')

    expect($reviewOpen.get()).toBe(true)
  })

  it('keeps pinned drawers docked when another one opens', () => {
    $reviewOpen.set(true)
    toggleDrawerPin('sessions') // docking also opens the drawer

    closeOtherStudyDrawers('review')

    // The pinned catalog survives; the unpinned terminal still closes.
    expect($paneStates.get()['chat-sidebar']?.open).toBe(true)
    expect($reviewOpen.get()).toBe(true)
  })

  it('boot keeps only pinned drawers open', () => {
    setSidebarOpen(true)
    $reviewOpen.set(true)
    $terminalTakeover.set(true)
    toggleDrawerPin('sessions')

    reconcileStudyDrawersOnce()

    expect($paneStates.get()['chat-sidebar']?.open).toBe(true)
    expect($reviewOpen.get()).toBe(false)
    expect($terminalTakeover.get()).toBe(false)
  })

  it('pinning opens the drawer and unpinning keeps it open', () => {
    setSidebarOpen(false)
    toggleDrawerPin('sessions')
    expect($paneStates.get()['chat-sidebar']?.open).toBe(true)
    expect($pinnedDrawers.get()).toEqual(['sessions'])

    toggleDrawerPin('sessions')
    expect($pinnedDrawers.get()).toEqual([])
    expect($paneStates.get()['chat-sidebar']?.open).toBe(true)
  })
})
