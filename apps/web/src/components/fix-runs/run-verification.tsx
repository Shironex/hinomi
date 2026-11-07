import type { FixRunVerification } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import {
  IconCalendarRepeat,
  IconHourglassHigh,
  IconRefreshAlert,
  IconShieldCheck,
  IconShieldX,
  type Icon,
} from '@tabler/icons-react'
import { Callout } from '@/components/ui/callout'
import { VERIFY_AFTER_TEXT } from '@/lib/fix-run-meta'
import { formatRelative } from '@/lib/format'

const number = new Intl.NumberFormat('en-US')
const plural = (n: number, word: string) => `${number.format(n)} ${word}${n === 1 ? '' : 's'}`

type Variant = 'default' | 'info' | 'warn' | 'danger' | 'ok'

function heading(v: FixRunVerification): { icon: Icon; variant: Variant; title: string } {
  switch (v.status) {
    case 'pending':
      return { icon: IconHourglassHigh, variant: 'info', title: 'Waiting for the rescan' }
    case 'retrying':
      return { icon: IconRefreshAlert, variant: 'warn', title: 'The rescan is retrying' }
    case 'scheduled_scan':
      return {
        icon: IconCalendarRepeat,
        variant: 'warn',
        title: 'The next scheduled scan verifies this run',
      }
    case 'done':
      if (v.stillOpen.length) {
        return {
          icon: IconShieldX,
          variant: 'danger',
          title: `${plural(v.stillOpen.length, 'finding')} of ${number.format(v.targeted.length)} still open`,
        }
      }
      return {
        icon: IconShieldCheck,
        variant: 'ok',
        title:
          v.targeted.length === 0
            ? 'The rescan found nothing left to clear'
            : v.targeted.length === 1
              ? 'The rescan cleared the finding'
              : `The rescan cleared all ${plural(v.targeted.length, 'finding')}`,
      }
  }
}

function FindingLinks({ label, ids }: { label: string; ids: readonly number[] }) {
  if (!ids.length) return null
  return (
    <p className="m-0">
      {label}:{' '}
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? ', ' : ''}
          <Link
            to="/finding/$id"
            params={{ id: String(id) }}
            aria-label={`finding #${id}`}
            className="text-accent-ink hover:underline"
          >
            #{id}
          </Link>
        </span>
      ))}
    </p>
  )
}

/** The rescan after the merge: what it waits for, where it stands and how the findings came out. */
export function RunVerification({ verification: v }: { verification: FixRunVerification }) {
  const head = heading(v)
  const scan = v.scan
    ? v.scan.kind === 'full'
      ? `Compared with full scan ${v.scan.scanRunId ?? ''}, ${formatRelative(v.scan.at)}.`
      : `Compared with a rescan of the repo, ${formatRelative(v.scan.at)}.`
    : null
  return (
    <Callout icon={head.icon} variant={head.variant} title={head.title}>
      <div className="flex flex-col gap-1.5">
        <p className="m-0">
          {VERIFY_AFTER_TEXT[v.after]}
          {scan ? ` ${scan}` : ''}
        </p>
        {v.status === 'done' ? (
          <p className="m-0 tabular-nums">
            {number.format(v.targeted.length)} targeted, {number.format(v.cleared.length)} cleared,{' '}
            {number.format(v.stillOpen.length)} still open, {number.format(v.new.length)} new
          </p>
        ) : null}
        <FindingLinks label="Still open" ids={v.stillOpen} />
        <FindingLinks label="New in the rescan" ids={v.new} />
        {v.attempts > 0 && v.status !== 'done' ? (
          <p className="m-0">
            {plural(v.attempts, 'rescan')} failed
            {v.nextAttemptAt ? `, next try ${formatRelative(v.nextAttemptAt)}` : ''}.
          </p>
        ) : null}
        {v.lastError ? <p className="m-0 text-sev-critical">Last error: {v.lastError}</p> : null}
      </div>
    </Callout>
  )
}
