import type { FixCheckResult, FixResultV1, FixRun, FixRunDetail, RepoRef } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconBrandGithub,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconClockExclamation,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconRobot,
} from '@tabler/icons-react'
import { StatusText } from '@/components/findings/finding-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { FixWithHinomi } from '@/components/views/fix-with-hinomi'
import { KeyValues, Panel, PanelBody, PanelHeader, Section } from '@/components/views/panel'
import { fixRunQuery } from '@/lib/fix-api'
import {
  formatDuration,
  orderedChecks,
  parseStepId,
  planKey,
  RUN_STATE_INFO,
  runNext,
  runTimeline,
  STEP_REASON_LABEL,
} from '@/lib/fix-run-meta'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { RunAgent } from './run-agent'
import { RunDeployments } from './run-deployments'
import { RunStateText } from './run-state-text'
import { RunTimeline } from './run-timeline'
import { RunVerification } from './run-verification'
import { RunWarnings } from './run-warnings'

const number = new Intl.NumberFormat('en-US')
const plural = (n: number, word: string) => `${number.format(n)} ${word}${n === 1 ? '' : 's'}`

const CHECK_STATUS = {
  passed: { icon: IconCircleCheck, tone: 'ok', word: 'Passed' },
  failed: { icon: IconCircleX, tone: 'bad', word: 'Failed' },
  timeout: { icon: IconClockExclamation, tone: 'bad', word: 'Timed out' },
  skipped: { icon: IconCircleDashed, tone: 'neutral', word: 'Skipped' },
} as const

/** The callout of a run that ended or waits for a person. */
function StateCallout({ run }: { run: FixRun }) {
  const info = RUN_STATE_INFO[run.state]
  const next = runNext(run)
  const reason = run.stateReason ? `${run.stateReason}. ` : ''
  switch (run.state) {
    case 'failed':
    case 'lost':
    case 'not_cleared':
      return (
        <Callout icon={info.icon} variant="danger" title={info.label}>
          {reason}
          {next}
        </Callout>
      )
    case 'checks_failing':
      return (
        <Callout icon={IconCircleX} variant="danger" title="Checks failing on the pull request">
          {next}
        </Callout>
      )
    case 'closed_unmerged':
      return (
        <Callout icon={IconGitPullRequestClosed} variant="warn" title="Pull request closed">
          {next}
        </Callout>
      )
    case 'cancelled':
    case 'superseded':
      return (
        <Callout icon={info.icon} title={info.label}>
          {reason}
          {next}
        </Callout>
      )
    default:
      return null
  }
}

function CheckRow({ check }: { check: FixCheckResult }) {
  const status = CHECK_STATUS[check.status]
  const bad = check.status === 'failed' || check.status === 'timeout'
  return (
    <li className="flex flex-col gap-1.5 border-t border-border px-4 py-3 first:border-t-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3">
        <span className="min-w-0">
          <b className="font-mono text-sm font-semibold">{check.name}</b>
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {check.command}
          </span>
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDuration(check.durationMs)}
        </span>
        <StatusText icon={status.icon} tone={status.tone}>
          {status.word}
        </StatusText>
      </div>
      {bad && check.output ? (
        <details open className="group">
          <summary className="cursor-pointer text-xs text-foreground-2 hover:text-foreground">
            Output tail{check.truncated ? ', shortened' : ''}
          </summary>
          <pre
            tabIndex={0}
            className="m-0 mt-1.5 max-h-[220px] overflow-auto rounded-md border border-border bg-sidebar px-3 py-2 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-foreground-2"
          >
            {check.output}
          </pre>
        </details>
      ) : null}
    </li>
  )
}

function Checks({ run }: { run: FixRun }) {
  const result = run.result
  const prChecks =
    run.state === 'checks_failing'
      ? 'Failing on the pull request.'
      : run.state === 'checks_passing'
        ? 'Passing on the pull request.'
        : run.state === 'checks_pending'
          ? 'Running on the pull request.'
          : run.state === 'checks_none'
            ? 'The repo reported no checks on the pull request.'
            : null
  if (run.kind === 'majors') {
    return (
      <p className="text-sm text-foreground-2">
        The runner runs no checks for a majors run: the draft pull request&apos;s own CI does.
        {prChecks ? ` ${prChecks}` : ''}
      </p>
    )
  }
  if (!result) {
    return (
      <p className="text-sm text-muted-foreground">
        {prChecks ?? 'Check results arrive when the workflow run finishes.'}
      </p>
    )
  }
  const install: FixCheckResult = {
    name: 'install',
    command: `${result.packageManager} install`,
    status:
      result.install.status === 'ok'
        ? 'passed'
        : result.install.status === 'failed'
          ? 'failed'
          : 'skipped',
    durationMs: result.install.durationMs,
    output: result.install.output,
    truncated: result.install.truncated,
  }
  const checks = orderedChecks([install, ...result.checks])
  const failed = checks.filter((c) => c.status === 'failed' || c.status === 'timeout').length
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm text-foreground-2">
        {result.checksMode === 'install'
          ? "Install only in the runner (private repo); the repo's own CI runs the checks."
          : failed
            ? `${plural(failed, 'check')} failed in the runner, listed first.`
            : 'Every check passed in the runner.'}
        {prChecks ? ` ${prChecks}` : ''}
      </p>
      <ul
        aria-label="Runner checks"
        className="m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0"
      >
        {checks.map((check) => (
          <CheckRow key={check.name} check={check} />
        ))}
      </ul>
    </div>
  )
}

function StepResults({ result, majors }: { result: FixResultV1; majors: boolean }) {
  const applied = result.steps.filter((s) => s.status === 'applied').length
  const tooNew = new Map(result.releaseAge.map((r) => [r.stepId, r]))
  return (
    <Section
      title={majors ? 'Major upgrades' : 'Steps'}
      description={`${applied} of ${result.steps.length} ${majors ? 'changed by the agent' : 'applied'}${result.patch ? `, ${plural(result.patch.files.length, 'file')} changed (${result.patch.insertions} lines added, ${result.patch.deletions} removed)` : ''}`}
    >
      <ul className="m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0">
        {result.steps.map((step) => {
          const name = parseStepId(step.id)
          const age = tooNew.get(step.id)
          const why =
            step.reason === 'too_new' && age?.eligibleAt
              ? `Inside the ${age.gateDays} day release age gate until ${formatRelative(age.eligibleAt)}`
              : step.reason
                ? (STEP_REASON_LABEL[step.reason] ?? step.reason)
                : null
          return (
            <li
              key={step.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-border px-4 py-2.5 first:border-t-0"
            >
              <span className="min-w-0 truncate font-mono text-sm">
                {name ? (
                  <>
                    {name.packageName} <span aria-label="to">→</span>{' '}
                    <b className="font-semibold text-success">{name.to}</b>
                  </>
                ) : (
                  step.id
                )}
              </span>
              <Badge
                variant={
                  step.status === 'applied'
                    ? 'success'
                    : step.status === 'failed'
                      ? 'critical'
                      : 'default'
                }
              >
                {step.status === 'applied'
                  ? 'Applied'
                  : step.status === 'failed'
                    ? 'Failed'
                    : 'Skipped'}
              </Badge>
              {why || step.detail ? (
                <span className="col-span-2 text-xs text-muted-foreground">
                  {[why, step.detail].filter(Boolean).join('. ')}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** States GitHub polling leaves to the deploy link and the rescan. */
const WAITS_FOR_RESCAN: readonly FixRun['state'][] = ['deployed', 'nothing_to_do']

function Tracking({ run }: { run: FixRunDetail }) {
  const t = run.tracking
  if (!t) {
    return (
      <p className="text-sm text-muted-foreground">
        {run.terminal
          ? 'Not polled any more: the run has ended.'
          : run.state === 'merged'
            ? 'Not polled on GitHub: it waits for a deploy of the merge commit, then a rescan of the repo.'
            : WAITS_FOR_RESCAN.includes(run.state)
              ? 'Not polled on GitHub: it waits for a rescan of the repo.'
              : 'The tracker has not looked at this run since the server started. It does on its next tick.'}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2.5">
      <KeyValues
        items={[
          {
            label: 'Last poll',
            value: t.lastPolledAt ? formatRelative(t.lastPolledAt) : 'Not yet',
          },
          {
            label: 'Next poll',
            value: t.nextPollAt ? formatRelative(t.nextPollAt) : 'Not polled, waits for an event',
          },
          ...(t.pausedUntil
            ? [{ label: 'Paused until', value: formatRelative(t.pausedUntil) }]
            : []),
        ]}
      />
      {t.lastError ? (
        <p role="status" className="text-sm text-sev-critical">
          Last error: {t.lastError}
        </p>
      ) : null}
      {t.pausedUntil ? (
        <p className="text-xs text-muted-foreground">
          Polling waits for GitHub&apos;s rate limit window to reset.
        </p>
      ) : null}
    </div>
  )
}

/** One fix run: where it is, its pull request and checks, failures first, and its tracking. */
export function RunPane({
  run: listed,
  repo,
  focused,
}: {
  run: FixRun
  repo: RepoRef
  focused: boolean
}) {
  const query = useQuery(fixRunQuery(listed.id))
  const run: FixRunDetail = query.data ?? {
    ...listed,
    tracking: null,
    deployments: [],
    warnings: [],
    verification: null,
  }
  const info = RUN_STATE_INFO[run.state]
  const actionsUrl = run.github
    ? `https://github.com/${repo.fullName}/actions/runs/${run.github.runId}`
    : null
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
          <Badge variant="accent">
            <IconRobot aria-hidden="true" />
            {run.kind === 'majors' ? 'Majors run' : 'Fix run'}
          </Badge>
          <span>
            Run {run.id}, started {formatRelative(run.at.created)}
          </span>
          <RunStateText run={run} />
        </div>
        <h1 className={focused ? 'text-lg tab:text-xl' : 'text-lg'}>
          {info.label} on <span className="font-mono">{repo.fullName}</span>
        </h1>
        <p className="max-w-[68ch] text-foreground-2">{runNext(run)}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {run.pr ? (
            <Button asChild>
              <a href={run.pr.url} target="_blank" rel="noreferrer noopener">
                <IconGitPullRequest aria-hidden="true" />
                Open PR #{run.pr.number}
                {run.pr.draft ? ', draft' : ''}
              </a>
            </Button>
          ) : null}
          {actionsUrl ? (
            <Button asChild variant="outline">
              <a href={actionsUrl} target="_blank" rel="noreferrer noopener">
                <IconBrandGithub aria-hidden="true" />
                Workflow run
              </a>
            </Button>
          ) : null}
          {run.terminal ? (
            <FixWithHinomi repos={[{ id: repo.id, fullName: repo.fullName }]} size="default" hint />
          ) : null}
          <Button asChild variant="ghost">
            <Link to="/fix-runs" search={{ sel: planKey(repo.id) }}>
              Plan and runner
            </Link>
          </Button>
        </div>
      </div>

      {run.verification?.status === 'done' && run.state === 'not_cleared' ? null : (
        <StateCallout run={run} />
      )}
      {run.warnings.length ? (
        <RunWarnings warnings={run.warnings} deployments={run.deployments} />
      ) : null}
      {run.verification ? <RunVerification verification={run.verification} /> : null}

      <div className={cn('grid items-start gap-[26px]', focused && 'desk:grid-cols-2')}>
        <Section title="Timeline">
          <Panel>
            <PanelBody>
              <RunTimeline steps={runTimeline(run)} />
            </PanelBody>
          </Panel>
        </Section>
        <div className="flex flex-col gap-[26px]">
          <Section title="Checks">
            <Checks run={run} />
          </Section>
          {run.deployments.length ? <RunDeployments deployments={run.deployments} /> : null}
        </div>
      </div>

      {run.kind === 'majors' ? <RunAgent run={run} /> : null}

      {run.result ? <StepResults result={run.result} majors={run.kind === 'majors'} /> : null}

      <div className="grid items-start gap-4 desk:grid-cols-2">
        <Panel>
          <PanelHeader title="Tracking" />
          <PanelBody>
            <Tracking run={run} />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Run" />
          <PanelBody>
            <KeyValues
              items={[
                { label: 'Branch', value: run.branch, mono: true },
                { label: 'Head commit', value: run.headSha?.slice(0, 7) ?? 'Not yet', mono: true },
                {
                  label: 'Workflow run',
                  value: run.github
                    ? `${run.github.runId}${run.github.runAttempt && run.github.runAttempt > 1 ? `, attempt ${run.github.runAttempt}` : ''}`
                    : 'Not known yet',
                  mono: true,
                },
                { label: 'Plan', value: `Scan ${run.plan.scanRunId}` },
                {
                  label: 'Checks in the runner',
                  value:
                    run.kind === 'majors'
                      ? "None, the draft PR's CI"
                      : run.checksMode === 'full'
                        ? 'Install and checks'
                        : 'Install only',
                },
                { label: 'Correlation id', value: run.correlationId, mono: true },
              ]}
            />
          </PanelBody>
        </Panel>
      </div>
    </>
  )
}
