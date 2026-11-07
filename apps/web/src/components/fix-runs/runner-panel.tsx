import { useEffect, useState } from 'react'
import {
  callerWorkflowSchema,
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
  IconLoader2,
} from '@tabler/icons-react'
import { Field } from '@/components/form/field'
import { StatusText } from '@/components/findings/finding-state'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { KeyValues, Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import { describeError } from '@/lib/errors'
import { fixKeys, runnerQuery, updateRunner } from '@/lib/fix-api'
import { CALLER_STATE_INFO } from '@/lib/fix-run-meta'
import { formatRelative } from '@/lib/format'

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
        release is <span className="font-mono">{short(caller.latestSha)}</span>. Paste the workflow
        below to move to it. Old pins keep working until a release changes the inputs.
      </Callout>
    )
  }
  if (caller.state === 'unpinned') {
    return (
      <Callout icon={IconAlertTriangle} variant="warn" title="Pin it by commit SHA">
        {caller.path} calls Hinomi by <span className="font-mono">{caller.ref}</span>, a tag or
        branch that can move. Paste the workflow below, which pins a full commit SHA.
      </Callout>
    )
  }
  return null
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
  return (
    <Panel>
      <PanelHeader title="GitHub Actions runner" icon={IconBrandGithub}>
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
          aria-label="Run fixes for this repo in GitHub Actions"
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

        <WorkflowForm
          key={status.settings.workflow}
          status={status}
          pending={mutation.isPending}
          onSave={(workflow) => mutation.mutate({ workflow })}
        />

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
          <div className="flex flex-wrap items-center gap-2">
            <CopyTemplate text={status.caller.template} />
            <span className="text-xs text-muted-foreground">
              Paste it as <span className="font-mono">{status.caller.path}</span> on{' '}
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
          <p className="text-xs text-muted-foreground">
            {status.permissions.canOpenSetupPr
              ? 'Your credential can write workflow files. A button that opens this as a setup pull request comes in a later release; until then paste it by hand.'
              : 'Hinomi does not need the Workflows permission: paste the file by hand once per repo.'}
          </p>
        </section>

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
          <ul className="m-0 flex list-none flex-col p-0">
            {status.permissions.items.map((item) => (
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
            {
              label: 'Checks in the runner',
              value: github
                ? github.checksMode === 'full'
                  ? 'Install and every check'
                  : "Install only, the repo's CI checks"
                : 'Unknown',
            },
            { label: 'Checked', value: formatRelative(status.checkedAt) },
          ]}
        />
      </PanelBody>
    </Panel>
  )
}

/** Per repo runner setup: on or off, the caller workflow to paste and its pin, permissions. */
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
        <PanelHeader title="GitHub Actions runner" icon={IconBrandGithub} />
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
