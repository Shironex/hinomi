import type { GuardResult, OverviewWindow } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconCalendarEvent,
  IconChevronRight,
  IconCircleCheck,
} from '@tabler/icons-react'
import type { Icon } from '@tabler/icons-react'
import { Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import { formatDate } from '@/lib/finding-meta'
import { RUNTIME_LABEL } from '@/lib/guard-meta'
import { daysLeftText, WINDOW_STATE_LABEL } from '@/lib/runtime-meta'
import { cn } from '@/lib/utils'

/** Ink and icon per state: the words carry the meaning, the color only backs them up. */
const STATE: Record<'fail' | 'warn' | 'pass', { tone: string; icon: Icon }> = {
  fail: { tone: 'text-sev-high', icon: IconAlertOctagon },
  warn: { tone: 'text-sev-moderate', icon: IconAlertTriangle },
  pass: { tone: 'text-success', icon: IconCircleCheck },
}

const stateOf = (result: GuardResult) => (result === 'unknown' ? 'pass' : result)

/**
 * The strip of the overview: the runtime lines that end security support soonest across every
 * repo, each with its date and a link to the repo's runtime panel. Only runtimes judged by dates
 * (Node) appear here; Rust and Bun warn on releases behind and sit on the repo page.
 */
export function SupportWindows({ windows }: { windows: readonly OverviewWindow[] }) {
  return (
    <Panel>
      <PanelHeader title="Support windows" icon={IconCalendarEvent}>
        <span className="text-xs text-muted-foreground">Next lines to end</span>
      </PanelHeader>
      <PanelBody>
        {windows.length === 0 ? (
          <p className="text-sm text-foreground-2">
            No runtime line with an end date yet. Hinomi reads Node pins during a scan and fetches
            the dates from endoflife.date.
          </p>
        ) : (
          <ul
            aria-label="Runtime lines by end of support"
            className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-0"
          >
            {windows.map((w) => {
              const { tone, icon: IconCmp } = STATE[stateOf(w.result)]
              return (
                <li key={`${w.repoId}:${w.runtime}:${w.line}`} className="min-w-0">
                  <Link
                    to="/repos/$id"
                    params={{ id: String(w.repoId) }}
                    className="flex h-full flex-col gap-1 rounded-lg border border-border bg-sidebar px-3.5 py-3 text-sm text-inherit no-underline hover:border-input"
                  >
                    <span className="font-semibold">
                      {RUNTIME_LABEL[w.runtime]} {w.line}
                    </span>
                    <span
                      className="truncate font-mono text-xs text-foreground-2"
                      title={w.repoName}
                    >
                      {w.repoName}
                    </span>
                    <span
                      className={cn('mt-1 flex items-center gap-1.5 text-xs font-semibold', tone)}
                    >
                      <IconCmp aria-hidden="true" className="size-3.5" stroke={2} />
                      {WINDOW_STATE_LABEL[w.result]}
                    </span>
                    <span className="text-xs text-foreground-2">
                      <time dateTime={w.eolFrom}>{formatDate(w.eolFrom)}</time>
                      {', '}
                      {daysLeftText(w.daysLeft)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </PanelBody>
    </Panel>
  )
}

/**
 * One line for the list header when a runtime line has ended or is about to, so it is never out
 * of sight while advisories fill the list. Links to the repo of the line that ends first.
 */
export function SupportWindowsLine({ windows }: { windows: readonly OverviewWindow[] }) {
  const ended = windows.filter((w) => w.result === 'fail').length
  const ending = windows.filter((w) => w.result === 'warn').length
  const first = windows.find((w) => w.result === 'fail' || w.result === 'warn')
  if (!first) return null
  const parts = [
    ended > 0 ? `${ended} ended` : null,
    ending > 0 ? `${ending} ending soon` : null,
  ].filter(Boolean)
  return (
    <Link
      to="/repos/$id"
      params={{ id: String(first.repoId) }}
      className="flex items-center gap-2 rounded-md text-xs text-foreground-2 no-underline hover:text-foreground"
    >
      <IconCalendarEvent aria-hidden="true" className="size-3.5 shrink-0" stroke={1.75} />
      <b className="font-semibold">Support windows</b>
      <span>{parts.join(', ')}</span>
      <IconChevronRight aria-hidden="true" className="ml-auto size-3.5 shrink-0" />
    </Link>
  )
}
