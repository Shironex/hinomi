import { useEffect, useState } from 'react'
import {
  callerWorkflowSchema,
  type FixRunnerKind,
  type RunnerPermission,
  type RunnerStatus,
  type UpdateRunnerSettingsRequest,
} from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconCheck,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconClockHour4,
  IconCopy,
  IconExternalLink,
  IconKey,
  IconLoader2,
  IconRobot,
  IconServer2,
  IconWebhook,
  type Icon,
} from '@tabler/icons-react'
import { Field } from '@/components/form/field'
import { StatusText } from '@/components/findings/finding-state'
import { ErrorState } from '@/components/states/error-state'
import { FineGrainedToken } from '@/components/token/fine-grained-token'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { KeyValues, Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import { describeError } from '@/lib/errors'
import { fixKeys, runnerQuery, updateRunner } from '@/lib/fix-api'
import {
  CALLER_STATE_INFO,
  LOCAL_MAJORS_NOTE,
  MAJORS_BRANCH_NAME,
  MAJORS_DOCS_URL,
  runnerKindOf,
} from '@/lib/fix-run-meta'
import { formatRelative } from '@/lib/format'
import { ownerOf } from '@/lib/github-token-url'
import { RunnerKindPicker } from './runner-kind-picker'
import { SetupPrButton } from './setup-pr-button'

const AUTH_LABEL = {
  github_app: 'GitHub App',
  fine_grained_token: 'Fine grained token',
  classic_token: 'Classic token',
} as const

const PERMISSION_STATUS = {
  granted: { icon: IconCircleCheck, tone: 'ok', word: 'Granted' },
  missing: { icon: IconCircleX, tone: 'bad', word: 'Missing' },
  unverified: { icon: IconCircleDashed, tone: 'neutral', word: 'Not verified' },
} as const

const KIND_ICON: Record<FixRunnerKind, Icon> = {
  github_actions: IconBrandGithub,
  webhook: IconWebhook,
  local: IconServer2,
}

const PANEL_TITLE: Record<FixRunnerKind, string> = {
  github_actions: 'GitHub Actions runner',
  webhook: 'Webhook runner',
  local: 'Local runner',
}

const SWITCH_LABEL: Record<FixRunnerKind, string> = {
  github_actions: 'Run fixes for this repo in GitHub Actions',
  webhook: 'Run fixes for this repo on the webhook runner',
  local: 'Run fixes for this repo on this Hinomi host',
}

/** Permissions only the caller workflow needs: dispatching it and adding it in a setup PR. */
const ACTIONS_ONLY_PERMISSIONS = new Set(['actions', 'workflows', 'workflow'])

const short = (sha: string | null) => (sha && /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha)

function CopyTemplate({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }}
    >
      {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy the workflow'}
    </Button>
  )
}

function WorkflowForm({
  status,
  pending,
  onSave,
}: {
  status: RunnerStatus
  pending: boolean
  onSave: (workflow: string | null) => void
}) {
  const saved = status.settings.workflow
  const [value, setValue] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const branch = status.github?.defaultBranch ?? 'the default branch'
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const parsed = callerWorkflowSchema.safeParse(value.trim())
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Not a workflow file name')
          return
        }
        setError(null)
        onSave(parsed.data === status.defaultWorkflow ? null : parsed.data)
      }}
    >
      <Field
        label="Caller workflow file"
        help={`Under .github/workflows on ${branch}. Hinomi dispatches this file.`}
        error={error}
      >
        {(control) => (
          <span className="flex flex-wrap gap-2">
            <Input
              {...control}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="max-w-[280px] font-mono"
            />
            <Button type="submit" variant="outline" disabled={pending || value.trim() === saved}>
              Save
            </Button>
          </span>
        )}
      </Field>
    </form>
  )
}

function Permission({ item }: { item: RunnerPermission }) {
  const status = PERMISSION_STATUS[item.status]
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-border py-2 first:border-t-0 first:pt-0 last:pb-0">
      <span className="text-sm font-semibold">
        {item.label}
        {item.required ? null : (
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">optional</span>
        )}
      </span>
      <StatusText icon={status.icon} tone={status.tone}>
        {status.word}
      </StatusText>
      <span className="col-span-2 text-xs text-muted-foreground">{item.purpose}</span>
    </li>
  )
}

function CallerPin({ status }: { status: RunnerStatus }) {
  const caller = status.caller
  if (caller.state === 'outdated') {
    return (
      <Callout icon={IconClockHour4} variant="warn" title="Outdated pin">
        {caller.path} pins <span className="font-mono">{short(caller.ref)}</span>; the latest Hinomi
        release is <span className="font-mono">{short(caller.latestSha)}</span>. Open the pin PR or
        paste the workflow below to move to it. Old pins keep working until a release changes the
        inputs.
      </Callout>
    )
  }
  if (caller.state === 'unpinned') {
    return (
      <Callout icon={IconAlertTriangle} variant="warn" title="Pin it by commit SHA">
        {caller.path} calls Hinomi by <span className="font-mono">{caller.ref}</span>, a tag or
        branch that can move. The setup PR or the workflow below pins a full commit SHA.
      </Callout>
    )
  }
  return null
}

/**
 * The optional majors agent: off until turned on, with what it does, what it costs and what the
 * caller workflow must pass for it to run.
 */
function MajorsAgent({
  status,
  repoId,
  pending,
  onChange,
  kind,
}: {
  status: RunnerStatus
  repoId: number
  pending: boolean
  onChange: (on: boolean) => void
  kind: 'github_actions' | 'webhook'
}) {
  const on = (status.settings.majorsAgent ?? 'off') !== 'off'
  const headingId = `majors-${repoId}`
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold">
          <IconRobot aria-hidden="true" className="size-4 text-accent-ink" stroke={1.75} />
          Majors agent
        </h3>
        <span className="flex items-center gap-2">
          <span className="text-sm text-foreground-2">{on ? 'On' : 'Off'}</span>
          <Switch
            checked={on}
            disabled={pending}
            aria-labelledby={headingId}
            aria-describedby={`${headingId}-note`}
            onCheckedChange={onChange}
          />
        </span>
      </div>
      <p id={`${headingId}-note`} className="max-w-[68ch] text-sm text-foreground-2">
        {kind === 'webhook' ? (
          <>
            The webhook runner gets the major upgrades of the plan as a separate run of kind{' '}
            <span className="font-mono">majors</span> on{' '}
            <span className="font-mono">{MAJORS_BRANCH_NAME}</span>, to hand to a coding agent of
            its own. Hinomi opens a <b className="font-semibold">draft</b> pull request from the
            branch, a person reviews it and Hinomi never merges.{' '}
          </>
        ) : (
          <>
            An agent edits your code for the major upgrades of the plan and opens a separate{' '}
            <b className="font-semibold">draft</b> pull request on{' '}
            <span className="font-mono">{MAJORS_BRANCH_NAME}</span>. It needs the caller workflow to
            pass <span className="font-mono">ANTHROPIC_API_KEY</span>, it costs money (each run is
            capped on turns, time and spend) and a person reviews the draft: Hinomi never
            merges.{' '}
          </>
        )}
        <a
          href={MAJORS_DOCS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-accent-ink hover:underline"
        >
          How it works
          <IconExternalLink aria-hidden="true" className="size-3.5" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </p>
      {kind === 'github_actions' && on && status.caller.passesAgentSecret === false ? (
        <Callout icon={IconKey} variant="warn" title="The caller does not pass the agent key">
          The agent cannot run until {status.caller.path} passes{' '}
          <span className="font-mono">ANTHROPIC_API_KEY</span> to Hinomi. Open the setup PR or paste
          the workflow below: both add the secrets lines. Then add the key as a secret of the repo.
        </Callout>
      ) : null}
    </section>
  )
}

function RunnerBody({ status, repoId }: { status: RunnerStatus; repoId: number }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (body: UpdateRunnerSettingsRequest) => updateRunner(repoId, body),
    onSuccess: (next) => queryClient.setQueryData(fixKeys.runner(repoId), next),
  })
  const caller = CALLER_STATE_INFO[status.caller.state]
  const enabled = status.settings.enabled
  const github = status.github
  const saved = runnerKindOf(status)
  const kind = mutation.isPending && mutation.variables?.kind ? mutation.variables.kind : saved
  const actions = kind === 'github_actions'
  return (
    <Panel>
      <PanelHeader title={PANEL_TITLE[kind]} icon={KIND_ICON[kind]}>
        {mutation.isPending ? (
          <IconLoader2
            aria-label="Saving"
            className="size-4 text-muted-foreground motion-safe:animate-spin"
          />
        ) : null}
        <span className="text-sm text-foreground-2">{enabled ? 'On' : 'Off'}</span>
        <Switch
          checked={enabled}
          disabled={mutation.isPending}
          aria-label={SWITCH_LABEL[kind]}
          onCheckedChange={(next) => mutation.mutate({ enabled: next })}
        />
      </PanelHeader>
      <PanelBody className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          {status.ready ? (
            <StatusText icon={IconCircleCheck} tone="ok">
              Ready to dispatch
            </StatusText>
          ) : (
            <StatusText icon={IconAlertTriangle} tone="wait">
              Not ready
            </StatusText>
          )}
          {status.ready ? null : <p className="text-sm text-foreground-2">{status.message}</p>}
          {mutation.error ? (
            <p role="alert" className="text-sm text-sev-critical">
              {describeError(mutation.error)}
            </p>
          ) : null}
        </div>

        <RunnerKindPicker
          status={status}
          value={kind}
          disabled={mutation.isPending}
          onChange={(next) => mutation.mutate({ kind: next })}
        />

        {actions ? (
          <WorkflowForm
            key={status.settings.workflow}
            status={status}
            pending={mutation.isPending}
            onSave={(workflow) => mutation.mutate({ workflow })}
          />
        ) : null}

        {kind === 'local' ? (
          <Callout icon={IconRobot} title="No majors agent on this runner">
            {LOCAL_MAJORS_NOTE}
          </Callout>
        ) : (
          <MajorsAgent
            status={status}
            repoId={repoId}
            pending={mutation.isPending}
            kind={kind}
            onChange={(on) => mutation.mutate({ majorsAgent: on ? 'claude-code' : 'off' })}
          />
        )}

        {actions ? (
          <section aria-labelledby={`caller-${repoId}`} className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 id={`caller-${repoId}`} className="text-sm font-semibold">
                Caller workflow
              </h3>
              <StatusText icon={caller.icon} tone={caller.tone}>
                {caller.label}
              </StatusText>
            </div>
            <p className="text-sm text-foreground-2">{status.caller.message}</p>
            {status.caller.missingInputs.length ? (
              <p className="text-sm text-foreground-2">
                Missing inputs:{' '}
                <span className="font-mono">{status.caller.missingInputs.join(', ')}</span>
              </p>
            ) : null}
            <CallerPin status={status} />
            <SetupPrButton status={status} repoId={repoId} />
            <div className="flex flex-wrap items-center gap-2">
              <CopyTemplate text={status.caller.template} />
              <span className="text-xs text-muted-foreground">
                Or paste it as <span className="font-mono">{status.caller.path}</span> on{' '}
                {github?.defaultBranch ?? 'the default branch'} and commit.
              </span>
            </div>
            <pre
              aria-label="Caller workflow to paste"
              tabIndex={0}
              className="m-0 max-h-[260px] overflow-auto rounded-md border border-border bg-sidebar px-3 py-2.5 font-mono text-xs leading-[1.6] text-foreground-2"
            >
              {status.caller.template}
            </pre>
          </section>
        ) : null}

        <section aria-labelledby={`perms-${repoId}`} className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 id={`perms-${repoId}`} className="text-sm font-semibold">
              Permissions
            </h3>
            <span className="text-xs text-muted-foreground">
              {status.permissions.auth ? AUTH_LABEL[status.permissions.auth] : 'No GitHub source'}
            </span>
          </div>
          {status.permissions.ok ? null : (
            <p className="text-sm text-foreground-2">{status.permissions.message}</p>
          )}
          {!status.permissions.ok &&
          status.permissions.auth &&
          status.permissions.auth !== 'github_app' ? (
            <FineGrainedToken
              preset="runner"
              owner={ownerOf(github?.fullName)}
              label="Create a token for the runner"
              intro="Opens GitHub with the runner permissions below ticked. Paste the new token in Settings, Sources."
            />
          ) : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {status.permissions.items
              .filter((item) => actions || !ACTIONS_ONLY_PERMISSIONS.has(item.name))
              .map((item) => (
                <Permission key={item.name} item={item} />
              ))}
          </ul>
        </section>

        <KeyValues
          items={[
            {
              label: 'Repo on GitHub',
              value: github ? `${github.fullName}, ${github.visibility}` : 'Could not be read',
            },
            ...(kind === 'local'
              ? []
              : [
                  {
                    label: 'Checks in the runner',
                    value: github
                      ? github.checksMode === 'full'
                        ? 'Install and every check'
                        : "Install only, the repo's CI checks"
                      : 'Unknown',
                  },
                ]),
            { label: 'Checked', value: formatRelative(status.checkedAt) },
          ]}
        />
      </PanelBody>
    </Panel>
  )
}

/** Per repo runner setup: where plans run, on or off, the caller workflow and its pin, permissions. */
export function RunnerPanel({ repoId }: { repoId: number }) {
  const query = useQuery(runnerQuery(repoId))
  if (query.error) {
    return (
      <ErrorState
        title="The runner status did not load"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (!query.data) {
    return (
      <Panel>
        <PanelHeader title="Fix runner" icon={IconBrandGithub} />
        <PanelBody className="flex flex-col gap-2.5" role="status" aria-label="Reading GitHub">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-20 w-full" />
        </PanelBody>
      </Panel>
    )
  }
  return <RunnerBody status={query.data} repoId={repoId} />
}
