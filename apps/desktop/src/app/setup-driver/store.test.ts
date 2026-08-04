import { describe, expect, it, beforeEach } from 'vitest'

import {
  $setup,
  chooseProvider,
  chooseTerminalBackend,
  resetSetupDriver,
  setSetupError,
} from './store'

describe('setup-driver store', () => {
  beforeEach(() => resetSetupDriver())

  it('starts at provider step', () => {
    expect($setup.get().step).toBe('provider')
  })

  it('transitions provider → terminal → review', () => {
    chooseProvider('omniroute')
    expect($setup.get().step).toBe('terminal')
    expect($setup.get().selectedProvider).toBe('omniroute')

    chooseTerminalBackend('local')
    expect($setup.get().step).toBe('review')
    expect($setup.get().selectedBackend).toBe('local')
  })

  it('surfaces errors and clears busy', () => {
    $setup.set({ ...$setup.get(), busy: true })
    setSetupError('boom')
    expect($setup.get().error).toBe('boom')
    expect($setup.get().busy).toBe(false)
  })
})
