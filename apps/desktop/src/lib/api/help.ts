// Task-scoped help topics (REST).
// Split out of the `alice.ts` monolith (D5). Public signatures are unchanged:
// `alice.ts` re-exports this module, so every '@/alice' import keeps working.

import { profileScoped } from './client'

// ── Task-scoped help ──────────────────────────────────────────────────────────

export interface HelpTopic {
  id: string
  title: string
  description: string
}

export interface HelpTaskContent extends HelpTopic {
  markdown: string
  doc_available: boolean
}

export function listHelpTopics(): Promise<HelpTopic[]> {
  return window.aliceDesktop.api<HelpTopic[]>({
    ...profileScoped(),
    path: '/api/help/topics'
  })
}

export function getHelpTask(taskId: string): Promise<HelpTaskContent> {
  return window.aliceDesktop.api<HelpTaskContent>({
    ...profileScoped(),
    path: `/api/help/task/${encodeURIComponent(taskId)}`
  })
}
