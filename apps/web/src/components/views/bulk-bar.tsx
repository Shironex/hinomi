import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { IconArrowBackUp, IconClockPause, IconThumbUp } from '@tabler/icons-react'
import { DeferForm } from '@/components/findings/defer-form'
import type { BulkFindingsRequest } from '@hinomi/shared'
import { DEFER_COPY } from '@/lib/defer'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { bulkFindings, refreshAfterDecision, type DeferKind } from '@/lib/view-api'

export type BulkAction = DeferKind | 'reopen'

export interface BulkResult {
  ok: number
  failed: { id: number; message: string }[]
  kind: BulkAction
}

/**
 * Snooze, accept or reopen many findings in one call. The server changes each finding on its
 * own and says which ones failed (a fixed finding, for example); those are reported by name.
 */
export function BulkBar({
  ids,
  labelOf,
  onClear,
  onDone,
  allowNewAdvisory = false,
  canReopen = false,
  className,
}: {
  ids: readonly number[]
  labelOf: (id: number) => string
  onClear: () => void
  onDone: (result: BulkResult) => void
  /** Every selected row is an advisory, so "until a new advisory" applies. */
  allowNewAdvisory?: boolean
  /** Some selected row is snoozed or accepted. */
  canReopen?: boolean
  className?: string
}) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<DeferKind | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = ids.length

  async function run(request: BulkFindingsRequest) {
    const action = request.action
    setPending(true)
    setError(null)
    let result: BulkResult
    try {
      const answer = await bulkFindings(request)
      result = {
        ok: answer.ok,
        failed: answer.results.flatMap((r) =>
          r.ok ? [] : [{ id: r.id, message: r.error.message }],
        ),
        kind: action,
      }
    } catch (e) {
      result = { ok: 0, failed: ids.map((id) => ({ id, message: describeError(e) })), kind: action }
    }
    await refreshAfterDecision(queryClient)
    setPending(false)
    if (result.failed.length > 0) {
      setError(
        `${result.ok} of ${n} saved. Not saved: ${result.failed.map((f) => `${labelOf(f.id)} (${f.message.replace(/\.$/, '')})`).join(', ')}.`,
      )
    } else {
      setKind(null)
    }
    onDone(result)
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className={cn(
        'sticky bottom-[calc(80px+env(safe-area-inset-bottom))] z-[6] mt-3 flex flex-col gap-3 rounded-lg border border-input bg-card px-3.5 py-3 shadow-pop tab:bottom-[calc(16px+env(safe-area-inset-bottom))]',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <b className="font-semibold" aria-live="polite">
          {n} selected
        </b>
        {kind === null ? (
          <>
            <Button size="sm" onClick={() => setKind('snooze')} disabled={pending}>
              <IconClockPause aria-hidden="true" />
              {DEFER_COPY.snooze.verb}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setKind('accept')}
              disabled={pending}
            >
              <IconThumbUp aria-hidden="true" />
              {DEFER_COPY.accept.verb}
            </Button>
            {canReopen ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void run({ action: 'reopen', ids: [...ids] })}
                disabled={pending}
              >
                <IconArrowBackUp aria-hidden="true" />
                {pending ? 'Reopening' : 'Remove decision'}
              </Button>
            ) : null}
          </>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClear} disabled={pending}>
          Clear selection
        </Button>
      </div>
      {kind === null && error ? (
        <p role="alert" className="text-sm text-sev-critical">
          {error}
        </p>
      ) : null}
      {kind !== null ? (
        <DeferForm
          key={kind}
          kind={kind}
          layout="inline"
          count={n}
          allowNewAdvisory={allowNewAdvisory}
          pending={pending}
          error={error}
          onSubmit={(k, body) => void run({ action: k, ids: [...ids], ...body })}
          onCancel={() => {
            setKind(null)
            setError(null)
          }}
        />
      ) : null}
    </div>
  )
}
