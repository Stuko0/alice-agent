import { afterEach, describe, expect, it } from 'vitest'

import {
  $advancedSetupPending,
  type AdvancedSetupInput,
  buildAdvancedSetupItems,
  pendingAdvancedSetupCount,
  setAdvancedSetupPending
} from './advanced-setup'

const READY: AdvancedSetupInput = {
  configured: true,
  gatewayPlatforms: 1,
  mcpServers: 2,
  memoryProvider: 'holographic',
  terminalBackend: 'local',
  toolsetsMissingKeys: 0,
  voiceConfigured: true
}

afterEach(() => {
  setAdvancedSetupPending(0)
})

describe('advanced setup checklist', () => {
  it('reports nothing pending when everything is configured', () => {
    const items = buildAdvancedSetupItems(READY)

    expect(items.every(item => item.done)).toBe(true)
    expect(pendingAdvancedSetupCount(items)).toBe(0)
  })

  it('flags each gap independently', () => {
    const pendingFor = (patch: Partial<AdvancedSetupInput>) =>
      buildAdvancedSetupItems({ ...READY, ...patch })
        .filter(item => !item.done)
        .map(item => item.id)

    expect(pendingFor({ configured: false })).toEqual(['provider'])
    expect(pendingFor({ toolsetsMissingKeys: 2 })).toEqual(['toolKeys'])
    expect(pendingFor({ memoryProvider: '  ' })).toEqual(['memory'])
    expect(pendingFor({ voiceConfigured: false })).toEqual(['voice'])
    expect(pendingFor({ mcpServers: 0 })).toEqual(['mcp'])
    expect(pendingFor({ gatewayPlatforms: 0 })).toEqual(['gateway'])
    expect(pendingFor({ terminalBackend: '' })).toEqual(['terminal'])
  })

  it('counts everything at once', () => {
    const items = buildAdvancedSetupItems({
      configured: false,
      gatewayPlatforms: 0,
      mcpServers: 0,
      memoryProvider: '',
      terminalBackend: 'local',
      toolsetsMissingKeys: 1,
      voiceConfigured: false
    })

    expect(pendingAdvancedSetupCount(items)).toBe(6)
  })

  it('publishes the pending count for the sidebar badge', () => {
    setAdvancedSetupPending(3)
    expect($advancedSetupPending.get()).toBe(3)

    setAdvancedSetupPending(-2)
    expect($advancedSetupPending.get()).toBe(0)
  })
})
