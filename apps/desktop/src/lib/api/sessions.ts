// Session-domain REST helpers, split out of the `alice.ts` monolith (D5). Public
// signatures are unchanged: `alice.ts` re-exports this module, so every existing
// import from '@/alice' keeps working.
import type {
  PaginatedSessions,
  SessionInfo,
  SessionMessagesResponse,
  SessionSearchResponse
} from '@/types/alice'

const SESSION_LIST_REQUEST_TIMEOUT_MS = 60_000

export async function listSessions(
  limit = 40,
  minMessages = 0,
  archived: 'exclude' | 'include' | 'only' = 'exclude',
  order: 'created' | 'recent' = 'recent'
): Promise<PaginatedSessions> {
  const result = await window.aliceDesktop.api<PaginatedSessions>({
    path:
      `/api/sessions?limit=${limit}&offset=0&min_messages=${Math.max(0, minMessages)}` +
      `&archived=${archived}&order=${order}`,
    timeoutMs: SESSION_LIST_REQUEST_TIMEOUT_MS
  })

  return {
    ...result,
    sessions: result.sessions.slice(0, limit),
    offset: 0
  }
}

// Unified, read-only session list aggregated across ALL profiles. Served by the
// primary backend straight off each profile's state.db — no per-profile backend
// is spawned. Single-profile users get the same rows as listSessions(), tagged
// profile="default".
// Source scoping lets callers split the unified list into independent slices:
// recents pass `excludeSources: ['cron']`, the cron-jobs section passes
// `source: 'cron'`. Without this a burst of (always-newest) cron sessions
// consumes the whole recents page and starves real conversations.
export interface SessionSourceFilter {
  source?: string
  excludeSources?: string[]
}

export async function listAllProfileSessions(
  limit = 40,
  minMessages = 0,
  archived: 'exclude' | 'include' | 'only' = 'exclude',
  order: 'created' | 'recent' = 'recent',
  profile: 'all' | (string & {}) = 'all',
  filter: SessionSourceFilter = {}
): Promise<PaginatedSessions> {
  const sourceParam = filter.source ? `&source=${encodeURIComponent(filter.source)}` : ''

  const excludeParam = filter.excludeSources?.length
    ? `&exclude_sources=${encodeURIComponent(filter.excludeSources.join(','))}`
    : ''

  const result = await window.aliceDesktop.api<PaginatedSessions>({
    path:
      `/api/profiles/sessions?limit=${limit}&offset=0&min_messages=${Math.max(0, minMessages)}` +
      `&archived=${archived}&order=${order}&profile=${encodeURIComponent(profile)}${sourceParam}${excludeParam}`,
    timeoutMs: SESSION_LIST_REQUEST_TIMEOUT_MS
  })

  return {
    ...result,
    sessions: result.sessions.slice(0, limit),
    offset: 0
  }
}

// Mutations take the owning `profile` so Electron routes them to that profile's
// backend (remote pool or local primary) via request.profile — matching the
// read path. A remote session's row lives only on its remote host, so a mutation
// that hit the local primary would no-op or 404. Omit for the current/default.
export function setSessionArchived(id: string, archived: boolean, profile?: string | null): Promise<{ ok: boolean }> {
  return window.aliceDesktop.api<{ ok: boolean }>({
    ...(profile ? { profile } : {}),
    path: `/api/sessions/${encodeURIComponent(id)}`,
    method: 'PATCH',
    body: { archived }
  })
}

export function searchSessions(query: string): Promise<SessionSearchResponse> {
  return window.aliceDesktop.api<SessionSearchResponse>({
    path: `/api/sessions/search?q=${encodeURIComponent(query)}`
  })
}

// Resolves a single session row by id on one backend (the active profile, or
// the given `profile`). The backend resolves exact ids and unique prefixes and
// 404s when the id isn't on that profile — so a cheap by-id lookup replaces the
// cross-profile list scan when locating an unknown id's owner.
export function getSession(id: string, profile?: string | null): Promise<SessionInfo> {
  const suffix = profile ? `?profile=${encodeURIComponent(profile)}` : ''

  return window.aliceDesktop.api<SessionInfo>({
    ...(profile ? { profile } : {}),
    path: `/api/sessions/${encodeURIComponent(id)}${suffix}`
  })
}

// Reasoning text for specific messages. The transcript payload ships a
// `has_reasoning` flag instead of the text; a Thinking disclosure calls this
// when it opens, so the cost is one small request per expanded message.
export function getMessageReasoning(
  sessionId: string,
  ids: readonly number[],
  profile?: string | null
): Promise<Record<string, string>> {
  const params = new URLSearchParams()
  params.set('ids', ids.join(','))

  if (profile) {
    params.set('profile', profile)
  }

  return window.aliceDesktop
    .api<{ reasoning?: Record<string, string> }>({
      ...(profile ? { profile } : {}),
      path: `/api/sessions/${encodeURIComponent(sessionId)}/reasoning?${params.toString()}`
    })
    .then(result => result.reasoning ?? {})
}

// Reads another profile's transcript. For a remote profile Electron reroutes
// this GET to the remote backend (which serves its own state.db); for a local
// profile the primary opens that profile's state.db via ?profile=. Omit for
// the current/default profile.
export interface SessionMessagesOptions {
  /** Opt out of the compact field set (exports need full fidelity). */
  full?: boolean
  /** Include reasoning text up front (Technical tool view). */
  reasoning?: boolean
  /** Only rows newer than this message id (the follow-poll cursor). */
  sinceId?: number
}

export function getSessionMessages(
  id: string,
  profile?: string | null,
  limit?: number,
  signal?: AbortSignal,
  options: SessionMessagesOptions = {}
): Promise<SessionMessagesResponse> {
  // ``limit`` caps how many of the most recent messages come back. The
  // session-switch prefetch passes it so a huge session (2MB+ of history on
  // a 983MB state.db) doesn't dominate switch latency; exports and artifacts
  // omit it and get the full transcript.
  //
  // ``signal`` lets a superseded session switch drop the payload instead of
  // handing a 200-message transcript to the converter. The desktop bridge has no
  // transport-level cancellation, so this is cooperative: the request may still
  // finish, but the caller never processes a result it no longer wants.
  const abortError = () => new DOMException('The session switch was superseded', 'AbortError')

  if (signal?.aborted) {
    return Promise.reject(abortError())
  }

  const params = new URLSearchParams()

  if (profile) {params.set('profile', profile)}

  if (limit) {params.set('limit', String(limit))}

  // Delta cursor for the follow poll: only rows newer than this id come back.
  if (options.sinceId) {params.set('since_id', String(options.sinceId))}

  // Exports round-trip the transcript verbatim; the compact wire shape would
  // silently drop reasoning_details/codex_* fields from the downloaded JSON.
  if (options.full) {params.set('full', 'true')}

  // Technical view wants the reasoning inline; Product fetches it per message
  // when a Thinking disclosure is expanded.
  if (options.reasoning) {params.set('reasoning', 'true')}
  const qs = params.toString()
  const suffix = qs ? `?${qs}` : ''

  return window.aliceDesktop
    .api<SessionMessagesResponse>({
      ...(profile ? { profile } : {}),
      path: `/api/sessions/${encodeURIComponent(id)}/messages${suffix}`
    })
    .then(result => {
      if (signal?.aborted) {
        throw abortError()
      }

      return result
    })
}

export function deleteSession(id: string, profile?: string | null): Promise<{ ok: boolean }> {
  return window.aliceDesktop.api<{ ok: boolean }>({
    ...(profile ? { profile } : {}),
    path: `/api/sessions/${encodeURIComponent(id)}`,
    method: 'DELETE'
  })
}

export function renameSession(
  id: string,
  title: string,
  profile?: string | null
): Promise<{ ok: boolean; title: string }> {
  return window.aliceDesktop.api<{ ok: boolean; title: string }>({
    ...(profile ? { profile } : {}),
    path: `/api/sessions/${encodeURIComponent(id)}`,
    method: 'PATCH',
    body: { title, ...(profile ? { profile } : {}) }
  })
}
