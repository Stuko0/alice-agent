import { useEffect, useState } from 'react'

import {
  applyMigration,
  previewMigration,
  scanMigration,
  type MigrationResult
} from '@/alice'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2 } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { notify, notifyError } from '@/store/notifications'

type Step = 'scan' | 'preview' | 'applying' | 'done'

/**
 * OpenClaw → Alice migration wizard (3 steps): scan → preview → apply.
 * Wraps the `alice claw migrate` machinery through /api/migration/*.
 */
export function MigrationWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const copy = t.settings.providers

  const [step, setStep] = useState<Step>('scan')
  const [sourceDir, setSourceDir] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<MigrationResult | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [secrets, setSecrets] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    setStep('scan')
    setSourceDir(null)
    setPreview(null)
    setOverwrite(false)
    setSecrets(false)
    setScanning(true)
    void scanMigration()
      .then(r => {
        setSourceDir(r.source_dir)
        setStep(r.found ? 'preview' : 'scan')
      })
      .catch(() => setStep('scan'))
      .finally(() => setScanning(false))
  }, [open])

  async function handlePreview() {
    setPreviewing(true)
    try {
      const result = await previewMigration({ source: sourceDir ?? undefined, overwrite, migrate_secrets: secrets })
      if (!result.ok) {
        notifyError(result.error, copy.migrationError)
        return
      }
      setPreview(result)
      setStep('preview')
    } catch (err) {
      notifyError(err, copy.migrationError)
    } finally {
      setPreviewing(false)
    }
  }

  async function handleApply() {
    setStep('applying')
    try {
      const result = await applyMigration({ source: sourceDir ?? undefined, overwrite, migrate_secrets: secrets })
      if (!result.ok) {
        notifyError(result.error, copy.migrationError)
        setStep('preview')
        return
      }
      setPreview(result)
      setStep('done')
      notify({ kind: 'success', message: copy.migrationDone })
    } catch (err) {
      notifyError(err, copy.migrationError)
      setStep('preview')
    }
  }

  const summary = preview?.summary
  const migrated = summary?.migrated ?? 0
  const conflicts = summary?.conflict ?? 0

  return (
    <Dialog onOpenChange={onClose} open={open}>
      <DialogContent className="max-h-[85vh] max-w-lg gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{copy.migrationTitle}</DialogTitle>
        <div className="border-b border-(--ui-border) px-4 py-3">
          <h2 className="text-sm font-semibold">{copy.migrationTitle}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{copy.migrationIntro}</p>
        </div>

        <div className="grid gap-3 p-4">
          {step === 'scan' && (
            <div className="grid gap-2">
              {scanning ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {copy.migrationScanning}
                </div>
              ) : sourceDir ? (
                <p className="text-xs text-emerald-600">{copy.migrationFound(sourceDir)}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{copy.migrationNotFound}</p>
              )}
              <div className="mt-2 flex justify-end">
                <Button
                  disabled={!sourceDir || scanning}
                  onClick={() => void handlePreview()}
                  size="sm"
                  type="button"
                >
                  {previewing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {copy.migrationPreview}
                </Button>
              </div>
            </div>
          )}

          {step === 'preview' && (
            <div className="grid gap-3">
              {previewing ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {copy.migrationPreviewing}
                </div>
              ) : (
                <>
                  {migrated === 0 && conflicts === 0 ? (
                    <p className="text-xs text-muted-foreground">{copy.migrationPreviewEmpty}</p>
                  ) : (
                    <div className="grid gap-1.5">
                      {migrated > 0 && (
                        <p className="text-xs text-emerald-600">{copy.migrationWillImport(migrated)}</p>
                      )}
                      {conflicts > 0 && (
                        <p className="text-xs text-amber-600">{copy.migrationConflicts(conflicts)}</p>
                      )}
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={overwrite} onCheckedChange={v => setOverwrite(Boolean(v))} />
                    {copy.migrationOverwrite}
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={secrets} onCheckedChange={v => setSecrets(Boolean(v))} />
                    {copy.migrationSecrets}
                  </label>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button onClick={() => setStep('scan')} size="sm" type="button" variant="ghost">
                      {copy.migrationBack}
                    </Button>
                    <Button
                      disabled={migrated === 0 && conflicts === 0}
                      onClick={() => void handleApply()}
                      size="sm"
                      type="button"
                    >
                      {copy.migrationApply}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 'applying' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {copy.migrationApplying}
            </div>
          )}

          {step === 'done' && (
            <div className="grid gap-2">
              <p className="text-xs text-emerald-600">{copy.migrationDone}</p>
              {migrated > 0 && <p className="text-xs text-muted-foreground">{copy.migrationWillImport(migrated)}</p>}
              <div className="mt-2 flex justify-end">
                <Button onClick={onClose} size="sm" type="button">
                  OK
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
