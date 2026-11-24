import { atom } from 'nanostores'

/**
 * "Advanced setup" — the settings a desktop install can live without, but that
 * silently degrade the experience when missing (no tool keys, no memory
 * provider, no voice, no MCP, no messaging gateway).
 *
 * The first-run tour covers the essentials once; this is the resident
 * checklist for everything else, with a direct link into the matching panel.
 */

export const ADVANCED_SETUP_IDS = ['provider', 'toolKeys', 'memory', 'voice', 'mcp', 'gateway', 'terminal'] as const

export type AdvancedSetupId = (typeof ADVANCED_SETUP_IDS)[number]

export interface AdvancedSetupInput {
  /** A provider AND a model are assigned (setup.status). */
  configured: boolean
  /** Messaging platforms with a configured gateway. */
  gatewayPlatforms: number
  /** Enabled toolsets that miss their credentials (image gen, search, …). */
  toolsetsMissingKeys: number
  memoryProvider: string
  /** A TTS provider or STT enabled. */
  voiceConfigured: boolean
  mcpServers: number
  terminalBackend: string
}

export interface AdvancedSetupItem {
  done: boolean
  id: AdvancedSetupId
}

/**
 * Which items are still pending. Pure so the UI and the spec agree on the
 * definition instead of duplicating thresholds.
 */
export function buildAdvancedSetupItems(input: AdvancedSetupInput): AdvancedSetupItem[] {
  return [
    { done: input.configured, id: 'provider' },
    { done: input.toolsetsMissingKeys === 0, id: 'toolKeys' },
    { done: Boolean(input.memoryProvider.trim()), id: 'memory' },
    { done: input.voiceConfigured, id: 'voice' },
    { done: input.mcpServers > 0, id: 'mcp' },
    { done: input.gatewayPlatforms > 0, id: 'gateway' },
    { done: Boolean(input.terminalBackend.trim()), id: 'terminal' }
  ]
}

export function pendingAdvancedSetupCount(items: AdvancedSetupItem[]): number {
  return items.filter(item => !item.done).length
}

/** Pending count for the sidebar badge; 0 hides it. */
export const $advancedSetupPending = atom(0)

export function setAdvancedSetupPending(count: number): void {
  $advancedSetupPending.set(Math.max(0, count))
}
