import { describe, expect, it } from 'vitest'

import { PERSISTED_KEYS, persistedKey, persistedKeyValues } from './persisted-keys'

describe('persisted key registry', () => {
  it('has unique key strings (a duplicate would make two stores fight)', () => {
    const values = persistedKeyValues()

    expect(new Set(values).size).toBe(values.length)
  })

  it('keeps every UI-state key under the desktop namespace', () => {
    for (const value of persistedKeyValues()) {
      expect(value.startsWith('alice.desktop.')).toBe(true)
    }
  })

  it('declares a positive schema version for every key', () => {
    for (const entry of Object.values(PERSISTED_KEYS)) {
      expect(Number.isInteger(entry.version)).toBe(true)
      expect(entry.version).toBeGreaterThanOrEqual(1)
    }
  })

  it('resolves entries by name', () => {
    expect(persistedKey('paneStates')).toBe(PERSISTED_KEYS.paneStates.key)
    expect(persistedKey('terminalTakeover')).toBe('alice.desktop.terminalTakeover')
  })

  it('does not re-declare the same logical key twice with different versions', () => {
    const byKey = new Map<string, number>()

    for (const entry of Object.values(PERSISTED_KEYS)) {
      const seen = byKey.get(entry.key)

      expect(seen === undefined || seen === entry.version).toBe(true)
      byKey.set(entry.key, entry.version)
    }
  })
})
