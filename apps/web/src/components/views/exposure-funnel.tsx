import type { OverviewResponse } from '@hinomi/shared'
import { Link, type LinkProps } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

const number = new Intl.NumberFormat('en-US')

interface Step {
  n: number
  short: string
  label: string
  note: string
  link: Pick<LinkProps, 'to' | 'search' | 'hash'>
}

function steps(f: OverviewResponse['funnel']): Step[] {
  return [
    {
      n: f.total,
      short: 'alerts',
      label: 'Open alerts, GitHub and OSV',
      note: f.dismissedUpstream
        ? `${number.format(f.dismissedUpstream)} dismissed upstream`
        : 'Fixed ones left out',
      link: { to: '/alerts' },
    },
    {
      n: f.deployed,
      short: 'deployed',
      label: 'In a repo that is deployed',
      note: `${number.format(f.total - f.deployed)} in repos not deployed`,
      link: { to: '/deployments' },
    },
    {
      n: f.runtime,
      short: 'runtime',
      label: 'In runtime dependencies',
      note: 'dev tooling set aside',
      link: { to: '/alerts', search: { scope: ['runtime'] } },
    },
    {
      n: f.criticalOrHigh,
      short: 'crit, high',
      label: 'Critical or high',
      note: `${number.format(Math.max(0, f.criticalOrHigh - f.public))} on internal apps`,
      link: { to: '/alerts', search: { severity: ['critical', 'high'], scope: ['runtime'] } },
    },
    {
      n: f.exposed,
      short: 'exposed',
      label: 'Exposed on a public app',
      note: `${number.format(f.needsAction)} need${f.needsAction === 1 ? 's' : ''} action`,
      link: { to: '/', hash: 'exposed-list' },
    },
  ]
}

/**
 * The sieve: how every open alert narrows to the few that are exposed. Each step links to the
 * rows behind it. On a phone it shrinks to five compact counts.
 */
export function ExposureFunnel({ funnel }: { funnel: OverviewResponse['funnel'] }) {
  const list = steps(funnel)
  const total = Math.max(funnel.total, 1)
  return (
    <nav
      aria-label={`How ${number.format(funnel.total)} alerts narrow down to ${number.format(funnel.exposed)} exposed`}
      className="grid grid-cols-5 overflow-hidden rounded-lg border border-border bg-card tab:max-desk:grid-cols-2"
    >
      {list.map((step, i) => {
        const last = i === list.length - 1
        return (
          <Link
            key={step.short}
            {...step.link}
            className={cn(
              'group relative flex min-w-0 flex-col gap-0.5 py-2.5 pr-1.5 pl-2.5 text-inherit no-underline tab:gap-1 tab:px-4 tab:pt-3.5 tab:pb-4',
              'focus-visible:outline-offset-[-2px]',
              last
                ? 'bg-accent hover:bg-[color-mix(in_oklch,var(--accent)_80%,var(--muted))]'
                : 'hover:bg-sidebar',
              'desk:border-r desk:border-border desk:last:border-r-0',
              'tab:max-desk:border-b tab:max-desk:border-border tab:max-desk:last:col-span-2 tab:max-desk:last:border-b-0 tab:max-desk:odd:border-r',
              !last &&
                "desk:after:absolute desk:after:top-1/2 desk:after:-right-1.5 desk:after:z-[1] desk:after:size-2.5 desk:after:-translate-y-1/2 desk:after:rotate-45 desk:after:border-t desk:after:border-r desk:after:border-border desk:after:bg-card desk:after:content-[''] desk:hover:after:bg-sidebar",
            )}
          >
            <span
              className={cn(
                'text-md leading-[1.1] font-semibold tracking-[-0.02em] tabular-nums tab:text-xl',
                last && 'text-accent-ink',
              )}
            >
              {number.format(step.n)}
            </span>
            <span className="text-[10.5px] leading-tight text-muted-foreground tab:hidden">
              {step.short}
            </span>
            <span className="hidden text-sm leading-snug text-foreground-2 tab:block">
              {step.label}
            </span>
            <span className="hidden text-xs text-muted-foreground tab:block">{step.note}</span>
            <span
              aria-hidden="true"
              className="mt-2 hidden h-1 overflow-hidden rounded-[2px] bg-muted tab:block"
            >
              <span
                className={cn(
                  'block h-full rounded-[2px]',
                  last ? 'bg-primary' : 'bg-foreground-2',
                )}
                style={{ width: `${Math.max((step.n / total) * 100, 2)}%` }}
              />
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
