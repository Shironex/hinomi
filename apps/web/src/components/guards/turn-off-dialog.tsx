import { useId, useState } from 'react'
import type { CheckOverrideRef, OverridableCheck } from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconAlertCircle, IconLoader2 } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { describeError } from '@/lib/errors'
import { checkTitle } from '@/lib/guard-meta'
import {
  createOverride,
  deleteOverride,
  refreshAfterOverride,
  updateOverride,
} from '@/lib/guards-api'

export type OverrideScope = CheckOverrideRef['scope']

/** What the dialog acts on: a new override for a check, or an existing one. */
export type TurnOffTarget =
  | {
      mode: 'create'
      check: OverridableCheck
      /** The deployment the check can be turned off for, when the subject is one. */
      deployment?: { id: number; name: string } | null
      /** The repo the check can be turned off for. */
      repo?: { id: number; fullName: string } | null
      /** Preselected scope; falls back to the deployment when there is one. */
      scope?: OverrideScope
    }
  | {
      mode: 'edit'
      check: OverridableCheck
      override: Pick<CheckOverrideRef, 'id' | 'scope' | 'reason'>
      /** "storefront-web" or "kestrel-co/storefront", what the override is on. */
      subject: string
    }

const REASON_MAX = 500

const TEXTAREA =
  'min-h-[88px] w-full min-w-0 resize-y rounded-md border border-input bg-card px-2.5 py-2 text-sm leading-[1.45] placeholder:text-muted-foreground aria-invalid:border-sev-critical'

/**
 * Turn a check off for one deployment or one repo, with a required reason (decisions Q3 and
 * Q4); or edit the reason of an existing override, or turn the check back on. The check keeps
 * running: its finding stays listed as accepted with the reason, never hidden.
 */
export function TurnOffDialog({
  target,
  onOpenChange,
  onDone,
}: {
  /** Null keeps the dialog closed. */
  target: TurnOffTarget | null
  onOpenChange: (open: boolean) => void
  /** A sentence for the page's status line once the change is saved. */
  onDone?: (message: string) => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(500px,calc(100%-32px))]">
        {target ? (
          <TurnOffForm
            key={target.mode === 'edit' ? `edit-${target.override.id}` : `new-${target.check}`}
            target={target}
            onClose={() => onOpenChange(false)}
            onDone={onDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TurnOffForm({
  target,
  onClose,
  onDone,
}: {
  target: TurnOffTarget
  onClose: () => void
  onDone?: (message: string) => void
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const editing = target.mode === 'edit'
  const title = checkTitle(target.check)
  const [reason, setReason] = useState(editing ? target.override.reason : '')
  const [touched, setTouched] = useState(false)
  const scopes: { value: OverrideScope; label: string; sub: string }[] = []
  if (target.mode === 'create' && target.deployment) {
    scopes.push({
      value: 'deployment',
      label: `This deployment, ${target.deployment.name}`,
      sub: 'Other deployments keep the check on.',
    })
  }
  if (target.mode === 'create' && target.repo) {
    scopes.push({
      value: 'repo',
      label: `The whole repo, ${target.repo.fullName}`,
      sub: 'Covers the repo and every deployment that runs it.',
    })
  }
  const [scope, setScope] = useState<OverrideScope>(
    target.mode === 'create' ? (target.scope ?? scopes[0]?.value ?? 'deployment') : 'deployment',
  )

  const finish = async (message: string) => {
    await refreshAfterOverride(queryClient)
    onDone?.(message)
    onClose()
  }
  const save = useMutation({
    mutationFn: async (text: string) => {
      if (target.mode === 'edit') return updateOverride(target.override.id, text)
      const subject =
        scope === 'repo' && target.repo
          ? { repoId: target.repo.id }
          : { deploymentId: target.deployment?.id }
      return createOverride({ check: target.check, reason: text, ...subject })
    },
    onSuccess: () =>
      finish(
        editing
          ? 'Reason saved. The accepted finding shows the new reason.'
          : `${title} turned off. The finding stays listed as accepted with your reason.`,
      ),
  })
  const remove = useMutation({
    mutationFn: () =>
      target.mode === 'edit' ? deleteOverride(target.override.id) : Promise.resolve(),
    onSuccess: () => finish(`${title} is on again. A finding it still reports is open again.`),
  })
  const pending = save.isPending || remove.isPending
  const error = save.error ?? remove.error

  const trimmed = reason.trim()
  const reasonError = touched && trimmed === ''
  const unchanged = editing && trimmed === target.override.reason

  return (
    <form
      noValidate
      aria-label={editing ? 'Edit the override' : 'Turn off the check'}
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (trimmed === '' || pending) return
        if (unchanged) {
          onClose()
          return
        }
        save.mutate(trimmed)
      }}
    >
      <DialogHeader>
        <DialogTitle>{editing ? 'Turned off with a reason' : `Turn off: ${title}`}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-4 py-4">
        <DialogDescription className="text-sm text-foreground-2">
          The check keeps running on every scan. Its finding stays listed under Risk accepted with
          your reason, its level and evidence stay current, and it is never sent as a notification.
          {editing ? ' Turning it back on reopens the finding if the check still reports it.' : ''}
        </DialogDescription>

        {editing ? (
          <p className="text-sm">
            <b className="font-semibold">{title}</b>{' '}
            <span className="text-foreground-2">
              is off for {target.override.scope === 'repo' ? 'the repo' : 'the deployment'}{' '}
              <span className="font-mono">{target.subject}</span>.
            </span>
          </p>
        ) : scopes.length > 1 ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Turn it off for</legend>
            {scopes.map((s) => (
              <label
                key={s.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2 text-sm has-checked:border-input has-checked:bg-muted has-focus-visible:outline-2 has-focus-visible:outline-ring"
              >
                <input
                  type="radio"
                  name={`${id}-scope`}
                  value={s.value}
                  checked={scope === s.value}
                  onChange={() => setScope(s.value)}
                  className="mt-0.5 size-4 accent-(--primary)"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{s.label}</span>
                  <span className="text-xs text-muted-foreground">{s.sub}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : scopes[0] ? (
          <p className="text-sm text-foreground-2">
            For <span className="font-medium text-foreground">{scopes[0].label}</span>.{' '}
            {scopes[0].sub}
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-reason`} className="text-sm font-medium">
            Reason
          </label>
          <textarea
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={REASON_MAX}
            rows={3}
            autoFocus
            placeholder="Why is this check not needed here?"
            aria-invalid={reasonError || undefined}
            aria-describedby={reasonError ? `${id}-reason-err` : `${id}-reason-hint`}
            className={TEXTAREA}
          />
          {reasonError ? (
            <span
              id={`${id}-reason-err`}
              className="flex items-center gap-1.5 text-xs text-sev-critical"
            >
              <IconAlertCircle aria-hidden="true" className="size-3.5" />
              Add a reason so the next person knows why.
            </span>
          ) : (
            <span id={`${id}-reason-hint`} className="text-xs text-muted-foreground">
              Required. Shown on the finding and on the checks page.
            </span>
          )}
        </div>

        {error ? (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-sev-critical">
            <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {describeError(error)}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {editing ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => remove.mutate()}
            disabled={pending}
          >
            {remove.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
            Turn the check back on
          </Button>
        ) : null}
        <span className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {save.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
            {editing ? 'Save reason' : 'Turn off'}
          </Button>
        </span>
      </div>
    </form>
  )
}
