import type * as React from 'react'
import { useState } from 'react'
import type { SourceDto, SourceTestResult } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconCheck,
  IconDatabase,
  IconBrandGithub,
  IconLoader2,
  IconPlugConnected,
  IconPlus,
  IconServer2,
  IconTrash,
  type Icon,
} from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field } from '@/components/form/field'
import { SegmentedChoice, type SegmentedOption } from '@/components/form/segmented-choice'
import { GithubTokenHelp } from '@/components/onboarding/github-token-help'
import { SecretKeyCallout } from '@/components/sources/secret-key-callout'
import { SourceConnectForm, type ConnectableKind } from '@/components/sources/source-connect-form'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useOsvSetting } from '@/hooks/use-osv-setting'
import { describeError } from '@/lib/errors'
import { fixKeys } from '@/lib/fix-api'
import { formatRelative, plural } from '@/lib/format'
import { queryKeys } from '@/lib/queries'
import {
  removeSource,
  settingsKeys,
  sourcesQuery,
  testSavedSource,
  updateSource,
} from '@/lib/settings-api'
import { cn } from '@/lib/utils'
import { Panel, SaveStatus, SetBox, SetRow } from './settings-section'

const KIND_META: Record<ConnectableKind, { label: string; icon: Icon; empty: string }> = {
  coolify: {
    label: 'Coolify',
    icon: IconServer2,
    empty: 'Deployments, domains and servers. Without it nothing is ranked as deployed.',
  },
  github: {
    label: 'GitHub',
    icon: IconBrandGithub,
    empty: 'Repos and their Dependabot alerts, with a token or a GitHub App.',
  },
}

const KIND_OPTIONS: readonly SegmentedOption<ConnectableKind>[] = [
  { value: 'github', label: KIND_META.github.label, icon: KIND_META.github.icon },
  { value: 'coolify', label: KIND_META.coolify.label, icon: KIND_META.coolify.icon },
]

export function SourcesSection() {
  const queryClient = useQueryClient()
  const sources = useQuery(sourcesQuery)
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState<string | null>(null)

  if (sources.isPending) return <SourcesSkeleton />
  if (sources.isError) {
    return (
      <ErrorState
        title="Sources did not load"
        error={sources.error}
        onRetry={() => void sources.refetch()}
      />
    )
  }

  const { canStoreTokens } = sources.data
  return (
    <>
      {canStoreTokens ? null : (
        <SecretKeyCallout
          onRecheck={() => void queryClient.invalidateQueries({ queryKey: settingsKeys.sources })}
          rechecking={sources.isFetching}
        />
      )}
      <SetBox as="ul" aria-label="Sources">
        {(['coolify', 'github'] as const).map((kind) => {
          const list = sources.data.sources.filter((s) => s.kind === kind)
          if (list.length === 0) {
            return <MissingSource key={kind} kind={kind} canStoreTokens={canStoreTokens} />
          }
          return list.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              kind={kind}
              canStoreTokens={canStoreTokens}
            />
          ))
        })}
        <OsvRow />
      </SetBox>
      {adding ? (
        <AddSource
          onCancel={() => setAdding(false)}
          onAdded={(message) => {
            setAdding(false)
            setAdded(message)
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setAdded(null)
              setAdding(true)
            }}
            disabled={!canStoreTokens}
          >
            <IconPlus aria-hidden="true" />
            Add source
          </Button>
          <span aria-live="polite" className="text-sm text-success">
            {added}
          </span>
        </div>
      )}
    </>
  )
}

/**
 * Another GitHub source (a token or a GitHub App, say one per organization) or another Coolify
 * instance, with the same forms as onboarding. Names are unique per kind, so a name can be typed.
 */
function AddSource({
  onCancel,
  onAdded,
}: {
  onCancel: () => void
  onAdded: (message: string) => void
}) {
  const [kind, setKind] = useState<ConnectableKind>('github')
  const [name, setName] = useState('')
  return (
    <Panel role="group" aria-labelledby="add-source-title">
      <h3 id="add-source-title" className="text-md">
        Add a source
      </h3>
      <SegmentedChoice legend="Source" options={KIND_OPTIONS} value={kind} onChange={setKind} />
      <Field
        label="Name"
        help={
          kind === 'github'
            ? 'Optional. Tells GitHub sources apart, for example by the organization it reads. Defaults to the account or GitHub.'
            : 'Optional. Defaults to the host of the instance URL.'
        }
        className="max-w-[360px]"
      >
        {(control) => (
          <Input
            {...control}
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <SourceConnectForm
        key={kind}
        kind={kind}
        name={name}
        guide={<GithubTokenHelp />}
        onCancel={onCancel}
        onConnected={({ source, test }) => onAdded(`${source.name} added. ${test.message}.`)}
      />
    </Panel>
  )
}

type Health = { label: string; tone: 'ok' | 'error' | 'neutral' | 'missing' }

function healthOf(source: SourceDto): Health {
  if (!source.enabled) return { label: 'Paused', tone: 'neutral' }
  if (!source.hasToken) return { label: 'No token', tone: 'missing' }
  const ok = source.lastOkAt ? Date.parse(source.lastOkAt) : 0
  const failed = source.lastErrorAt ? Date.parse(source.lastErrorAt) : 0
  if (failed > ok) return { label: 'Sync failed', tone: 'error' }
  if (source.lastOkAt) return { label: `Synced ${formatRelative(source.lastOkAt)}`, tone: 'ok' }
  return { label: 'Not synced yet', tone: 'neutral' }
}

/** A failed sync is a connection problem, not a severity, so it is amber rather than red. */
function HealthPill({ health }: { health: Health }) {
  if (health.tone === 'ok') {
    return (
      <Badge variant="success">
        <IconCheck aria-hidden="true" />
        {health.label}
      </Badge>
    )
  }
  if (health.tone === 'error' || health.tone === 'missing') {
    return (
      <Badge variant="outline" className="border-transparent bg-wait-soft text-wait">
        <IconAlertTriangle aria-hidden="true" />
        {health.label}
      </Badge>
    )
  }
  return <Badge variant="outline">{health.label}</Badge>
}

function SourceRow({
  source,
  kind,
  canStoreTokens,
}: {
  source: SourceDto
  kind: ConnectableKind
  canStoreTokens: boolean
}) {
  const queryClient = useQueryClient()
  const meta = KIND_META[kind]
  const health = healthOf(source)
  const [replacing, setReplacing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [replacedMessage, setReplacedMessage] = useState<string | null>(null)

  // Switching a GitHub source off or removing it moves its repos to another source.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsKeys.sources }),
      queryClient.invalidateQueries({ queryKey: queryKeys.scanStatus }),
      queryClient.invalidateQueries({ queryKey: settingsKeys.repos }),
      queryClient.invalidateQueries({ queryKey: fixKeys.runners }),
    ])

  const test = useMutation({ mutationFn: () => testSavedSource(source.id) })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateSource(source.id, { enabled }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => removeSource(source.id),
    onSuccess: async () => {
      setConfirming(false)
      await refresh()
    },
  })

  const enabled = toggle.isPending ? (toggle.variables ?? source.enabled) : source.enabled
  const lastErrorIsCurrent = health.tone === 'error' && source.lastError
  const isApp = source.auth === 'github_app'
  const how = isApp
    ? 'GitHub App'
    : kind === 'coolify'
      ? 'read only API token'
      : 'personal access token'

  return (
    <SetRow
      as="li"
      icon={<meta.icon stroke={1.75} />}
      title={source.name}
      sub={`${meta.label}, ${how}`}
      aside={<HealthPill health={health} />}
      stackAside
    >
      {lastErrorIsCurrent ? (
        <p className="rounded-md bg-wait-soft px-3 py-2 text-sm text-foreground-2">
          <b className="font-semibold text-wait">Last sync failed: </b>
          {source.lastError}
          {source.lastErrorAt ? ` (${formatRelative(source.lastErrorAt)})` : null}
        </p>
      ) : null}
      <dl className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
        <Fact term="URL">
          <span className="truncate font-mono text-xs">
            {source.baseUrl ?? (kind === 'github' ? 'github.com' : 'Not set')}
          </span>
        </Fact>
        {isApp ? (
          <Fact term="Signs in as">
            <span className="truncate font-mono text-xs">
              App {source.appId}, installation {source.installationId}
            </span>
          </Fact>
        ) : null}
        <Fact term={kind === 'coolify' ? 'Reports' : 'Reads'}>
          {kind === 'coolify'
            ? plural(source.deploymentCount, 'deployment')
            : plural(source.repoCount, 'repo')}
        </Fact>
        <Fact term={isApp ? 'Private key' : 'Token'}>
          {source.hasToken ? (
            <Badge variant="outline">
              <IconCheck aria-hidden="true" />
              Set
            </Badge>
          ) : (
            <Badge variant="outline" className="border-transparent bg-wait-soft text-wait">
              Not set
            </Badge>
          )}
          <span className="sr-only">. Secrets are never shown again.</span>
        </Fact>
      </dl>

      {replacing ? (
        <div className="border-t border-border pt-3.5">
          <SourceConnectForm
            kind={kind}
            source={source}
            onCancel={() => setReplacing(false)}
            onConnected={({ source: saved, test: result }) => {
              setReplacing(false)
              const what = saved.auth === 'github_app' ? 'GitHub App saved' : 'Token replaced'
              setReplacedMessage(`${what}. ${result.message}.`)
            }}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setReplacedMessage(null)
                test.mutate()
              }}
              disabled={test.isPending || !source.hasToken}
            >
              {test.isPending ? (
                <IconLoader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <IconPlugConnected aria-hidden="true" />
              )}
              {test.isPending ? 'Testing' : 'Test connection'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                test.reset()
                setReplacedMessage(null)
                setReplacing(true)
              }}
              disabled={!canStoreTokens}
            >
              {isApp ? 'Replace credentials' : 'Replace token'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              <IconTrash aria-hidden="true" />
              Remove
            </Button>
            <label className="ml-auto flex items-center gap-2 text-xs text-foreground-2">
              <span id={`src-${source.id}-on`}>Include in scans</span>
              <Switch
                aria-labelledby={`src-${source.id}-on`}
                checked={enabled}
                disabled={toggle.isPending}
                onCheckedChange={(next) => toggle.mutate(next)}
              />
            </label>
          </div>
          <TestOutcome
            pending={test.isPending}
            result={test.data}
            error={test.error ?? toggle.error}
            note={replacedMessage}
          />
        </>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          if (!open) remove.reset()
        }}
        title={`Remove ${source.name}?`}
        confirmLabel="Remove source"
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        error={remove.error ? describeError(remove.error) : null}
      >
        {removeNote(source, kind)}
      </ConfirmDialog>
    </SetRow>
  )
}

/** What removing a source does to what it brought in. */
function removeNote(source: SourceDto, kind: ConnectableKind): string {
  const secret = source.auth === 'github_app' ? 'its private key' : 'its token'
  if (kind === 'coolify') {
    return source.deploymentCount > 0
      ? `Hinomi forgets ${secret} and its ${plural(source.deploymentCount, 'deployment')} ${source.deploymentCount === 1 ? 'is' : 'are'} removed. Findings lose their deployment context until you connect it again.`
      : `Hinomi forgets ${secret}. It reports no deployments right now.`
  }
  const n = source.repoCount
  return n > 0
    ? `Hinomi forgets ${secret}. Its ${plural(n, 'repo')} ${n === 1 ? 'moves' : 'move'} to another GitHub source that sees ${n === 1 ? 'it' : 'them'}, or ${n === 1 ? 'stops' : 'stop'} being read; ${n === 1 ? 'its' : 'their'} findings and fix runs stay.`
    : `Hinomi forgets ${secret}. It reads no repos right now.`
}

/** One term and value of a source, inline so the row stays short. */
function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="shrink-0 text-muted-foreground">{term}</dt>
      <dd className="flex min-w-0 items-center">{children}</dd>
    </div>
  )
}

function TestOutcome({
  pending,
  result,
  error,
  note,
}: {
  pending: boolean
  result: SourceTestResult | undefined
  error: unknown
  note: string | null
}) {
  let content: React.ReactNode = null
  if (!pending && note) {
    content = <span className="text-success">{note}</span>
  } else if (!pending && error) {
    content = <span className="text-sev-critical">{describeError(error)}</span>
  } else if (!pending && result) {
    content = result.ok ? (
      <span className="text-success">
        {result.message}
        {result.scopes?.length ? `. Scopes: ${result.scopes.join(', ')}` : ''}.
      </span>
    ) : (
      <span className="text-sev-critical">{result.message}</span>
    )
  }
  return (
    <p aria-live="polite" className={cn('text-sm', !content && 'sr-only')}>
      {content}
    </p>
  )
}

function MissingSource({
  kind,
  canStoreTokens,
}: {
  kind: ConnectableKind
  canStoreTokens: boolean
}) {
  const meta = KIND_META[kind]
  const [open, setOpen] = useState(false)
  return (
    <SetRow
      as="li"
      icon={<meta.icon stroke={1.75} />}
      title={meta.label}
      sub={meta.empty}
      aside={
        open ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
            disabled={!canStoreTokens}
          >
            <IconPlugConnected aria-hidden="true" />
            Connect
          </Button>
        )
      }
    >
      {open ? (
        <SourceConnectForm
          kind={kind}
          onCancel={() => setOpen(false)}
          onConnected={() => setOpen(false)}
        />
      ) : null}
    </SetRow>
  )
}

function OsvRow() {
  const { settings, mutation, enabled: checked, setEnabled } = useOsvSetting()
  return (
    <SetRow
      as="li"
      icon={<IconDatabase stroke={1.75} />}
      title={<span id="osv-switch-label">OSV.dev lockfile scan</span>}
      sub="Public API, no token needed. Only package names and versions are sent, never your code."
      aside={
        <span className="flex items-center gap-2">
          <SaveStatus
            pending={mutation.isPending}
            saved={mutation.isSuccess}
            error={mutation.isError || settings.isError ? 'Not saved' : null}
          />
          <Switch
            aria-labelledby="osv-switch-label"
            checked={checked}
            disabled={!settings.data || mutation.isPending}
            onCheckedChange={setEnabled}
          />
        </span>
      }
    />
  )
}

function SourcesSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-card p-4"
        >
          <Skeleton className="size-9 rounded-md" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-2.5 w-44" />
          </span>
        </div>
      ))}
    </div>
  )
}
