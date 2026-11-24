// OpenClaw migration wizard (REST).
// Split out of the `alice.ts` monolith (D5). Public signatures are unchanged:
// `alice.ts` re-exports this module, so every '@/alice' import keeps working.

import { profileScoped } from './client'

// ── OpenClaw migration wizard ─────────────────────────────────────────────────

export interface MigrationScanResult {
  found: boolean
  source_dir: string | null
}

export interface MigrationResult {
  ok: boolean
  source_dir?: string
  execute?: boolean
  error?: string
  summary?: {
    migrated?: number
    conflict?: number
    skipped?: number
    error?: number
    applied?: boolean
  }
  report?: {
    items?: Array<Record<string, unknown>>
  }
}

export interface MigrationOptions {
  source?: string
  preset?: 'full' | 'user-data'
  overwrite?: boolean
  migrate_secrets?: boolean
  skill_conflict?: 'skip' | 'overwrite' | 'rename'
}

export function scanMigration(): Promise<MigrationScanResult> {
  return window.aliceDesktop.api<MigrationScanResult>({
    ...profileScoped(),
    path: '/api/migration/scan'
  })
}

export function previewMigration(options: MigrationOptions): Promise<MigrationResult> {
  return window.aliceDesktop.api<MigrationResult>({
    ...profileScoped(),
    path: '/api/migration/preview',
    method: 'POST',
    body: options
  })
}

export function applyMigration(options: MigrationOptions): Promise<MigrationResult> {
  return window.aliceDesktop.api<MigrationResult>({
    ...profileScoped(),
    path: '/api/migration/apply',
    method: 'POST',
    body: options
  })
}
