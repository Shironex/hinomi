import { useState } from 'react'
import type { DeploymentItem, SourceDto } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconFileImport,
  IconListDetails,
  IconLoader2,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ManualDeploymentForm } from '@/components/sources/manual-deployment-form'
import { ManualImportForm } from '@/components/sources/manual-import-form'
import { describeError } from '@/lib/errors'
import { plural } from '@/lib/format'
import { refreshManualList, removeManualDeployment } from '@/lib/manual-api'
import { createSource, deploymentsQuery, removeSource, updateSource } from '@/lib/settings-api'
import { SetRow } from './settings-section'

const DEFAULT_NAME = 'Manual list'
const SUB = 'Deployments you list by hand. No token. Container checks say unknown for them.'

const REACH_LABEL = { public: 'Public', internal: 'Internal', unknown: 'Reach unknown' } as const

/** The manual list of Settings, Sources: one row per manual source, or the offer to create one. */
export function ManualSourceRows({ sources }: { sources: readonly SourceDto[] }) {
  if (sources.length === 0) return <MissingManualList />
  return sources.map((source) => <ManualSourceRow key={source.id} source={source} />)
}

function MissingManualList() {
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: () => createSource({ kind: 'manual', name: DEFAULT_NAME }),
    onSuccess: () => refreshManualList(queryClient),
  })
  return (
    <SetRow
      as="li"
      icon={<IconListDetails stroke={1.75} />}
      title="Manual list"
      sub={SUB}
      aside={
        <Button
          size="sm"
          variant="outline"
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          {create.isPending ? (
            <IconLoader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <IconPlus aria-hidden="true" />
          )}
          Create list
        </Button>
      }
    >
      {create.isError ? (
        <p role="alert" className="text-sm text-sev-critical">
          {describeError(create.error)}
        </p>
      ) : null}
    </SetRow>
  )
}

type Editing = { kind: 'add' } | { kind: 'edit'; entry: DeploymentItem } | { kind: 'import' } | null

function ManualSourceRow({ source }: { source: SourceDto }) {
  const queryClient = useQueryClient()
  const deployments = useQuery(deploymentsQuery)
  const [editing, setEditing] = useState<Editing>(null)
  const [note, setNote] = useState<string | null>(null)
  const [removing, setRemoving] = useState<DeploymentItem | null>(null)
  const [confirmingList, setConfirmingList] = useState(false)

  const entries = (deployments.data?.items ?? []).filter((d) => d.source.id === source.id)

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateSource(source.id, { enabled }),
    onSuccess: () => refreshManualList(queryClient),
  })
  const removeEntry = useMutation({
    mutationFn: (entry: DeploymentItem) => removeManualDeployment(entry.id),
    onSuccess: async (_, entry) => {
      setRemoving(null)
      setNote(`${entry.name} removed.`)
      await refreshManualList(queryClient)
    },
  })
  const removeList = useMutation({
    mutationFn: () => removeSource(source.id),
    onSuccess: async () => {
      setConfirmingList(false)
      await refreshManualList(queryClient)
    },
  })

  const done = (message: string) => {
    setEditing(null)
    setNote(message)
  }
  const enabled = toggle.isPending ? (toggle.variables ?? source.enabled) : source.enabled

  return (
    <SetRow
      as="li"
      icon={<IconListDetails stroke={1.75} />}
      title={source.name}
      sub={SUB}
      aside={
        <Badge variant="outline">
          {enabled ? plural(source.deploymentCount, 'deployment') : 'Paused'}
        </Badge>
      }
    >
      {deployments.isError ? (
        <p role="alert" className="text-sm text-sev-critical">
          {describeError(deployments.error)}
        </p>
      ) : null}
      {entries.length > 0 ? (
        <ul
          aria-label={`Deployments of ${source.name}`}
          className="flex flex-col divide-y divide-border rounded-md border border-border"
        >
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onEdit={() => {
                setNote(null)
                setEditing({ kind: 'edit', entry })
              }}
              onRemove={() => setRemoving(entry)}
            />
          ))}
        </ul>
      ) : deployments.isSuccess ? (
        <p className="text-sm text-muted-foreground">
          No deployments yet. Add one, or import a YAML file.
        </p>
      ) : null}

      {editing?.kind === 'add' || editing?.kind === 'edit' ? (
        <ManualDeploymentForm
          key={editing.kind === 'edit' ? editing.entry.id : 'add'}
          source={source}
          {...(editing.kind === 'edit' && { entry: editing.entry })}
          onDone={done}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {editing?.kind === 'import' ? (
        <ManualImportForm source={source} onDone={done} onCancel={() => setEditing(null)} />
      ) : null}

      {editing === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNote(null)
              setEditing({ kind: 'add' })
            }}
          >
            <IconPlus aria-hidden="true" />
            Add deployment
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNote(null)
              setEditing({ kind: 'import' })
            }}
          >
            <IconFileImport aria-hidden="true" />
            Import YAML
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingList(true)}>
            <IconTrash aria-hidden="true" />
            Remove list
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
      ) : null}
      <p aria-live="polite" className="text-sm text-success empty:hidden">
        {note}
      </p>
      {toggle.isError ? (
        <p role="alert" className="text-sm text-sev-critical">
          {describeError(toggle.error)}
        </p>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (open) return
          setRemoving(null)
          removeEntry.reset()
        }}
        title={`Remove ${removing?.name ?? 'deployment'}?`}
        confirmLabel="Remove deployment"
        onConfirm={() => removing && removeEntry.mutate(removing)}
        pending={removeEntry.isPending}
        error={removeEntry.error ? describeError(removeEntry.error) : null}
      >
        It leaves the list now. Findings that reached it lose their deployment context, and its repo
        mapping is forgotten.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmingList}
        onOpenChange={(open) => {
          setConfirmingList(open)
          if (!open) removeList.reset()
        }}
        title={`Remove ${source.name}?`}
        confirmLabel="Remove list"
        onConfirm={() => removeList.mutate()}
        pending={removeList.isPending}
        error={removeList.error ? describeError(removeList.error) : null}
      >
        {source.deploymentCount > 0
          ? `The list and its ${plural(source.deploymentCount, 'deployment')} are removed. Findings lose their deployment context until you add them again.`
          : 'The list is removed. It holds no deployments right now.'}
      </ConfirmDialog>
    </SetRow>
  )
}

function EntryRow({
  entry,
  onEdit,
  onRemove,
}: {
  entry: DeploymentItem
  onEdit: () => void
  onRemove: () => void
}) {
  const where = [entry.gitRepository, entry.gitBranch].filter(Boolean).join(' on ')
  const detail = [where || null, entry.image, entry.server].filter(Boolean)
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold">{entry.name}</span>
          <Badge variant="outline">{REACH_LABEL[entry.reach]}</Badge>
        </span>
        {detail.length > 0 ? (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {detail.join('  ')}
          </span>
        ) : null}
        {entry.domains.length > 0 ? (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {entry.domains.join(', ')}
          </span>
        ) : null}
      </span>
      <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${entry.name}`}>
        <IconPencil aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={`Remove ${entry.name}`}>
        <IconTrash aria-hidden="true" />
      </Button>
    </li>
  )
}
