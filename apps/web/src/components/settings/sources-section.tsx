import type * as React from 'react'
import { useState } from 'react'
import type { SourceDto, SourceTestResult } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconCheck,
  IconDatabase,
  IconGitBranch,
  IconLoader2,
  IconPlugConnected,
  IconServer2,
  IconTrash,
  type Icon,
} from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { OptionRow } from '@/components/form/field'
import { SecretKeyCallout } from '@/components/sources/secret-key-callout'
import { SourceConnectForm, type ConnectableKind } from '@/components/sources/source-connect-form'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useOsvSetting } from '@/hooks/use-osv-setting'
import { describeError } from '@/lib/errors'
import { formatRelative } from '@/lib/format'
import { queryKeys } from '@/lib/queries'
import {
  removeSource,
  settingsKeys,
  sourcesQuery,
  testSavedSource,
  updateSource,
} from '@/lib/settings-api'
import { cn } from '@/lib/utils'
import { Panel, SaveStatus } from './settings-section'

const KIND_META: Record<ConnectableKind, { label: string; icon: Icon; empty: string }> = {
  coolify: {
    label: 'Coolify',
    icon: IconServer2,
    empty: 'Deployments, domains and servers. Without it nothing is ranked as deployed.',
  },
  github: {
    label: 'GitHub',
    icon: IconGitBranch,
    empty: 'Repos and their Dependabot alerts.',
  },
}

export function SourcesSection() {
  const queryClient = useQueryClient()
  const sources = useQuery(sourcesQuery)

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
      {(['coolify', 'github'] as const).map((kind) => {
        const list = sources.data.sources.filter((s) => s.kind === kind)
        if (list.length === 0) {
          return <MissingSource key={kind} kind={kind} canStoreTokens={canStoreTokens} />
        }
        return list.map((source) => (
          <SourceCard key={source.id} source={source} kind={kind} canStoreTokens={canStoreTokens} />
        ))
      })}
      <OsvCard />
    </>
  )
}

type Health = { label: string; variant: 'success' | 'critical' | 'outline' | 'high' }

function healthOf(source: SourceDto): Health {
  if (!source.enabled) return { label: 'Paused', variant: 'outline' }
  if (!source.hasToken) return { label: 'No token', variant: 'high' }
  const ok = source.lastOkAt ? Date.parse(source.lastOkAt) : 0
  const failed = source.lastErrorAt ? Date.parse(source.lastErrorAt) : 0
  if (failed > ok) return { label: 'Error', variant: 'critical' }
  if (ok) return { label: 'Connected', variant: 'success' }
  return { label: 'Not synced yet', variant: 'outline' }
}

function SourceHeader({
  icon: KindIcon,
  title,
  note,
  aside,
}: {
  icon: Icon
  title: string
  note: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-muted text-foreground-2">
        <KindIcon aria-hidden="true" className="size-4" stroke={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <h3 className="truncate text-base font-medium">{title}</h3>
        <small className="truncate text-xs text-muted-foreground">{note}</small>
      </span>
      {aside}
    </div>
  )
}

function SourceCard({
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

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsKeys.sources }),
      queryClient.invalidateQueries({ queryKey: queryKeys.scanStatus }),
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

  const synced = source.lastOkAt ? `synced ${formatRelative(source.lastOkAt)}` : 'not synced yet'
  const enabled = toggle.isPending ? (toggle.variables ?? source.enabled) : source.enabled
  const lastErrorIsCurrent = health.variant === 'critical' && source.lastError
  const isApp = source.auth === 'github_app'

  return (
    <Panel>
      <SourceHeader
        icon={meta.icon}
        title={source.name}
        note={`${meta.label}, ${synced}`}
        aside={
          <Badge variant={health.variant}>
            {health.variant === 'success' ? <IconCheck aria-hidden="true" /> : null}
            {health.variant === 'critical' ? <IconAlertTriangle aria-hidden="true" /> : null}
            {health.label}
          </Badge>
        }
      />
      {lastErrorIsCurrent ? (
        <p className="rounded-md bg-sev-critical-soft px-3 py-2 text-sm text-foreground-2">
          <b className="font-medium text-sev-critical">Last sync failed: </b>
          {source.lastError}
          {source.lastErrorAt ? ` (${formatRelative(source.lastErrorAt)})` : null}
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">URL</dt>
        <dd className="truncate font-mono text-[0.92em]">
          {source.baseUrl ?? (kind === 'github' ? 'github.com' : 'Not set')}
        </dd>
        {isApp ? (
          <>
            <dt className="text-muted-foreground">Signs in as</dt>
            <dd className="truncate font-mono text-[0.92em]">
              App {source.appId}, installation {source.installationId}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{isApp ? 'Private key' : 'Token'}</dt>
        <dd>
          {source.hasToken ? (
            <Badge variant="outline">
              <IconCheck aria-hidden="true" />
              Set
            </Badge>
          ) : (
            <Badge variant="high">Not set</Badge>
          )}
          <span className="sr-only">. Secrets are never shown again.</span>
        </dd>
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
        {kind === 'coolify'
          ? 'Hinomi forgets its token and every deployment it reported. Findings lose their deployment context until you connect it again.'
          : 'Hinomi forgets its token and stops reading repos and Dependabot alerts from it.'}
      </ConfirmDialog>
    </Panel>
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
    <Panel className={open ? undefined : 'border-dashed border-input'}>
      <SourceHeader
        icon={meta.icon}
        title={meta.label}
        note={meta.empty}
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
      />
      {open ? (
        <SourceConnectForm
          kind={kind}
          onCancel={() => setOpen(false)}
          onConnected={() => setOpen(false)}
        />
      ) : null}
    </Panel>
  )
}

function OsvCard() {
  const { settings, mutation, enabled: checked, setEnabled } = useOsvSetting()
  return (
    <Panel>
      <OptionRow
        icon={<IconDatabase aria-hidden="true" stroke={1.75} />}
        title={<span id="osv-switch-label">OSV.dev lockfile scan</span>}
        note="Public API, no token needed."
        control={
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
      <p className="text-sm text-muted-foreground">
        Reads the lockfile of each deployed repo and checks it against OSV.dev. This covers repos
        where Dependabot alerts are off and adds a second source to every finding. Only package
        names and versions are sent, never your code.
      </p>
    </Panel>
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
          <Skeleton className="size-[30px] rounded-md" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-2.5 w-44" />
          </span>
        </div>
      ))}
    </div>
  )
}
