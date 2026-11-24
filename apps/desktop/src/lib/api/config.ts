// Config, env vars and memory-provider settings (REST).
// Split out of the `alice.ts` monolith (D5). Public signatures are unchanged:
// `alice.ts` re-exports this module, so every '@/alice' import keeps working.
import type {
  AliceConfig,
  AliceConfigRecord,
  ConfigSchemaResponse,
  EnvVarInfo,
  MemoryProviderConfig,
} from '@/types/alice'

import { profileScoped } from './client'

export function getAliceConfig(): Promise<AliceConfig> {
  return window.aliceDesktop.api<AliceConfig>({
    ...profileScoped(),
    path: '/api/config'
  })
}

export function getAliceConfigRecord(): Promise<AliceConfigRecord> {
  return window.aliceDesktop.api<AliceConfigRecord>({
    ...profileScoped(),
    path: '/api/config'
  })
}

export function getAliceConfigDefaults(): Promise<AliceConfigRecord> {
  return window.aliceDesktop.api<AliceConfigRecord>({
    ...profileScoped(),
    path: '/api/config/defaults'
  })
}

export function getAliceConfigSchema(): Promise<ConfigSchemaResponse> {
  return window.aliceDesktop.api<ConfigSchemaResponse>({
    ...profileScoped(),
    path: '/api/config/schema'
  })
}

export function saveAliceConfig(config: AliceConfigRecord): Promise<{ ok: boolean }> {
  return window.aliceDesktop.api<{ ok: boolean }>({
    ...profileScoped(),
    path: '/api/config',
    method: 'PUT',
    body: { config }
  })
}

export function getMemoryProviderConfig(provider: string): Promise<MemoryProviderConfig> {
  return window.aliceDesktop.api<MemoryProviderConfig>({
    path: `/api/memory/providers/${encodeURIComponent(provider)}/config`
  })
}

export function saveMemoryProviderConfig(provider: string, values: Record<string, string>): Promise<{ ok: boolean }> {
  return window.aliceDesktop.api<{ ok: boolean }>({
    path: `/api/memory/providers/${encodeURIComponent(provider)}/config`,
    method: 'PUT',
    body: { values }
  })
}

export function getEnvVars(): Promise<Record<string, EnvVarInfo>> {
  return window.aliceDesktop.api<Record<string, EnvVarInfo>>({
    ...profileScoped(),
    path: '/api/env'
  })
}

export function setEnvVar(key: string, value: string): Promise<{ ok: boolean }> {
  return window.aliceDesktop.api<{ ok: boolean }>({
    ...profileScoped(),
    path: '/api/env',
    method: 'PUT',
    body: { key, value }
  })
}

export function validateProviderCredential(
  key: string,
  value: string,
  apiKey?: string
): Promise<{ ok: boolean; reachable: boolean; message: string; models?: string[] }> {
  return window.aliceDesktop.api<{ ok: boolean; reachable: boolean; message: string; models?: string[] }>({
    ...profileScoped(),
    path: '/api/providers/validate',
    method: 'POST',
    body: { key, value, api_key: apiKey ?? '' }
  })
}

export function deleteEnvVar(key: string): Promise<{ ok: boolean }> {
  return window.aliceDesktop.api<{ ok: boolean }>({
    ...profileScoped(),
    path: '/api/env',
    method: 'DELETE',
    body: { key }
  })
}

export function revealEnvVar(key: string): Promise<{ key: string; value: string }> {
  return window.aliceDesktop.api<{ key: string; value: string }>({
    ...profileScoped(),
    path: '/api/env/reveal',
    method: 'POST',
    body: { key }
  })
}
