import type * as React from 'react'
import { useId, useRef, useState } from 'react'
import { repoFullNameSchema, type DeploymentItem, type RepoRef } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconBox,
  IconGitBranch,
  IconLoader2,
  IconPlugConnectedX,
  IconPlus,
  IconX,
} from '@tabler/icons-react'
import { Field, FieldError } from '@/components/form/field'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { COVERAGE_NOTE_INFO } from '@/lib/finding-meta'
import { checkField, isInputError, mutationMessage } from '@/lib/form'
import { describeError } from '@/lib/errors'
import {
  addRepoOverride,
  deploymentsQuery,
  removeRepoOverride,
  reposQuery,
  settingsKeys,
} from '@/lib/settings-api'
import { cn } from '@/lib/utils'
import { SetBox } from './settings-section'

/** How the repo was found, in the right column of a mapped row. */
const MATCHED_BY: Record<Exclude<DeploymentItem['mapping'], 'none'>, string> = {
  auto: 'From Coolify',
  override: 'Manual',
}

/** No repo and no git source, so nothing needs mapping: the deployment is just an image. */
const isImageOnly = (d: DeploymentItem) => d.mapping === 'none' && d.coverage.imageOnly

/** Apps that really need a repo first, then image only ones, then the mapped ones. */
const mappingOrder = (d: DeploymentItem) => (d.mapping !== 'none' ? 2 : isImageOnly(d) ? 1 : 0)

/**
 * Which repo each deployment runs. Hinomi reads it from the git source in
 * Coolify; an override replaces it when an app builds from another repo or
 * Coolify does not say. Databases need no repo and are left out.
 */
export function MappingSection() {
  const deployments = useQuery(deploymentsQuery)
  const repos = useQuery(reposQuery)
  const datalistId = useId()

  if (deployments.isPending) {
    return (
      <div
        aria-hidden="true"
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
      >
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="h-3.5 w-64" />
        <Skeleton className="h-3.5 w-40" />
      </div>
    )
  }
  if (deployments.isError) {
    return (
      <ErrorState
        title="Deployments did not load"
        error={deployments.error}
        onRetry={() => void deployments.refetch()}
      />
    )
  }

  const items = deployments.data.items
    .filter((d) => d.kind !== 'database')
    // Unmapped git based apps first: they are the ones that need a person.
    .sort((a, b) => mappingOrder(a) - mappingOrder(b) || a.name.localeCompare(b.name))

  if (items.length === 0) {
    return (
      <EmptyState
        icon={IconGitBranch}
        title="No deployments yet"
        actions={
          <Button asChild variant="outline">
            <Link to="/onboarding">Set up</Link>
          </Button>
        }
      >
        Connect Coolify and run a scan. Each app shows up here with the repo Hinomi matched it to.
      </EmptyState>
    )
  }

  return (
    <>
      <SetBox as="ul" aria-label="Deployments and their repos">
        {items.map((deployment) => (
          <MappingRow key={deployment.id} deployment={deployment} datalistId={datalistId} />
        ))}
      </SetBox>
      <datalist id={datalistId}>
        {(repos.data?.items ?? []).map((repo: RepoRef) => (
          <option key={repo.id} value={repo.fullName} />
        ))}
      </datalist>
    </>
  )
}

function MappingRow({
  deployment,
  datalistId,
}: {
  deployment: DeploymentItem
  datalistId: string
}) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const imageOnly = isImageOnly(deployment)
  const needsRepo = deployment.mapping === 'none' && !imageOnly
  const manual = deployment.mapping === 'override'

  const remove = useMutation({
    mutationFn: (repoId: number) => removeRepoOverride(deployment.id, repoId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKeys.deployments }),
  })

  let repoCell: React.ReactNode
  if (needsRepo) {
    // No repo means Hinomi cannot tell what runs there: a coverage gap, so cyan, never red.
    repoCell = (
      <span className="flex flex-wrap items-center gap-x-1.5 text-sm font-semibold text-blind">
        <IconPlugConnectedX aria-hidden="true" className="size-[15px] shrink-0" stroke={1.75} />
        <span>Needs mapping</span>
        <span className="font-normal text-muted-foreground">exposure unknown</span>
      </span>
    )
  } else if (imageOnly) {
    repoCell = (
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground-2">
        <IconBox aria-hidden="true" className="size-[15px] shrink-0" stroke={1.75} />
        <span className="font-semibold">{COVERAGE_NOTE_INFO.image_only.short}</span>
      </span>
    )
  } else {
    repoCell = (
      <ul aria-label={`Repos of ${deployment.name}`} className="flex min-w-0 flex-wrap gap-1.5">
        {deployment.repos.map((repo) => (
          <li
            key={repo.id}
            className={cn(
              'inline-flex min-w-0 items-center gap-1 font-mono text-sm text-foreground',
              manual && 'h-[26px] rounded-sm border border-border bg-sidebar pr-0.5 pl-2 text-xs',
            )}
          >
            <span className="truncate">{repo.fullName}</span>
            {manual ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${repo.fullName} from ${deployment.name}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(repo.id)}
              >
                {remove.isPending && remove.variables === repo.id ? (
                  <IconLoader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <IconX aria-hidden="true" />
                )}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    )
  }

  return (
    <li className="flex flex-col gap-2.5 border-t border-border py-3.5 first:border-t-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 tab:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <span className="flex min-w-0 flex-col">
          <h3 className="truncate text-base font-semibold">{deployment.name}</h3>
          <span className="truncate text-xs text-muted-foreground">
            {deployment.server ?? deployment.source.name}
            {deployment.gitRepository && deployment.mapping !== 'auto'
              ? `, Coolify says ${deployment.gitRepository}`
              : ''}
          </span>
        </span>
        <span className="col-start-1 row-start-2 min-w-0 tab:col-start-2 tab:row-start-1">
          {repoCell}
        </span>
        <span className="col-start-2 row-span-2 flex items-center justify-end gap-3 tab:col-start-3 tab:row-span-1">
          {deployment.mapping === 'none' ? null : (
            <span className="hidden text-sm text-muted-foreground desk:inline">
              {MATCHED_BY[deployment.mapping]}
            </span>
          )}
          {adding ? null : (
            <Button
              variant={needsRepo ? 'outline' : 'ghost'}
              size="sm"
              onClick={() => setAdding(true)}
              aria-label={`${deployment.mapping === 'none' ? 'Map a repo to' : 'Override the repo of'} ${deployment.name}`}
            >
              {needsRepo ? null : <IconPlus aria-hidden="true" />}
              {deployment.mapping === 'none' ? 'Map a repo' : manual ? 'Add repo' : 'Override'}
            </Button>
          )}
        </span>
      </div>
      {imageOnly ? (
        <p className="text-xs text-pretty text-muted-foreground">
          Deployed from a container image with no git source, so there is nothing to map. The image
          scan will cover it. Map a repo only if you build this image yourself.
        </p>
      ) : null}
      {remove.error ? (
        <div role="alert">
          <FieldError>{describeError(remove.error)}</FieldError>
        </div>
      ) : null}
      {adding ? (
        <OverrideForm
          deployment={deployment}
          datalistId={datalistId}
          onDone={() => setAdding(false)}
        />
      ) : null}
    </li>
  )
}

function OverrideForm({
  deployment,
  datalistId,
  onDone,
}: {
  deployment: DeploymentItem
  datalistId: string
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [repo, setRepo] = useState('')
  const [note, setNote] = useState('')
  const [repoError, setRepoError] = useState<string | null>(null)
  const repoRef = useRef<HTMLInputElement>(null)

  const mutation = useMutation({
    mutationFn: () =>
      addRepoOverride(deployment.id, { repo: repo.trim(), note: note.trim() || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: settingsKeys.deployments })
      onDone()
    },
    onError: (error) => {
      if (!isInputError(error) && !(error instanceof Error && /repo/i.test(error.message))) return
      setRepoError(mutationMessage(error))
      repoRef.current?.focus()
    },
  })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    const error = checkField(repoFullNameSchema, repo, 'Enter the repo as owner/name.')
    setRepoError(error)
    if (error) return repoRef.current?.focus()
    mutation.mutate()
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label={`Map a repo to ${deployment.name}`}
      className="flex flex-col gap-3 rounded-md bg-sidebar p-3"
    >
      <div className="grid gap-3 tab:grid-cols-2">
        <Field
          label="Repo"
          help={
            deployment.mapping === 'override'
              ? 'Added next to the repos above.'
              : 'Replaces the repo from Coolify.'
          }
          error={repoError}
        >
          {(control) => (
            <Input
              {...control}
              ref={repoRef}
              list={datalistId}
              spellCheck={false}
              autoCapitalize="none"
              className="font-mono"
              placeholder="kestrel-co/storefront"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value)
                if (repoError) setRepoError(null)
              }}
            />
          )}
        </Field>
        <Field label="Note" help="Optional. Why this app builds from that repo.">
          {(control) => (
            <Input
              {...control}
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </div>
      {mutation.error && !repoError ? (
        <div role="alert">
          <FieldError>{describeError(mutation.error)}</FieldError>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
          Save mapping
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={mutation.isPending}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Blind spots follow on the next scan.</p>
    </form>
  )
}
