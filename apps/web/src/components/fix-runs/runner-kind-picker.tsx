import type { FixRunnerKind, RunnerStatus } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import { IconAlertTriangle, IconCircleCheck, IconExternalLink } from '@tabler/icons-react'
import { StatusText } from '@/components/findings/finding-state'
import { Callout } from '@/components/ui/callout'
import { RUNNERS_DOCS_URL, RUNNER_KIND_INFO } from '@/lib/fix-run-meta'
import { cn } from '@/lib/utils'

interface KindOption {
  kind: FixRunnerKind
  note: string
}

const OPTIONS: readonly KindOption[] = [
  { kind: 'github_actions', note: "A workflow in the repo's own GitHub Actions. The default." },
  { kind: 'webhook', note: 'An external runner Hinomi posts the plan to: your CI or a build box.' },
  { kind: 'local', note: 'The Hinomi host itself. Opt in with HINOMI_LOCAL_RUNNER=1.' },
]

function WebhookState({ runners }: { runners: NonNullable<RunnerStatus['runners']> }) {
  const { configured, message } = runners.webhook
  return (
    <div className="flex flex-col gap-1 pl-[26px] text-sm">
      {configured ? (
        <StatusText icon={IconCircleCheck} tone="ok">
          Ready
        </StatusText>
      ) : (
        <StatusText icon={IconAlertTriangle} tone="wait">
          Not set up
        </StatusText>
      )}
      <p id="runner-kind-webhook-state" className="text-foreground-2">
        {message}{' '}
        <Link
          to="/settings"
          search={{ sel: 'runner' }}
          className="text-accent-ink underline-offset-2 hover:underline"
        >
          Webhook runner settings
        </Link>
      </p>
    </div>
  )
}

function LocalState({
  local,
}: {
  local: NonNullable<NonNullable<RunnerStatus['runners']>['local']>
}) {
  return (
    <div className="flex flex-col gap-2 pl-[26px] text-sm">
      <p id="runner-kind-local-state" className="text-foreground-2">
        {local.available ? null : <b className="font-semibold text-foreground">Not available. </b>}
        {local.message}
      </p>
      <Callout icon={IconAlertTriangle} variant="warn" title="Read before you use it">
        <span id="runner-kind-local-warning">{local.warning}</span>{' '}
        <a
          href={`${RUNNERS_DOCS_URL}#residual-risks`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-accent-ink hover:underline"
        >
          Residual risks
          <IconExternalLink aria-hidden="true" className="size-3.5" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </Callout>
    </div>
  )
}

/**
 * Where this repo's plans run: GitHub Actions, the webhook runner or the local runner. The local
 * kind is disabled while the host does not offer it, and its risk warning is always on screen.
 */
export function RunnerKindPicker({
  status,
  value,
  disabled,
  onChange,
}: {
  status: RunnerStatus
  value: FixRunnerKind
  disabled: boolean
  onChange: (kind: FixRunnerKind) => void
}) {
  const runners = status.runners
  if (!runners) return null
  const local = runners.local
  return (
    <fieldset className="flex min-w-0 flex-col gap-2.5 border-0 p-0">
      <legend className="mb-1 text-sm font-semibold">Where plans run</legend>
      {OPTIONS.map(({ kind, note }) => {
        const unavailable = kind === 'local' && !(local?.available ?? false)
        const described =
          kind === 'webhook'
            ? 'runner-kind-webhook-state'
            : kind === 'local' && local
              ? 'runner-kind-local-state runner-kind-local-warning'
              : undefined
        return (
          <div
            key={kind}
            className={cn(
              'flex flex-col gap-2 rounded-md border border-border px-3 py-2.5',
              value === kind && 'border-input bg-muted',
            )}
          >
            <label
              className={cn(
                'flex items-start gap-2.5 text-sm',
                disabled || unavailable ? 'cursor-not-allowed' : 'cursor-pointer',
              )}
            >
              <input
                type="radio"
                name="runner-kind"
                value={kind}
                checked={value === kind}
                disabled={disabled || unavailable}
                aria-describedby={described}
                onChange={() => onChange(kind)}
                className="mt-0.5 size-4 accent-(--primary)"
              />
              <span className="flex min-w-0 flex-col">
                <b className="font-semibold">{RUNNER_KIND_INFO[kind].label}</b>
                <span className="text-xs text-muted-foreground">{note}</span>
              </span>
            </label>
            {kind === 'webhook' ? <WebhookState runners={runners} /> : null}
            {kind === 'local' && local ? <LocalState local={local} /> : null}
          </div>
        )
      })}
    </fieldset>
  )
}
