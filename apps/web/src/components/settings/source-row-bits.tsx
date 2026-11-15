import type * as React from 'react'
import type { SourceTestResult } from '@hinomi/shared'
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { describeError } from '@/lib/errors'
import type { Health } from '@/lib/source-health'
import { cn } from '@/lib/utils'

/** Pieces every source row in Settings shares: its health, its facts and a test outcome. */

/** A failed sync is a connection problem, not a severity, so it is amber rather than red. */
export function HealthPill({ health }: { health: Health }) {
  if (health.tone === 'ok') {
    return (
      <Badge variant="success">
        <IconCheck aria-hidden="true" />
        {health.label}
      </Badge>
    )
  }
  if (health.tone === 'error' || health.tone === 'missing') {
    return (
      <Badge variant="outline" className="border-transparent bg-wait-soft text-wait">
        <IconAlertTriangle aria-hidden="true" />
        {health.label}
      </Badge>
    )
  }
  return <Badge variant="outline">{health.label}</Badge>
}

/** One term and value of a source, inline so the row stays short. */
export function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="shrink-0 text-muted-foreground">{term}</dt>
      <dd className="flex min-w-0 items-center">{children}</dd>
    </div>
  )
}

/** The last connection test, an error or a note, read out when it changes. */
export function TestOutcome({
  pending,
  result,
  error,
  note,
}: {
  pending: boolean
  result: SourceTestResult | undefined
  error: unknown
  note: string | null
}) {
  let content: React.ReactNode = null
  if (!pending && note) {
    content = <span className="text-success">{note}</span>
  } else if (!pending && error) {
    content = <span className="text-sev-critical">{describeError(error)}</span>
  } else if (!pending && result) {
    content = result.ok ? (
      <>
        <span className="text-success">
          {result.message}
          {result.scopes?.length ? `. Scopes: ${result.scopes.join(', ')}` : ''}.
        </span>
        {result.warning ? (
          <span className="mt-1 flex items-start gap-1.5 text-wait">
            <IconAlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {result.warning}
          </span>
        ) : null}
      </>
    ) : (
      <span className="text-sev-critical">{result.message}</span>
    )
  }
  return (
    <p aria-live="polite" className={cn('flex flex-col text-sm', !content && 'sr-only')}>
      {content}
    </p>
  )
}
