import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { fetchSetupStatus, finishSetup, submitProvider, submitTerminalBackend } from './actions'
import { $setup, resetSetupDriver } from './store'

const PROVIDERS: Array<{ id: string; label: string; desc: string }> = [
  { id: 'omniroute', label: 'OmniRoute', desc: 'Free — no account, no CLI needed' },
  { id: 'copilot-acp', label: 'GitHub Copilot', desc: 'Free with GitHub account (requires Copilot CLI)' },
  { id: 'xai-oauth', label: 'xAI Grok', desc: 'OAuth — SuperGrok / Premium+' },
  { id: 'openai-codex', label: 'OpenAI OAuth', desc: 'OAuth with your ChatGPT account' },
]

const BACKENDS: Array<{ id: string; label: string }> = [
  { id: 'local', label: 'Local (default)' },
  { id: 'wsl', label: 'WSL2 (Windows, recommended if available)' },
  { id: 'docker', label: 'Docker (isolated container)' },
  { id: 'modal', label: 'Modal (cloud sandbox)' },
]

export function SetupDriver() {
  const s = useStore($setup)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void fetchSetupStatus().then(st => {
      if (alive) setNeedsSetup(st ? !st.configured : false)
    })
    return () => {
      alive = false
    }
  }, [s.step])

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) resetSetupDriver()
    },
    []
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') resetSetupDriver()
    },
    []
  )

  if (needsSetup !== true || s.step === 'done') return null

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-[min(520px,calc(100vw-2rem))] rounded-md border border-border bg-background p-6">
        <button
          type="button"
          onClick={resetSetupDriver}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
          aria-label="Close setup"
        >
          ✕
        </button>

        <h2 className="mb-1 text-lg font-semibold">Welcome to Alice</h2>
        <p className="mb-4 text-sm text-muted-foreground">Two quick steps and you're chatting.</p>

        {s.error && <p className="mb-3 rounded bg-destructive/15 px-3 py-2 text-sm text-destructive">{s.error}</p>}

        {s.step === 'provider' && (
          <section>
            <h3 className="mb-2 text-sm font-medium">Provider</h3>
            <ul className="space-y-2">
              {PROVIDERS.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={s.busy}
                    onClick={() => submitProvider(p.id)}
                    className={`w-full rounded border px-3 py-2 text-left hover:bg-accent disabled:opacity-50 ${i === 0 ? 'border-primary bg-primary/10' : 'border-border'}`}
                  >
                    <div className="font-medium">{p.label}{i === 0 && <span className="ml-2 text-xs text-primary">Recommended</span>}</div>
                    <div className="text-xs text-muted-foreground">{p.desc}</div>
                    {p.id === 'omniroute' && s.busy && (
                      <div className="mt-1 text-xs text-primary animate-pulse">
                        Downloading Node + OmniRoute on first run…
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {s.step === 'terminal' && (
          <section>
            <h3 className="mb-2 text-sm font-medium">Where should commands run?</h3>
            <ul className="space-y-2">
              {BACKENDS.map(b => (
                <li key={b.id}>
                  <button
                    type="button"
                    disabled={s.busy}
                    onClick={() => submitTerminalBackend(b.id)}
                    className="w-full rounded border border-border px-3 py-2 text-left hover:bg-accent disabled:opacity-50"
                  >
                    {b.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {s.step === 'review' && (
          <section className="space-y-3">
            <div className="text-sm">
              <div><span className="text-muted-foreground">Provider:</span> {s.selectedProvider}</div>
              <div><span className="text-muted-foreground">Terminal:</span> {s.selectedBackend}</div>
            </div>
            <div className="flex gap-2">
              <Button onClick={finishSetup} disabled={s.busy}>Finish</Button>
              <Button variant="ghost" onClick={resetSetupDriver} disabled={s.busy}>Back</Button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
