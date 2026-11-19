// OAuth providers, the dynamic provider registry and provider credentials (REST).
// Split out of the `alice.ts` monolith (D5). Public signatures are unchanged:
// `alice.ts` re-exports this module, so every '@/alice' import keeps working.
import type {
  MemoryProviderOAuthStatus,
  OAuthPollResponse,
  OAuthProvidersResponse,
  OAuthStartResponse,
  OAuthSubmitResponse,
} from '@/types/alice'

import { profileScoped } from './client'

export function listOAuthProviders(): Promise<OAuthProvidersResponse> {
  return window.aliceDesktop.api<OAuthProvidersResponse>({
    ...profileScoped(),
    path: '/api/providers/oauth'
  })
}

export function disconnectOAuthProvider(providerId: string): Promise<{ ok: boolean; provider: string }> {
  return window.aliceDesktop.api<{ ok: boolean; provider: string }>({
    ...profileScoped(),
    path: `/api/providers/oauth/${encodeURIComponent(providerId)}`,
    method: 'DELETE'
  })
}

export function startOAuthLogin(providerId: string): Promise<OAuthStartResponse> {
  return window.aliceDesktop.api<OAuthStartResponse>({
    ...profileScoped(),
    path: `/api/providers/oauth/${encodeURIComponent(providerId)}/start`,
    method: 'POST',
    body: {}
  })
}

// ── Dynamic Provider Registry (DPR) ──────────────────────────────────────────
// Custom providers live as declarative specs in ~/.alice/providers.d/ and
// appear everywhere built-ins do. These four calls drive the Settings →
// Providers "Custom" section.

export interface CustomProviderSpec {
  name: string
  base_url?: string
  api?: string
  url?: string
  api_key_env?: string
  key_env?: string
  api_mode?: 'openai' | 'anthropic'
  models?: string[]
  provider_key?: string
}

export interface CustomProviderProbe {
  ok: boolean
  latency_ms: number
  models?: string[]
  error?: string
}

export function listCustomProviders(): Promise<CustomProviderSpec[]> {
  return window.aliceDesktop.api<CustomProviderSpec[]>({
    ...profileScoped(),
    path: '/api/providers/custom'
  })
}

export function addCustomProvider(spec: CustomProviderSpec): Promise<CustomProviderSpec & { id: string }> {
  // If api_key_env looks like an actual API key (not an env var name),
  // auto-generate the env var name from the provider name and store the
  // key value directly.
  const cleanSpec = { ...spec }

  if (cleanSpec.api_key_env) {
    const val = cleanSpec.api_key_env.trim()

    // If it contains common API key patterns, treat it as the key value
    if (val.startsWith('sk-') || val.startsWith('key-') || val.includes('-') || val.length > 20) {
      const envName = cleanSpec.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY'
      cleanSpec.api_key_env = envName
      // We'll need to save the key separately after adding the provider
      // Store it temporarily in the spec for the backend to handle
      ;(cleanSpec as any)._api_key_value = val
    }
  }

  return window.aliceDesktop.api<CustomProviderSpec & { id: string }>({
    ...profileScoped(),
    path: '/api/providers/custom',
    method: 'POST',
    body: cleanSpec
  })
}

export function deleteCustomProvider(providerId: string): Promise<{ removed: boolean; id: string }> {
  return window.aliceDesktop.api<{ removed: boolean; id: string }>({
    ...profileScoped(),
    path: `/api/providers/custom/${encodeURIComponent(providerId)}`,
    method: 'DELETE'
  })
}

export function testCustomProvider(providerId: string): Promise<CustomProviderProbe> {
  return window.aliceDesktop.api<CustomProviderProbe>({
    ...profileScoped(),
    path: `/api/providers/custom/${encodeURIComponent(providerId)}/test`,
    method: 'POST',
    body: {}
  })
}

export function submitOAuthCode(providerId: string, sessionId: string, code: string): Promise<OAuthSubmitResponse> {
  return window.aliceDesktop.api<OAuthSubmitResponse>({
    ...profileScoped(),
    path: `/api/providers/oauth/${encodeURIComponent(providerId)}/submit`,
    method: 'POST',
    body: { session_id: sessionId, code }
  })
}

export function pollOAuthSession(providerId: string, sessionId: string): Promise<OAuthPollResponse> {
  return window.aliceDesktop.api<OAuthPollResponse>({
    ...profileScoped(),
    path: `/api/providers/oauth/${encodeURIComponent(providerId)}/poll/${encodeURIComponent(sessionId)}`
  })
}

export function cancelOAuthSession(sessionId: string): Promise<{ ok: boolean }> {
  return window.aliceDesktop.api<{ ok: boolean }>({
    ...profileScoped(),
    path: `/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`,
    method: 'DELETE'
  })
}

// Memory-provider OAuth connect (provider-keyed; 404s for providers without an
// OAuth flow). Profile-scoped: the grant lands in the active profile's config.
export function startMemoryProviderOAuth(provider: string): Promise<MemoryProviderOAuthStatus> {
  return window.aliceDesktop.api<MemoryProviderOAuthStatus>({
    ...profileScoped(),
    path: `/api/memory/providers/${encodeURIComponent(provider)}/oauth/start`,
    method: 'POST'
  })
}

export function getMemoryProviderOAuthStatus(provider: string): Promise<MemoryProviderOAuthStatus> {
  return window.aliceDesktop.api<MemoryProviderOAuthStatus>({
    ...profileScoped(),
    path: `/api/memory/providers/${encodeURIComponent(provider)}/oauth/status`
  })
}
