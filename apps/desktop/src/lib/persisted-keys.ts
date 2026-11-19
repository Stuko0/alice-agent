/**
 * Central registry of `localStorage` keys for **UI state** (panel layout, rail
 * tabs, review view state, preview tabs). User configuration lives in
 * `config.yaml`, never here.
 *
 * Why a registry: 44 scattered `alice.desktop.*` literals made it impossible to
 * audit what the renderer persists, how it is versioned, or which store owns a
 * key. Every entry below declares its version so a future shape change has a
 * place to branch. Keys that existed before this file keep their exact string
 * (a rename without a migration would silently drop user state).
 *
 * Rule: new UI-state keys go here first; stores read them via `persistedKey`.
 */
export interface PersistedKeySpec {
  key: string
  /** Bump when the stored shape changes in a way that needs a migration. */
  version: number
}

export const PERSISTED_KEYS = {
  // ── Rail / pane layout ────────────────────────────────────────────────────
  paneStates: { key: 'alice.desktop.paneStates.v1', version: 1 },
  displayScale: { key: 'alice.desktop.display-scale.v1', version: 1 },
  pinnedDrawers: { key: 'alice.desktop.pinned-drawers.v1', version: 1 },
  panesFlipped: { key: 'alice.desktop.panesFlipped', version: 1 },
  // Retired: the preview rail became browser tabs (Fase 3). Kept registered so
  // "clear UI state" still purges profiles that predate the migration.
  rightRailActiveTab: { key: 'alice.desktop.rightRailActiveTab', version: 1 },
  terminalTakeover: { key: 'alice.desktop.terminalTakeover', version: 1 },
  browserTabsOpen: { key: 'alice.desktop.browserTabsOpen', version: 1 },

  // ── Review pane ───────────────────────────────────────────────────────────
  reviewOpen: { key: 'alice.desktop.reviewOpen', version: 1 },
  reviewCommitDefault: { key: 'alice.desktop.reviewCommitDefault', version: 1 },
  reviewTreeMode: { key: 'alice.desktop.reviewTreeMode', version: 1 },
  reviewSelectedPath: { key: 'alice.desktop.reviewSelectedPath', version: 1 },

  // ── Preview rail ──────────────────────────────────────────────────────────
  previewTabs: { key: 'alice.desktop.filePreviewTabs.v1', version: 1 },
  previewRegistry: { key: 'alice.desktop.sessionPreviews.v1', version: 1 },

  // ── Sidebar view state ────────────────────────────────────────────────────
  pinnedSessions: { key: 'alice.desktop.pinnedSessions', version: 1 },
  agentsGroupedByWorkspace: { key: 'alice.desktop.agentsGroupedByWorkspace', version: 1 },
  sidebarCronOpen: { key: 'alice.desktop.sidebarCronOpen', version: 1 },
  sidebarMessagingOpen: { key: 'alice.desktop.sidebarMessagingOpen', version: 1 },
  sessionOrder: { key: 'alice.desktop.sessionOrder', version: 1 },
  sessionOrderManual: { key: 'alice.desktop.sessionOrder.manual', version: 1 },
  workspaceOrder: { key: 'alice.desktop.workspaceOrder', version: 1 },
  workspaceParentOrder: { key: 'alice.desktop.workspaceParentOrder', version: 1 },
  projectOrder: { key: 'alice.desktop.projectOrder', version: 1 },
  workspaceCollapsed: { key: 'alice.desktop.workspaceCollapsed', version: 1 },
  dismissedAutoProjects: { key: 'alice.desktop.dismissedAutoProjects', version: 1 },
  dismissedWorktrees: { key: 'alice.desktop.dismissedWorktrees', version: 1 }
} as const satisfies Record<string, PersistedKeySpec>

export type PersistedKeyName = keyof typeof PERSISTED_KEYS

/** Stored key string for a registered UI-state entry. */
export function persistedKey(name: PersistedKeyName): string {
  return PERSISTED_KEYS[name].key
}

/** All registered key strings (diagnostics / tests). */
export function persistedKeyValues(): string[] {
  return Object.values(PERSISTED_KEYS).map(entry => entry.key)
}
