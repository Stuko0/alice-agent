import { notify, notifyError } from '@/store/notifications'
import {
  $setup,
  chooseProvider,
  chooseTerminalBackend,
  setSetupBusy,
  setSetupError,
  setSetupStep,
} from './store'

export interface SetupStatus {
  configured: boolean
  provider: string | null
  model: string | null
  terminal_backend: string
}

export async function fetchSetupStatus(): Promise<SetupStatus | null> {
  try {
    return await window.lydiaDesktop.api<SetupStatus>({ path: '/api/setup/status' })
  } catch {
    return null
  }
}

async function _post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    return await window.lydiaDesktop.api<T>({
      path,
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch (e) {
    return null
  }
}

export async function submitProvider(providerId: string): Promise<void> {
  setSetupBusy(true)
  setSetupError(null)
  try {
    if (providerId === 'omniroute') {
      // Bring the gateway up; backend auto-provisions a bundled Node+OmniRoute
      // into ~/.alice/omniroute/ when no system runtime exists.
      const r = await _post<{ base_url: string; configured: boolean }>('/api/setup/omniroute/start', {})
      if (r === null || !r.configured) {
        setSetupError('OmniRoute failed to start — check ~/.alice/logs/agent.log')
        return
      }
      chooseProvider(providerId)
      return
    }
    const r = await _post('/api/setup/provider', { provider: providerId })
    if (r === null) {
      setSetupError('Failed to configure provider')
      return
    }
    chooseProvider(providerId)
  } finally {
    setSetupBusy(false)
  }
}

export async function submitTerminalBackend(backend: string): Promise<void> {
  setSetupBusy(true)
  setSetupError(null)
  try {
    const r = await _post<{ terminal: Record<string, unknown> }>('/api/setup/terminal-backend', { backend })
    if (r === null) {
      setSetupError('Failed to set terminal backend')
      return
    }
    chooseTerminalBackend(backend)
  } finally {
    setSetupBusy(false)
  }
}

export async function finishSetup(): Promise<void> {
  setSetupBusy(true)
  try {
    const s = await fetchSetupStatus()
    if (s?.configured) {
      setSetupStep('done')
      notify({ kind: 'success', message: 'Setup complete — all set.' })
    } else {
      setSetupError('Provider not yet configured.')
    }
  } finally {
    setSetupBusy(false)
  }
}
