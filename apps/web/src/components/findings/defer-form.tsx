import { useId, useState } from 'react'
import { IconAlertCircle } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  DAY_MS,
  DEFER_COPY,
  EXPIRY_CHOICES,
  expiryOf,
  localDay,
  type DeferExpiry,
  type ExpiryChoice,
} from '@/lib/defer'
import { cn } from '@/lib/utils'
import type { DeferKind } from '@/lib/view-api'
import { nowMs } from '@hinomi/shared'

export interface DeferFormProps {
  /** Shows the snooze or accept switch. Without it the kind is fixed. */
  kind: DeferKind
  onKindChange?: (kind: DeferKind) => void
  onSubmit: (kind: DeferKind, body: { reason: string } & DeferExpiry) => void
  /** Offers "until a new advisory" (advisories only, not blind spots). */
  allowNewAdvisory?: boolean
  onCancel: () => void
  pending?: boolean
  /** A server error to show under the form. */
  error?: string | null
  /** Inline is the bulk bar's one-row layout. */
  layout?: 'stack' | 'inline'
  /** How many findings the decision covers, for the bulk label. */
  count?: number
  className?: string
}

/**
 * Snooze or accept a finding: a reason and an expiry are both required, as the API demands,
 * and both stay visible on the finding afterwards.
 */
export function DeferForm({
  kind,
  onKindChange,
  onSubmit,
  onCancel,
  allowNewAdvisory = false,
  pending = false,
  error,
  layout = 'stack',
  count,
  className,
}: DeferFormProps) {
  const id = useId()
  const [reason, setReason] = useState('')
  const [choice, setChoice] = useState<ExpiryChoice>('30')
  const [date, setDate] = useState(() => localDay(nowMs() + 14 * DAY_MS))
  const [minDay] = useState(() => localDay(nowMs() + DAY_MS))
  const [touched, setTouched] = useState(false)

  const reasonMissing = reason.trim() === ''
  const dateValid = choice !== 'date' || (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= minDay)
  const reasonError = touched && reasonMissing
  const dateError = touched && !dateValid

  const inline = layout === 'inline'
  const reasonLabel = inline
    ? `${kind === 'snooze' ? 'Why snooze these' : 'Why accept this risk'}${count ? ` (${count} finding${count === 1 ? '' : 's'})` : ''}`
    : 'Reason'

  return (
    <form
      noValidate
      aria-label={inline ? `${DEFER_COPY[kind].verb} selected findings` : 'Snooze or accept risk'}
      className={cn(inline ? 'flex flex-wrap items-start gap-3' : 'flex flex-col gap-4', className)}
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        const expiry = expiryOf(choice, date, nowMs())
        if (reasonMissing || expiry === null || pending) return
        onSubmit(kind, { reason: reason.trim(), ...expiry })
      }}
    >
      {onKindChange ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">Decision</legend>
          <div className="inline-flex gap-0.5 self-start rounded-md bg-muted p-0.5">
            {(['snooze', 'accept'] as const).map((k) => (
              <label
                key={k}
                className="cursor-pointer rounded-sm px-2.5 py-1 text-xs text-foreground-2 has-checked:bg-card has-checked:text-foreground has-checked:shadow-[0_1px_2px_oklch(0.2_0.02_265/0.12)] has-focus-visible:outline-2 has-focus-visible:outline-ring"
              >
                <input
                  type="radio"
                  name={`${id}-kind`}
                  value={k}
                  checked={kind === k}
                  onChange={() => onKindChange(k)}
                  className="sr-only"
                />
                {DEFER_COPY[k].verb}
              </label>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            Snooze when a fix is planned. Accept risk when you decided not to fix. Both stay
            visible.
          </span>
        </fieldset>
      ) : null}

      <div className={cn('flex flex-col gap-1.5', inline && 'min-w-[220px] flex-[2]')}>
        <label htmlFor={`${id}-reason`} className="text-sm font-medium">
          {reasonLabel}
        </label>
        {inline ? (
          <input
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Shared reason, shown on every finding"
            aria-invalid={reasonError || undefined}
            aria-describedby={reasonError ? `${id}-reason-err` : undefined}
            className="h-[34px] w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-sm placeholder:text-muted-foreground aria-invalid:border-sev-critical"
          />
        ) : (
          <textarea
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Why is this safe enough for now?"
            aria-invalid={reasonError || undefined}
            aria-describedby={reasonError ? `${id}-reason-err` : undefined}
            className="min-h-[72px] w-full min-w-0 resize-y rounded-md border border-input bg-card px-2.5 py-2 text-sm leading-[1.45] placeholder:text-muted-foreground aria-invalid:border-sev-critical"
          />
        )}
        {reasonError ? (
          <span
            id={`${id}-reason-err`}
            className="flex items-center gap-1.5 text-xs text-sev-critical"
          >
            <IconAlertCircle aria-hidden="true" className="size-3.5" />
            Add a reason so the next person knows why.
          </span>
        ) : null}
      </div>

      <div className={cn('flex flex-col gap-1.5', inline && 'min-w-[150px] flex-1')}>
        <label htmlFor={`${id}-until`} className="text-sm font-medium">
          Expires
        </label>
        <select
          id={`${id}-until`}
          value={choice}
          onChange={(e) => setChoice(e.target.value as ExpiryChoice)}
          className="h-[34px] w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm"
        >
          {EXPIRY_CHOICES.filter((c) => allowNewAdvisory || c.value !== 'advisory').map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {choice === 'date' ? (
          <>
            <label htmlFor={`${id}-date`} className="sr-only">
              Expiry date
            </label>
            <input
              id={`${id}-date`}
              type="date"
              value={date}
              min={minDay}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={dateError || undefined}
              aria-describedby={dateError ? `${id}-date-err` : undefined}
              className="h-[34px] w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm aria-invalid:border-sev-critical"
            />
          </>
        ) : null}
        {dateError ? (
          <span
            id={`${id}-date-err`}
            className="flex items-center gap-1.5 text-xs text-sev-critical"
          >
            <IconAlertCircle aria-hidden="true" className="size-3.5" />
            Pick a day after today.
          </span>
        ) : !inline ? (
          <span className="text-xs text-muted-foreground">
            {choice === 'advisory'
              ? 'It returns to the ranking when a scan finds another advisory for the same package in this repo.'
              : 'After it expires the finding returns to the ranking and alerts again.'}
          </span>
        ) : null}
      </div>

      <div className={cn('flex flex-wrap items-center gap-2', inline && 'self-end pb-px')}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving' : inline ? 'Save' : 'Save decision'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>

      {error ? (
        <p role="alert" className="flex basis-full items-start gap-1.5 text-sm text-sev-critical">
          <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
    </form>
  )
}
