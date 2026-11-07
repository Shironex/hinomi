import type { FixPlan, FixPlanStep, FixRun, RepoRef } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconListCheck, IconPackage, IconShieldCheck } from '@tabler/icons-react'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { FixWithHinomi } from '@/components/views/fix-with-hinomi'
import { Section } from '@/components/views/panel'
import { PlanDiff } from '@/components/views/plan-diff'
import { planQuery, runnerQuery } from '@/lib/fix-api'
import { previewPlan, RISK_REASON_LABEL, runnerKindOf, type PlanPreview } from '@/lib/fix-run-meta'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { RunStateText } from './run-state-text'
import { RunnerPanel } from './runner-panel'

const RUNNER_WHERE = {
  github_actions: "the repo's own GitHub Actions",
  webhook: 'an external runner Hinomi posts it to',
  local: 'this Hinomi host',
} as const

const number = new Intl.NumberFormat('en-US')
const plural = (n: number, word: string) => `${number.format(n)} ${word}${n === 1 ? '' : 's'}`

type StepFate = 'sent' | 'not_sent' | 'risky' | 'majors'

const FATE: Record<
  StepFate,
  { label: string; variant: 'success' | 'default' | 'high' | 'accent' }
> = {
  sent: { label: 'In the fix PR', variant: 'success' },
  not_sent: { label: 'Not sent', variant: 'default' },
  risky: { label: 'Risky, listed only', variant: 'high' },
  majors: { label: 'Majors agent, draft PR', variant: 'accent' },
}

function fateOf(step: FixPlanStep, preview: PlanPreview, agent: boolean): StepFate {
  if (agent && preview.majors.includes(step)) return 'majors'
  if (step.risk === 'risky') return 'risky'
  return preview.sent.includes(step) ? 'sent' : 'not_sent'
}

function StepRow({ step, fate }: { step: FixPlanStep; fate: StepFate }) {
  const reasons = step.riskReasons.map((r) => RISK_REASON_LABEL[r] ?? r)
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t border-border px-4 py-3 first:border-t-0">
      <span className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
        {step.order}
      </span>
      <span className="min-w-0 font-mono text-sm font-semibold">
        {step.packageName}{' '}
        <span className="font-normal text-foreground-2">{step.from.join(', ') || '?'}</span>{' '}
        <span aria-label="to">→</span> <b className="font-semibold text-success">{step.to}</b>
      </span>
      <Badge variant={FATE[fate].variant}>{FATE[fate].label}</Badge>
      <span className="col-start-2 col-end-4 text-xs text-muted-foreground">
        {[
          step.relationship === 'unknown' ? 'relationship unknown' : step.relationship,
          step.level === 'unknown' ? null : `${step.level} bump`,
          step.lockfile ?? 'no lockfile',
          plural(step.findingIds.length, 'finding'),
          step.via.length ? `via ${step.via.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join(', ')}
      </span>
      {step.note || reasons.length ? (
        <span className="col-start-2 col-end-4 text-xs text-sev-high">
          {step.note ?? reasons.join(', ')}
        </span>
      ) : null}
    </li>
  )
}

function Steps({ plan, preview, agent }: { plan: FixPlan; preview: PlanPreview; agent: boolean }) {
  const steps = [...plan.steps].sort((a, b) => a.order - b.order)
  if (!steps.length) {
    return (
      <Callout icon={IconShieldCheck} variant="ok" title="Nothing to bump">
        Every open advisory of this repo is either fixed or has no patched version yet.
      </Callout>
    )
  }
  return (
    <ul
      aria-label="Plan steps"
      className="m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0"
    >
      {steps.map((step) => (
        <StepRow key={step.id} step={step} fate={fateOf(step, preview, agent)} />
      ))}
    </ul>
  )
}

function Unfixed({ plan }: { plan: FixPlan }) {
  if (!plan.unfixed.length) return null
  return (
    <Section
      title="Unfixed"
      description={`${plural(plan.summary.findings.unfixed, 'finding')} no step can clear yet`}
    >
      <ul className="m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0">
        {plan.unfixed.map((u) => (
          <li
            key={`${u.packageName}:${u.lockfile ?? ''}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-border px-4 py-3 first:border-t-0"
          >
            <span className="min-w-0 truncate font-mono text-sm font-semibold">
              {u.packageName}{' '}
              <span className="font-normal text-foreground-2">{u.installed.join(', ')}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {u.blocker === 'no_patch'
                ? 'No patched version yet'
                : `Too new until ${u.availableAt ? formatRelative(u.availableAt) : 'the gate clears'}`}
            </span>
            <span className="col-span-2 truncate font-mono text-xs text-muted-foreground">
              {u.advisories.join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function RepoRuns({ runs }: { runs: readonly FixRun[] }) {
  if (!runs.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No fix run yet. Dispatch the plan once the runner is ready.
      </p>
    )
  }
  return (
    <ul className="m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0">
      {runs.map((run) => (
        <li key={run.id} className="border-t border-border first:border-t-0">
          <Link
            to="/fix-runs"
            search={{ sel: run.id }}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-inherit no-underline hover:bg-muted"
          >
            <RunStateText run={run} />
            <span className="text-xs text-muted-foreground">
              {run.kind === 'majors' ? 'Majors run' : 'Run'} {run.id},{' '}
              {formatRelative(run.at.created)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
      <span className={cn('text-lg font-semibold tabular-nums', tone)}>{number.format(value)}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

/** A repo's latest fix plan: what the fix PR changes, every step, the runner and the runs. */
export function PlanPane({
  repo,
  runs,
  focused,
}: {
  repo: RepoRef
  runs: readonly FixRun[]
  focused: boolean
}) {
  const query = useQuery(planQuery(repo.id))
  const runner = useQuery(runnerQuery(repo.id))
  // The local runner never takes the majors agent, whatever the setting says.
  const agent =
    (runner.data?.settings.majorsAgent ?? 'off') !== 'off' && runnerKindOf(runner.data) !== 'local'
  const plan = query.data
  const preview = plan ? previewPlan(plan) : null
  const latest = runs[0]
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
          <Badge variant="accent">
            <IconListCheck aria-hidden="true" />
            Fix plan
          </Badge>
          {plan ? (
            <span>
              Built by scan {plan.scanRunId}, {formatRelative(plan.createdAt)}
            </span>
          ) : null}
          {latest ? <RunStateText run={latest} /> : null}
        </div>
        <h1 className={focused ? 'text-lg tab:text-xl' : 'text-lg'}>
          Fix plan for <span className="font-mono">{repo.fullName}</span>
        </h1>
        {plan && preview ? (
          <p className="max-w-[68ch] text-foreground-2">
            {preview.sent.length
              ? `One pull request with ${plural(preview.sent.length, 'safe step')} clears ${plural(preview.findings, 'finding')}. Risky upgrades are listed in its body, never applied.`
              : 'No safe step the runner can apply. Risky upgrades and unfixed packages are listed below.'}
            {agent && preview.majors.length
              ? ` The majors agent takes ${plural(preview.majors.length, 'major upgrade')} into ${preview.sent.length ? 'a second, ' : 'one '}draft pull request.`
              : ''}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <FixWithHinomi repos={plan ? [{ id: repo.id, fullName: repo.fullName }] : []} hint />
        </div>
      </div>

      {query.error ? (
        <ErrorState
          title="The plan did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : !plan || !preview ? (
        <div role="status" aria-label="Loading the plan" className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 tab:grid-cols-4">
            <Stat value={preview.findings} label="Findings the fix PR clears" tone="text-success" />
            <Stat value={plan.summary.findings.total} label="Open fixable findings" />
            <Stat value={plan.summary.steps.risky} label="Risky steps, listed only" />
            <Stat value={plan.summary.findings.unfixed} label="Findings with no patch" />
          </div>
          {plan.previous ? (
            <p className="text-sm text-foreground-2">
              The previous plan (scan {plan.previous.scanRunId}) covered{' '}
              {plural(plan.previous.findings, 'finding')}: {number.format(plan.previous.cleared)}{' '}
              cleared since, {number.format(plan.previous.stillOpen)} still open.
            </p>
          ) : null}
          <Section
            title="What the fix PR changes"
            description="Range prefixes are kept; lockfiles are regenerated by the install"
          >
            <PlanDiff files={preview.files} />
          </Section>
          <Section
            title="Steps"
            description={`${plural(plan.summary.steps.safe, 'safe step')}, ${plural(plan.summary.steps.risky, 'risky step')}`}
          >
            <Steps plan={plan} preview={preview} agent={agent} />
          </Section>
          <Unfixed plan={plan} />
        </>
      )}

      <Section
        title="Runner"
        description={`Where the plan runs: ${RUNNER_WHERE[runnerKindOf(runner.data)]}`}
      >
        <RunnerPanel repoId={repo.id} />
      </Section>
      <Section
        title="Runs"
        description={runs.length ? `${plural(runs.length, 'run')}, newest first` : undefined}
      >
        <RepoRuns runs={runs} />
      </Section>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <IconPackage aria-hidden="true" className="size-3.5" stroke={1.75} />
        Every scan builds a new plan; the runner always takes the latest.
      </p>
    </>
  )
}
