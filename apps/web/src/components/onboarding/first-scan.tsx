import { useEffect, useState } from 'react'
import type { ScanRun, SourceKind } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCircleCheck,
  IconCircleMinus,
  IconLoader2,
  IconRadar2,
} from '@tabler/icons-react'
import { FieldError } from '@/components/form/field'
import { Button } from '@/components/ui/button'
import { ScanPhases } from '@/components/onboarding/scan-phases'
import { Callout } from '@/components/ui/callout'
import { useScanStatus } from '@/hooks/use-shell-data'
import { describeError } from '@/lib/errors'
import { queryKeys } from '@/lib/queries'
import { latestScanQuery, scanRunQuery, settingsKeys, startFirstScan } from '@/lib/settings-api'
import { nowMs } from '@hinomi/shared'

const SOURCE_LABEL: Record<SourceKind, string> = {
  coolify: 'Coolify',
  github: 'GitHub',
  osv: 'OSV.dev lockfiles',
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** "12 deployments", "38 repos, 4,917 alerts": the counts a source reported, in words. */
function describeCounts(kind: SourceKind, counts: Record<string, number>): string {
  const parts: string[] = []
  const n = (key: string) => counts[key] ?? 0
  if (kind === 'coolify') parts.push(plural(n('deployments'), 'deployment'))
  if (kind === 'github') parts.push(plural(n('repos'), 'repo'), plural(n('alerts'), 'open alert'))
  if (kind === 'osv')
    parts.push(plural(n('lockfiles'), 'lockfile'), plural(n('matches'), 'match', 'matches'))
  if (n('failed') > 0) parts.push(`${n('failed')} failed`)
  return parts.join(', ')
}

/** Where the first scan is, for the step's heading. */
export type FirstScanState = 'idle' | 'running' | 'succeeded' | 'failed'

/**
 * Step 4: starts the first scan (or follows the one that started on its own
 * when the first source was connected) and shows its progress from
 * /api/shell/scan-status plus the run's per source results.
 */
export function FirstScan({
  onFinished,
  onStateChange,
}: {
  onFinished?: (run: ScanRun) => void
  onStateChange?: (state: FirstScanState) => void
}) {
  const queryClient = useQueryClient()
  const status = useScanStatus()
  const [runId, setRunId] = useState<number | null>(null)
  const latest = useQuery({
    ...latestScanQuery,
    // Look for a scan the server started by itself while nothing is tracked yet.
    enabled: runId === null,
    refetchInterval: status.state === 'scanning' ? 3_000 : false,
  })
  const latestRun = latest.data?.items[0]
  const trackedId =
    runId ??
    (status.state === 'scanning'
      ? status.scanRunId
      : latestRun?.status === 'running'
        ? latestRun.id
        : null)
  const run = useQuery({ ...scanRunQuery(trackedId ?? 0), enabled: trackedId !== null })

  const start = useMutation({
    mutationFn: startFirstScan,
    onSuccess: async ({ run: started }) => {
      setRunId(started.id)
      queryClient.setQueryData(settingsKeys.scan(started.id), started)
      await queryClient.invalidateQueries({ queryKey: queryKeys.scanStatus })
    },
  })

  const current: ScanRun | undefined = trackedId === null ? undefined : run.data
  const running = current?.status === 'running' || (trackedId !== null && !current)
  const finished = current && current.status !== 'running' ? current : undefined
  // Connected moments ago: the scheduler is about to start the first scan on its own.
  const starting = !current && !running && startsSoon(status)

  const state: FirstScanState =
    running || starting
      ? 'running'
      : finished
        ? finished.status === 'failed'
          ? 'failed'
          : 'succeeded'
        : 'idle'
  useEffect(() => onStateChange?.(state), [state, onStateChange])

  // When the tracked run ends, refresh the shell's scan line and tell the page.
  useEffect(() => {
    if (!finished) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.scanStatus })
    onFinished?.(finished)
  }, [finished, onFinished, queryClient])

  if (!current && !running && !starting) {
    return (
      <>
        {start.error ? (
          <div role="alert">
            <FieldError>{describeError(start.error)}</FieldError>
          </div>
        ) : null}
        <div>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? (
              <IconLoader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <IconRadar2 aria-hidden="true" />
            )}
            {start.isPending ? 'Starting' : 'Run first scan'}
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      {running || starting ? (
        <ScanPhases status={status.state === 'scanning' ? status : null} />
      ) : null}
      {current ? <SourceLines run={current} /> : null}
      {current && !running ? (
        <ScanSummary run={current} onRescan={() => start.mutate()} rescanning={start.isPending} />
      ) : null}
    </>
  )
}

/** A queued scan due this soon shows as starting instead of offering the start button. */
const STARTS_SOON_MS = 60_000

function startsSoon(status: ReturnType<typeof useScanStatus>): boolean {
  if (status.state !== 'queued' || status.nextScanAt === null) return false
  return new Date(status.nextScanAt).getTime() - nowMs() < STARTS_SOON_MS
}

function SourceLines({ run }: { run: ScanRun }) {
  const kinds = (Object.keys(SOURCE_LABEL) as SourceKind[]).filter((k) => run.sourceResults[k])
  if (kinds.length === 0) return null
  return (
    <ul aria-label="Sources in this scan" className="flex flex-col gap-1.5 text-sm">
      {kinds.map((kind) => {
        const result = run.sourceResults[kind]
        if (!result) return null
        const Icon =
          result.status === 'ok'
            ? IconCircleCheck
            : result.status === 'error'
              ? IconAlertTriangle
              : IconCircleMinus
        return (
          <li key={kind} className="flex items-start gap-2">
            <Icon
              aria-hidden="true"
              className={
                result.status === 'ok'
                  ? 'mt-0.5 size-4 shrink-0 text-success'
                  : result.status === 'error'
                    ? 'mt-0.5 size-4 shrink-0 text-wait'
                    : 'mt-0.5 size-4 shrink-0 text-muted-foreground'
              }
              stroke={1.75}
            />
            <span className="min-w-0">
              <b className="font-medium">{SOURCE_LABEL[kind]}</b>
              <span className="text-muted-foreground">
                {': '}
                {result.status === 'skipped'
                  ? 'skipped'
                  : result.status === 'error'
                    ? (result.error ?? 'failed')
                    : describeCounts(kind, result.counts)}
              </span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function ScanSummary({
  run,
  onRescan,
  rescanning,
}: {
  run: ScanRun
  onRescan: () => void
  rescanning: boolean
}) {
  if (run.status === 'failed') {
    return (
      <>
        <Callout variant="warn" icon={IconAlertTriangle} title="The scan failed">
          {run.error ?? 'Check the source errors above, fix the connection and try again.'}
        </Callout>
        <div>
          <Button onClick={onRescan} disabled={rescanning}>
            {rescanning ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
            Try again
          </Button>
        </div>
      </>
    )
  }
  const seconds = run.durationMs === null ? null : Math.max(1, Math.round(run.durationMs / 1000))
  return (
    <>
      <Callout
        variant="info"
        icon={IconRadar2}
        title={run.status === 'partial' ? 'First scan done, with some errors' : 'First scan done'}
      >
        {run.findingsOpened === 0
          ? 'No findings opened'
          : `${plural(run.findingsOpened, 'finding')} opened`}
        {seconds === null ? '' : ` in ${plural(seconds, 'second')}`}.{' '}
        {run.status === 'partial'
          ? 'One source had trouble, so some findings may be missing until the next scan.'
          : run.findingsOpened === 0
            ? 'Nothing Hinomi can see has an open advisory right now. The next scan runs on its own.'
            : 'The exposure view ranks them, so what is public and critical comes first.'}
      </Callout>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="lg">
          <Link to="/">
            Open exposure view
            <IconArrowRight aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="ghost">
          <Link to="/settings">Settings</Link>
        </Button>
      </div>
    </>
  )
}
