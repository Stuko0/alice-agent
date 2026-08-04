import { atom } from 'nanostores'

export type SetupStep = 'provider' | 'terminal' | 'review' | 'done'

export interface SetupDriverState {
  step: SetupStep
  busy: boolean
  error: string | null
  selectedProvider: string | null
  selectedBackend: string | null
  recommendedBackend: string | null
}

export const $setup = atom<SetupDriverState>({
  step: 'provider',
  busy: false,
  error: null,
  selectedProvider: null,
  selectedBackend: null,
  recommendedBackend: null,
})

export function setSetupStep(step: SetupStep) {
  $setup.set({ ...$setup.get(), step })
}

export function setSetupError(error: string | null) {
  $setup.set({ ...$setup.get(), error, busy: false })
}

export function setSetupBusy(busy: boolean) {
  $setup.set({ ...$setup.get(), busy })
}

export function chooseProvider(provider: string) {
  $setup.set({ ...$setup.get(), selectedProvider: provider, step: 'terminal' })
}

export function chooseTerminalBackend(backend: string) {
  $setup.set({ ...$setup.get(), selectedBackend: backend, step: 'review' })
}

export function resetSetupDriver() {
  $setup.set({
    step: 'provider',
    busy: false,
    error: null,
    selectedProvider: null,
    selectedBackend: null,
    recommendedBackend: null,
  })
}
