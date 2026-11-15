import { useState } from 'react'
import { DOCKER_OPT_IN_LABEL, type SourceDto } from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconBrandDocker, IconLoader2, IconPlugConnected, IconTrash } from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DockerSourceForm } from '@/components/sources/docker-source-form'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { describeError } from '@/lib/errors'
import { formatRelative, plural } from '@/lib/format'
import { queryKeys } from '@/lib/queries'
import { removeSource, settingsKeys, testSavedSource, updateSource } from '@/lib/settings-api'
import { healthOf } from '@/lib/source-health'
import { SetRow } from './settings-section'
import { Fact, HealthPill, TestOutcome } from './source-row-bits'

/** A connected Docker host: how Hinomi reaches it, what it reports, test, edit and remove. */
export function DockerSourceRow({
  source,
  canStoreTokens,
}: {
  source: SourceDto
  canStoreTokens: boolean
}) {
  const queryClient = useQueryClient()
  const docker = source.docker ?? null
  // A socket needs no secret; a TLS endpoint with a client certificate needs its key.
  const health = healthOf(source, { needsToken: Boolean(docker?.cert) })
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState<string | null>(null)

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
  const enabled = toggle.isPending ? (toggle.variables ?? source.enabled) : source.enabled
  const how = docker?.transport === 'tls' ? 'TLS endpoint' : 'socket'

  return (
    <SetRow
      as="li"
      icon={<IconBrandDocker stroke={1.75} />}
      title={source.name}
      sub={`Docker host, ${how}, read only (GET)`}
      aside={<HealthPill health={health} />}
      stackAside
    >
      {health.tone === 'error' && source.lastError ? (
        <p className="rounded-md bg-wait-soft px-3 py-2 text-sm text-foreground-2">
          <b className="font-semibold text-wait">Last sync failed: </b>
          {source.lastError}
          {source.lastErrorAt ? ` (${formatRelative(source.lastErrorAt)})` : null}
        </p>
      ) : null}
      <dl className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
        <Fact term={docker?.transport === 'tls' ? 'URL' : 'Socket'}>
          <span className="truncate font-mono text-xs">
            {(docker?.transport === 'tls' ? source.baseUrl : docker?.socketPath) ?? 'Not set'}
          </span>
        </Fact>
        {docker?.transport === 'tls' ? (
          <Fact term="Client certificate">{docker.cert ? 'Set' : 'None'}</Fact>
        ) : null}
        <Fact term="Reads">
          {docker?.optIn === false ? (
            'every container'
          ) : (
            <span>
              containers labelled{' '}
              <code className="font-mono text-xs">{DOCKER_OPT_IN_LABEL}=true</code>
            </span>
          )}
        </Fact>
        <Fact term="Reports">{plural(source.deploymentCount, 'deployment')}</Fact>
      </dl>

      {editing ? (
        <div className="border-t border-border pt-3.5">
          <DockerSourceForm
            source={source}
            onCancel={() => setEditing(false)}
            onConnected={({ test: result }) => {
              setEditing(false)
              setNote(`Connection saved. ${result.message}.`)
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
                setNote(null)
                test.mutate()
              }}
              disabled={test.isPending}
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
                setNote(null)
                setEditing(true)
              }}
              disabled={!canStoreTokens && docker?.transport === 'tls'}
            >
              Edit connection
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
            note={note}
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
        {source.deploymentCount > 0
          ? `Hinomi forgets how to reach this host and its ${plural(source.deploymentCount, 'deployment')} ${source.deploymentCount === 1 ? 'is' : 'are'} removed.`
          : 'Hinomi forgets how to reach this host. It reports no deployments right now.'}
      </ConfirmDialog>
    </SetRow>
  )
}
