import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { IconClockPause, IconThumbUp } from '@tabler/icons-react'
import { DeferForm } from '@/components/findings/defer-form'
import { DEFER_COPY } from '@/lib/defer'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/errors'
import { deferFinding, refreshAfterDecision, type DeferKind } from '@/lib/view-api'

export interface BulkResult {
  ok: number
  failed: { id: number; message: string }[]
  kind: DeferKind
}

/**
 * Snooze or accept many findings at once. The API takes one finding per call, so the bar sends
 * them one after another and reports any that failed (a fixed finding, for example) by name.
 */
export function BulkBar({
  ids,
  labelOf,
  onClear,
  onDone,
}: {
  ids: readonly number[]
  labelOf: (id: number) => string
  onClear: () => void
  onDone: (result: BulkResult) => void
}) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<DeferKind | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = ids.length

  async function submit(k: DeferKind, body: { reason: string; until: string }) {
    setPending(true)
    setError(null)
    const failed: BulkResult['failed'] = []
    let ok = 0
    for (const id of ids) {
      try {
        await deferFinding(id, k, body)
        ok++
      } catch (e) {
        failed.push({ id, message: describeError(e) })
      }
    }
    await refreshAfterDecision(queryClient)
    setPending(false)
    if (failed.length > 0) {
      setError(
        `${ok} of ${n} saved. Not saved: ${failed.map((f) => `${labelOf(f.id)} (${f.message.replace(/\.$/, '')})`).join(', ')}.`,
      )
    } else {
      setKind(null)
    }
    onDone({ ok, failed, kind: k })
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="sticky bottom-[calc(80px+env(safe-area-inset-bottom))] z-[6] mt-3 flex flex-col gap-3 rounded-lg border border-input bg-card px-3.5 py-3 shadow-pop tab:bottom-[calc(16px+env(safe-area-inset-bottom))]"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <b className="font-semibold" aria-live="polite">
          {n} selected
        </b>
        {kind === null ? (
          <>
            <Button size="sm" onClick={() => setKind('snooze')}>
              <IconClockPause aria-hidden="true" />
              {DEFER_COPY.snooze.verb}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setKind('accept')}>
              <IconThumbUp aria-hidden="true" />
              {DEFER_COPY.accept.verb}
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClear} disabled={pending}>
          Clear selection
        </Button>
      </div>
      {kind !== null ? (
        <DeferForm
          key={kind}
          kind={kind}
          layout="inline"
          count={n}
          pending={pending}
          error={error}
          onSubmit={(k, body) => void submit(k, body)}
          onCancel={() => {
            setKind(null)
            setError(null)
          }}
        />
      ) : null}
    </div>
  )
}
