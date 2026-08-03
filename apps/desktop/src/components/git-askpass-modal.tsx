import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { desktopGit } from '@/lib/desktop-git'
import { $askpassRequest, clearAskpassRequest, type AskpassRequest } from '@/store/prompts'
import { notifyError } from '@/store/notifications'

// Floating modal for git credential prompts (HTTPS username / password /
// SSH passphrase). Git invokes our `GIT_ASKPASS` shim whenever it needs
// a secret; the shim long-polls `/api/git/askpass` and the backend emits
// a `git.askpass.request` event. This component receives that event,
// shows the prompt here (NOT in the terminal where the desktop was
// launched), and posts the answer back via `/api/git/askpass/respond`.
//
// We auto-detect the prompt kind from the prompt string (`Username for
// '…':` → username field, `Password for '…':` → password, otherwise a
// generic passphrase) so the user can hit Enter without typing a label.
// The single input is always rendered as type="password" for safety —
// git's askpass semantics treat the answer as a secret anyway.

const USERNAME_RE = /username for ['"]?([^'":]+)/i
const PASSWORD_RE = /password for ['"]?([^'":]+)/i

function classifyPrompt(prompt: string): { host: string | null; kind: 'password' | 'passphrase' | 'username' } {
  const usernameMatch = USERNAME_RE.exec(prompt)
  if (usernameMatch) {
    return { host: usernameMatch[1], kind: 'username' }
  }
  const passwordMatch = PASSWORD_RE.exec(prompt)
  if (passwordMatch) {
    return { host: passwordMatch[1], kind: 'password' }
  }
  return { host: null, kind: 'passphrase' }
}

export function GitAskpassModal() {
  const { t } = useI18n()
  const request = useStore($askpassRequest)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset the input + focus when a new request arrives.
  useEffect(() => {
    if (request) {
      setValue('')
      setSubmitting(false)
      // Focus on the next frame so Radix's focus trap has settled.
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [request?.requestId])

  const send = useCallback(
    async (answer: string) => {
      if (!request) {
        return
      }
      setSubmitting(true)
      try {
        await desktopGit()?.askpassRespond(request.requestId, answer)
        clearAskpassRequest()
      } catch (err) {
        notifyError(err, t.prompts.askpassSendFailed)
        setSubmitting(false)
      }
    },
    [request, t.prompts.askpassSendFailed]
  )

  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      void send(value)
    },
    [send, value]
  )

  const onCancel = useCallback(() => {
    // Empty answer → git aborts the operation with "could not read
    // username" / "could not read password". Cleanest cancel path.
    void send('')
  }, [send])

  if (!request) {
    return null
  }
  return <AskpassDialog request={request} inputRef={inputRef} onCancel={onCancel} onSubmit={onSubmit} submitting={submitting} value={value} setValue={setValue} />
}

interface AskpassDialogProps {
  inputRef: React.MutableRefObject<HTMLInputElement | null>
  onCancel: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  request: AskpassRequest
  setValue: (value: string) => void
  submitting: boolean
  value: string
}

function AskpassDialog({ inputRef, onCancel, onSubmit, request, setValue, submitting, value }: AskpassDialogProps) {
  const { t } = useI18n()
  const copy = t.prompts
  const { host, kind } = classifyPrompt(request.prompt)
  // Password / passphrase fields mask the input; the username prompt is
  // rare (git only asks when the URL has no embedded user), but we
  // still mask for consistency.
  const inputType = 'password'
  const label =
    kind === 'username'
      ? copy.askpassUsernameLabel
      : kind === 'password'
        ? copy.askpassPasswordLabel
        : copy.askpassPassphraseLabel
  return (
    <Dialog onOpenChange={open => !open && onCancel()} open>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Codicon className="text-amber-500" name="shield" size="1rem" />
              {copy.askpassTitle}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {host ? copy.askpassDescriptionWithHost(host) : copy.askpassDescriptionGeneric}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <label className="text-xs font-medium" htmlFor="git-askpass-input">
              {label}
            </label>
            <Input
              autoComplete="off"
              disabled={submitting}
              id="git-askpass-input"
              onChange={event => setValue(event.target.value)}
              placeholder={label}
              ref={inputRef}
              spellCheck={false}
              type={inputType}
              value={value}
            />
            <p className="text-[0.7rem] text-muted-foreground/80">{copy.askpassHint}</p>
          </div>
          <DialogFooter>
            <Button disabled={submitting} onClick={onCancel} type="button" variant="outline">
              {copy.cancel}
            </Button>
            <Button disabled={submitting || !value} type="submit">
              {submitting ? copy.submitting : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
