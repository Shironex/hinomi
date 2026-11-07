import { useState } from 'react'
import type {
  DispatchFixRunResponse,
  FixPlan,
  FixRunPreviousPr,
  RunnerStatus,
} from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconGitPullRequestClosed,
  IconKey,
  IconLoader2,
  IconRobot,
  IconSettings2,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useFixRequest } from '@/hooks/use-fix-request'
import { describeError } from '@/lib/errors'
import {
  dispatchFixRun,
  planQuery,
  refreshAfterDispatch,
  runnerQuery,
  type DispatchOutcome,
} from '@/lib/fix-api'
import { MAJORS_BRANCH_NAME, planKey, previewPlan, type PlanPreview } from '@/lib/fix-run-meta'
import { closeFix, type FixRequest } from '@/lib/fix-request'
import { PlanDiff } from './plan-diff'

const number = new Intl.NumberFormat('en-US')
const plural = (n: number, word: string) => `${number.format(n)} ${word}${n === 1 ? '' : 's'}`

/** Where the finding the request came from sits in the plan. */
function findingNote(plan: FixPlan, preview: PlanPreview, findingId: number): string {
  const sent = preview.sent.find((s) => s.findingIds.includes(findingId))
  if (sent) return `This finding is cleared by step ${sent.order}, ${sent.packageName} ${sent.to}.`
  const risky = preview.risky.find((s) => s.findingIds.includes(findingId))
  if (risky) {
    return `This finding needs ${risky.packageName} ${risky.to}, a risky step that the fix PR lists but does not apply.`
  }
  if (plan.unfixed.some((u) => u.findingIds.includes(findingId))) {
    return 'This finding has no patched version yet, so the plan cannot clear it.'
  }
  return 'This finding is not in the latest plan. The next scan adds it.'
}

function checksLine(runner: RunnerStatus | undefined): string {
  if (!runner?.github) return 'GitHub decides the checks mode when the run starts.'
  return runner.github.checksMode === 'full'
    ? 'Public repo: the runner installs and runs the checks before it pushes.'
    : "Private repo: the runner only installs; the repo's own CI runs the checks on the PR."
}

/** The repo choice when the request covers more than one repo (a fix across repos). */
function RepoChoice({
  request,
  value,
  onChange,
}: {
  request: FixRequest
  value: number
  onChange: (id: number) => void
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">Repo to fix</legend>
      {request.repos.map((repo) => (
        <label
          key={repo.id}
          className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm has-checked:border-input has-checked:bg-muted"
        >
          <input
            type="radio"
            name="fix-repo"
            value={repo.id}
            checked={value === repo.id}
            onChange={() => onChange(repo.id)}
            className="size-4 accent-(--primary)"
          />
          <span className="min-w-0 flex-1 truncate font-mono">{repo.fullName}</span>
          {repo.findings !== undefined ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {plural(repo.findings, 'finding')}
            </span>
          ) : null}
        </label>
      ))}
    </fieldset>
  )
}

/** The majors agent is on for the repo (the setting is absent on an older server: off). */
const agentOn = (runner: RunnerStatus | undefined) =>
  (runner?.settings.majorsAgent ?? 'off') !== 'off'

function PlanSummary({
  plan,
  preview,
  majors,
}: {
  plan: FixPlan
  preview: PlanPreview
  /** Major upgrades the agent takes into a draft PR of its own; 0 when the agent is off. */
  majors: number
}) {
  // Major upgrades the agent takes are not "left out": they get a draft PR of their own.
  const held =
    preview.risky.length - (majors > 0 ? preview.majors.length : 0) + preview.notSent.length
  return (
    <p className="text-sm text-foreground-2">
      {preview.sent.length === 0
        ? 'The latest plan has no safe step the runner can apply.'
        : `${plural(preview.sent.length, 'safe step')} ${preview.sent.length === 1 ? 'clears' : 'clear'} ${number.format(preview.findings)} of ${plural(plan.summary.findings.total, 'open finding')} in one pull request on branch hinomi/fix-plan.`}
      {held > 0
        ? ` ${plural(held, 'other step')} ${held === 1 ? 'is' : 'are'} listed in the PR body but not applied.`
        : ''}
      {majors > 0
        ? ` The majors agent takes ${plural(majors, 'major upgrade')} into ${preview.sent.length > 0 ? 'a second' : 'one'} draft pull request on branch ${MAJORS_BRANCH_NAME}.`
        : ''}{' '}
      Hinomi never merges.
    </p>
  )
}

/** After a dispatch that made two runs: both, so neither is missed. */
function Dispatched({ response }: { response: DispatchFixRunResponse }) {
  const runs = [response.run, response.majorsRun].filter((r) => r != null)
  return (
    <Callout icon={IconCircleCheck} variant="ok" title="Two runs dispatched">
      <p className="m-0">
        The fix run goes first and the majors run waits behind it in the same workflow.
      </p>
      <ul aria-label="Dispatched runs" className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              to="/fix-runs"
              search={{ sel: run.id }}
              onClick={() => closeFix()}
              className="text-accent-ink hover:underline"
            >
              {run.kind === 'majors' ? 'Majors run' : 'Fix run'} {run.id}
            </Link>
          </li>
        ))}
      </ul>
    </Callout>
  )
}

function DialogBody({ request }: { request: FixRequest }) {
  const first = request.repos[0]
  const [repoId, setRepoId] = useState(first?.id ?? 0)
  const [previous, setPrevious] = useState<FixRunPreviousPr | null>(null)
  const [dispatched, setDispatched] = useState<DispatchFixRunResponse | null>(null)
  const plan = useQuery({ ...planQuery(repoId), enabled: repoId > 0 })
  const runner = useQuery({ ...runnerQuery(repoId), enabled: repoId > 0 })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const repo = request.repos.find((r) => r.id === repoId) ?? first
  const closed = previous ?? runner.data?.closedUnmerged ?? null

  const mutation = useMutation({
    mutationFn: (confirmReopen: boolean): Promise<DispatchOutcome> =>
      dispatchFixRun(repoId, confirmReopen),
    onSuccess: async (outcome) => {
      if (outcome.kind === 'reopen') {
        setPrevious(outcome.previous)
        return
      }
      await refreshAfterDispatch(queryClient, repoId)
      if (outcome.response.majorsRun) {
        setDispatched(outcome.response)
        return
      }
      closeFix()
      void navigate({ to: '/fix-runs', search: { sel: outcome.response.run.id } })
    },
  })

  const preview = plan.data ? previewPlan(plan.data) : null
  const notReady = runner.data && !runner.data.ready
  const majors = agentOn(runner.data) && preview ? preview.majors.length : 0
  const noSecret = majors > 0 && runner.data?.caller.passesAgentSecret === false
  const canDispatch =
    preview !== null &&
    (preview.sent.length > 0 || majors > 0) &&
    !notReady &&
    !mutation.isPending &&
    !dispatched

  const changeRepo = (id: number) => {
    setRepoId(id)
    setPrevious(null)
    mutation.reset()
  }

  return (
    <>
      <DialogHeader>
        <IconRobot aria-hidden="true" className="size-4 text-accent-ink" stroke={1.75} />
        <DialogTitle>Fix with Hinomi</DialogTitle>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <DialogDescription className="text-sm text-foreground-2">
          Runs the latest fix plan of{' '}
          <span className="font-mono text-foreground">{repo?.fullName}</span> in its own GitHub
          Actions and{' '}
          {preview && preview.sent.length === 0 && majors > 0
            ? 'hands its major upgrades to the agent.'
            : 'opens one pull request with every safe step.'}
        </DialogDescription>
        {request.repos.length > 1 ? (
          <RepoChoice request={request} value={repoId} onChange={changeRepo} />
        ) : null}
        {plan.error ? (
          <Callout icon={IconAlertTriangle} variant="warn" title="No plan to run">
            {describeError(plan.error)}
          </Callout>
        ) : !plan.data || !preview ? (
          <div aria-label="Loading the plan" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            <PlanSummary plan={plan.data} preview={preview} majors={majors} />
            {request.findingId !== undefined ? (
              <p className="text-sm text-foreground-2">
                {findingNote(plan.data, preview, request.findingId)}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{checksLine(runner.data)}</p>
            {noSecret ? (
              <Callout icon={IconKey} variant="warn" title="The majors run cannot start">
                The caller workflow passes no <span className="font-mono">ANTHROPIC_API_KEY</span>,
                so the agent fails. The fix run is not affected.{' '}
                <Link
                  to="/fix-runs"
                  search={{ sel: planKey(repoId) }}
                  onClick={() => closeFix()}
                  className="text-accent-ink hover:underline"
                >
                  Fix the caller workflow
                </Link>
              </Callout>
            ) : null}
            {closed ? (
              <Callout
                icon={IconGitPullRequestClosed}
                variant="warn"
                title={`The last Hinomi PR #${closed.pr.number} was closed without merging`}
              >
                It was the fix PR or the majors draft PR. Hinomi never reopens it on its own.
                Dispatching now opens a fresh pull request that says it replaces{' '}
                <a
                  href={closed.pr.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent-ink hover:underline"
                >
                  #{closed.pr.number}
                </a>
                .
              </Callout>
            ) : null}
            {notReady ? (
              <Callout icon={IconSettings2} variant="warn" title="The runner is not ready">
                {runner.data.message}{' '}
                <Link
                  to="/fix-runs"
                  search={{ sel: planKey(repoId) }}
                  onClick={() => closeFix()}
                  className="text-accent-ink hover:underline"
                >
                  Set up the runner
                </Link>
              </Callout>
            ) : null}
            {dispatched ? <Dispatched response={dispatched} /> : null}
            <section aria-labelledby="fix-dialog-diff" className="flex flex-col gap-2">
              <h3 id="fix-dialog-diff" className="text-sm font-semibold">
                What changes
              </h3>
              <PlanDiff files={preview.files} />
            </section>
          </>
        )}
        {mutation.error ? (
          <p role="alert" className="text-sm text-sev-critical">
            {describeError(mutation.error)}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Link
          to="/fix-runs"
          search={{ sel: planKey(repoId) }}
          onClick={() => closeFix()}
          className="mr-auto text-sm text-accent-ink hover:underline"
        >
          Open the whole plan
        </Link>
        <Button
          variant="outline"
          onClick={() => closeFix()}
          disabled={mutation.isPending}
          autoFocus
        >
          {dispatched ? 'Close' : 'Cancel'}
        </Button>
        <Button disabled={!canDispatch} onClick={() => mutation.mutate(closed !== null)}>
          {mutation.isPending ? (
            <IconLoader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <IconRobot aria-hidden="true" />
          )}
          {closed
            ? 'Open a fresh PR'
            : preview && preview.sent.length === 0 && majors > 0
              ? 'Dispatch the majors agent'
              : 'Dispatch the fix'}
        </Button>
      </div>
    </>
  )
}

/** The one "Fix with Hinomi" dialog, mounted by the shell and opened through requestFix. */
export function FixDialog() {
  const request = useFixRequest()
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && closeFix()}>
      <DialogContent className="flex w-[min(640px,calc(100%-32px))] flex-col overflow-hidden">
        {request ? <DialogBody key={request.n} request={request} /> : null}
      </DialogContent>
    </Dialog>
  )
}
