// Toolsets, toolset config and computer-use permissions (REST).
// Split out of the `alice.ts` monolith (D5). Public signatures are unchanged:
// `alice.ts` re-exports this module, so every '@/alice' import keeps working.
import type {
  ActionResponse,
  ComputerUseStatus,
  ToolsetConfig,
  ToolsetInfo,
} from '@/types/alice'

import { profileScoped } from './client'

export function getToolsets(): Promise<ToolsetInfo[]> {
  return window.aliceDesktop.api<ToolsetInfo[]>({
    ...profileScoped(),
    path: '/api/tools/toolsets'
  })
}

export function toggleToolset(
  name: string,
  enabled: boolean
): Promise<{ ok: boolean; name: string; enabled: boolean }> {
  return window.aliceDesktop.api<{ ok: boolean; name: string; enabled: boolean }>({
    ...profileScoped(),
    path: `/api/tools/toolsets/${encodeURIComponent(name)}`,
    method: 'PUT',
    body: { enabled }
  })
}

export function getToolsetConfig(name: string): Promise<ToolsetConfig> {
  return window.aliceDesktop.api<ToolsetConfig>({
    ...profileScoped(),
    path: `/api/tools/toolsets/${encodeURIComponent(name)}/config`
  })
}

export function selectToolsetProvider(
  name: string,
  provider: string
): Promise<{ ok: boolean; name: string; provider: string }> {
  return window.aliceDesktop.api<{ ok: boolean; name: string; provider: string }>({
    ...profileScoped(),
    path: `/api/tools/toolsets/${encodeURIComponent(name)}/provider`,
    method: 'PUT',
    body: { provider }
  })
}

export function runToolsetPostSetup(name: string, key: string): Promise<ActionResponse & { key: string }> {
  return window.aliceDesktop.api<ActionResponse & { key: string }>({
    ...profileScoped(),
    path: `/api/tools/toolsets/${encodeURIComponent(name)}/post-setup`,
    method: 'POST',
    body: { key }
  })
}

export function getComputerUseStatus(): Promise<ComputerUseStatus> {
  return window.aliceDesktop.api<ComputerUseStatus>({
    ...profileScoped(),
    path: '/api/tools/computer-use/status'
  })
}

export function grantComputerUsePermissions(): Promise<ActionResponse> {
  return window.aliceDesktop.api<ActionResponse>({
    ...profileScoped(),
    path: '/api/tools/computer-use/permissions/grant',
    method: 'POST'
  })
}
