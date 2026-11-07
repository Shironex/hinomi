import type * as React from 'react'
import type { RepoDetail, RepoSourceRef, SourceAuth } from '@hinomi/shared'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconAlertTriangle, IconLoader2 } from '@tabler/icons-react'
import { Field } from '@/components/form/field'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { describeError } from '@/lib/errors'
import { fixKeys } from '@/lib/fix-api'
import { repoQuery, settingsKeys, updateRepo } from '@/lib/settings-api'

const AUTH_WORD: Record<SourceAuth, string> = { token: 'token', github_app: 'GitHub App' }

const MODE_NOTE: Record<SourceView['mode'], string> = {
  override: 'Picked by hand',
  auto: 'Picked by the scan',
  fallback: 'The only GitHub source',
  none: 'No source can read it',
}

const AUTO = 'auto'

/** What the chosen source means for this repo, in a sentence. */
function hintOf(view: SourceView): string {
  const seen = view.seenBy.length
  switch (view.mode) {
    case 'override':
      return 'Scans and fix runs go through this source while it is on, whatever the scan would pick.'
    case 'auto':
      return seen > 1
        ? `${seen} GitHub sources see this repo. The scan uses the first one that can read its Dependabot alerts.`
        : 'The only GitHub source that sees this repo. Scans and fix runs go through it.'
    case 'fallback':
      return 'No scan has placed this repo yet, so the only GitHub source is used.'
    case 'none':
      return 'Its findings and fix runs stay, but nothing is read or fixed until a source can see it again.'
  }
}

type SourceView = RepoDetail['source']

/** The source picked by hand: it can be switched off or no longer see the repo. */
function overrideOf(view: SourceView): RepoSourceRef | null {
  if (view.overrideId === null) return null
  const id = view.overrideId
  if (view.mode === 'override' && view.current) return view.current
  return (
    view.seenBy.find((s) => s.id === id) ?? {
      id,
      name: `Source ${id}`,
      auth: 'token',
      enabled: false,
    }
  )
}

/**
 * Which GitHub source reads and fixes the repo, and a switch between the sources that see it.
 * The pick goes to the server, which answers the repo again; the runner status and the source
 * counts follow it.
 */
export function RepoSource({ repoId }: { repoId: number }) {
  const queryClient = useQueryClient()
  const query = useQuery(repoQuery(repoId))
  const mutation = useMutation({
    mutationFn: (sourceId: number | null) => updateRepo(repoId, { sourceId }),
    onSuccess: async (next) => {
      queryClient.setQueryData(settingsKeys.repo(repoId), next)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsKeys.sources }),
        queryClient.invalidateQueries({ queryKey: fixKeys.runner(repoId) }),
      ])
    },
  })
  const headingId = `repo-source-${repoId}`

  let body: React.ReactNode
  if (query.isPending) {
    body = <Skeleton className="h-4 w-3/5" />
  } else if (query.isError) {
    body = (
      <div className="flex flex-wrap items-center gap-2 text-sm text-foreground-2">
        <span>The repo&apos;s GitHub source did not load: {describeError(query.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    )
  } else {
    body = <SourceBody view={query.data.source} mutation={mutation} />
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          GitHub source
        </h3>
        {query.data ? (
          <span className="text-xs text-muted-foreground">{MODE_NOTE[query.data.source.mode]}</span>
        ) : null}
        {mutation.isPending ? (
          <IconLoader2
            aria-label="Saving"
            className="size-3.5 self-center text-muted-foreground motion-safe:animate-spin"
          />
        ) : null}
      </div>
      {body}
    </section>
  )
}

function SourceBody({
  view,
  mutation,
}: {
  view: SourceView
  mutation: UseMutationResult<RepoDetail, Error, number | null>
}) {
  const override = overrideOf(view)
  // A switched off pick does not apply; say so, since the select still shows it.
  const idle = override && view.mode !== 'override' ? override : null
  const options: RepoSourceRef[] = [...view.seenBy]
  // Keep a pick the scan did not see the repo through in the list, so the select can show it.
  if (override && !options.some((s) => s.id === override.id)) options.push(override)
  const switchable = view.seenBy.length > 1 || view.overrideId !== null
  const saved = view.overrideId === null ? AUTO : String(view.overrideId)
  const value = mutation.isPending
    ? mutation.variables == null
      ? AUTO
      : String(mutation.variables)
    : saved
  const readable = new Map(view.seenBy.map((s) => [s.id, s.alertsReadable]))

  return (
    <>
      {view.current ? (
        <p className="text-sm">
          <b className="font-semibold">{view.current.name}</b>
          <span className="text-foreground-2">, {AUTH_WORD[view.current.auth]}</span>
        </p>
      ) : null}
      {idle ? (
        <p className="flex items-start gap-1.5 text-sm text-foreground-2">
          <IconAlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-wait"
            stroke={1.75}
          />
          <span>
            {idle.name} was picked by hand but is switched off, so{' '}
            {view.mode === 'none' ? 'no source reads the repo.' : "the scan's choice applies."}
          </span>
        </p>
      ) : null}
      <p className="max-w-[68ch] text-sm text-foreground-2">
        {hintOf(view)}
        {view.mode === 'none' ? (
          <>
            {' '}
            <Link
              to="/settings"
              search={{ sel: 'sources' }}
              className="text-accent-ink underline-offset-2 hover:underline"
            >
              Settings, Sources
            </Link>
          </>
        ) : null}
      </p>
      {switchable ? (
        <Field
          label="Read and fix through"
          help="Automatic follows the scan. A source picked by hand wins while it is on."
          className="max-w-[360px]"
        >
          {(control) => (
            <NativeSelect
              {...control}
              value={value}
              disabled={mutation.isPending}
              onChange={(event) => {
                const next = event.target.value
                if (next === value) return
                mutation.mutate(next === AUTO ? null : Number(next))
              }}
            >
              <option value={AUTO}>Automatic, the scan&apos;s choice</option>
              {options.map((source) => (
                <option
                  key={source.id}
                  value={String(source.id)}
                  disabled={!source.enabled && String(source.id) !== value}
                >
                  {source.name}, {AUTH_WORD[source.auth]}
                  {readable.get(source.id) === false ? ', cannot read alerts' : ''}
                  {source.enabled ? '' : ', switched off'}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      {mutation.error ? (
        <p role="alert" className="text-sm text-sev-critical">
          {describeError(mutation.error)}
        </p>
      ) : null}
    </>
  )
}
