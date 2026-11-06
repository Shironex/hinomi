import { IconLock } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Callout } from '@/components/ui/callout'
import { cn } from '@/lib/utils'

const STEPS = [
  { title: 'Connect Coolify', sub: 'Your deployments, domains and servers' },
  { title: 'Connect GitHub', sub: 'Repos and their Dependabot alerts' },
  {
    title: 'Where should alerts go?',
    sub: 'Discord, webhook or email. You can skip this.',
    optional: true,
  },
  { title: 'Run the first scan', sub: 'Takes about a minute for 40 repos' },
]

export function OnboardingPage() {
  return (
    <div className="mx-auto mt-2 flex max-w-[760px] flex-col gap-6">
      <div className="grid items-center gap-6 tab:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <h1 className="text-xl leading-tight">
            Find what is exposed, not just what is vulnerable
          </h1>
          <p className="mt-2 max-w-[56ch] text-pretty text-foreground-2">
            Connect Coolify and GitHub. Hinomi joins your running apps with their Dependabot alerts
            and ranks them, so the few that are public and critical come first.
          </p>
        </div>
        <TowerArt />
      </div>
      <Callout
        variant="warn"
        icon={IconLock}
        title="Put this behind Tailscale or Cloudflare Access first"
      >
        Hinomi has no login yet. Anyone who reaches this page can read findings and start fix agents
        with your GitHub access.
      </Callout>
      <ol
        aria-label="Setup steps"
        className="overflow-hidden rounded-lg border border-border bg-card"
      >
        {STEPS.map((step, i) => {
          const active = i === 0
          return (
            <li
              key={step.title}
              aria-current={active ? 'step' : undefined}
              className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-border px-[18px] py-3.5 first:border-t-0"
            >
              <span
                className={cn(
                  'grid size-7 place-items-center rounded-full border-[1.5px] border-input font-mono text-xs font-medium text-muted-foreground',
                  active && 'border-primary text-accent-ink shadow-[0_0_0_4px_var(--accent)]',
                )}
              >
                {i + 1}
              </span>
              <span className="flex flex-col">
                <b className={cn('font-medium', !active && 'text-muted-foreground')}>
                  {step.title}
                </b>
                <small className="text-xs text-muted-foreground">{step.sub}</small>
              </span>
              {step.optional ? <Badge variant="outline">Optional</Badge> : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function TowerArt() {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      className="hidden size-[132px] shrink-0 tab:block"
    >
      <rect
        x="1"
        y="1"
        width="118"
        height="118"
        rx="14"
        fill="var(--sidebar)"
        stroke="var(--border)"
      />
      <path d="M24 96h72" stroke="var(--input)" strokeWidth="1.5" strokeLinecap="round" />
      <g stroke="var(--accent-ink)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
        <path d="M42 40 60 24l18 16" />
        <rect x="47" y="40" width="26" height="17" rx="1.5" />
        <path d="M51 57l-8 39M69 57l8 39M47 72h26M45 84h30" />
      </g>
      <circle cx="60" cy="48.5" r="3.6" fill="var(--sev-critical)" />
      <g fill="var(--input)">
        <rect x="14" y="80" width="10" height="16" rx="1" />
        <rect x="88" y="74" width="12" height="22" rx="1" />
        <rect x="101" y="84" width="8" height="12" rx="1" />
      </g>
    </svg>
  )
}
