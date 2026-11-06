import { SCAN_INTERVAL_DEFAULT_MINUTES } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconLoader2, IconRefresh, IconStack2 } from '@tabler/icons-react'
import { Field, OptionRow } from '@/components/form/field'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useScanStatus, useStartScan } from '@/hooks/use-shell-data'
import { describeError } from '@/lib/errors'
import { formatClock, formatRelative } from '@/lib/format'
import { describeScanning } from '@/lib/scan-phases'
import { settingsKeys, settingsQuery, updateSettings } from '@/lib/settings-api'
import { Panel, SaveStatus } from './settings-section'

const INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 3 * 60, label: '3 hours' },
  { minutes: SCAN_INTERVAL_DEFAULT_MINUTES, label: '6 hours' },
  { minutes: 12 * 60, label: '12 hours' },
  { minutes: 24 * 60, label: '24 hours' },
  { minutes: 7 * 24 * 60, label: '7 days' },
]

function intervalLabel(minutes: number): string {
  const preset = INTERVALS.find((i) => i.minutes === minutes)
  if (preset) return preset.label
  if (minutes % 60 === 0) return `${minutes / 60} hours`
  return `${minutes} minutes`
}

export function ScansSection() {
  const queryClient = useQueryClient()
  const settings = useQuery(settingsQuery)
  const scan = useScanStatus()
  const startScan = useStartScan()
  const mutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: (data) => queryClient.setQueryData(settingsKeys.settings, data),
  })

  if (settings.isPending) {
    return (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-8 w-full" />
      </Panel>
    )
  }
  if (settings.isError) {
    return (
      <ErrorState
        title="Scan settings did not load"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    )
  }

  const pending = mutation.variables
  const interval =
    mutation.isPending && pending?.scanIntervalMinutes !== undefined
      ? pending.scanIntervalMinutes
      : settings.data.scanIntervalMinutes
  const accountRepos =
    mutation.isPending && pending?.includeAccountRepos !== undefined
      ? pending.includeAccountRepos
      : settings.data.includeAccountRepos
  const options = INTERVALS.some((i) => i.minutes === interval)
    ? INTERVALS
    : [...INTERVALS, { minutes: interval, label: intervalLabel(interval) }].sort(
        (a, b) => a.minutes - b.minutes,
      )

  return (
    <Panel>
      <div className="grid items-end gap-3.5 tab:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <Field label="Scan every" help="Changing it replans the next scan.">
          {(control) => (
            <NativeSelect
              {...control}
              value={interval}
              disabled={mutation.isPending}
              onChange={(e) => mutation.mutate({ scanIntervalMinutes: Number(e.target.value) })}
            >
              {options.map((o) => (
                <option key={o.minutes} value={o.minutes}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <div className="pb-6">
          <SaveStatus
            pending={mutation.isPending}
            saved={mutation.isSuccess}
            error={mutation.isError ? describeError(mutation.error) : null}
          />
        </div>
      </div>
      <OptionRow
        className="border-t pt-3.5 first:pt-3.5"
        icon={<IconStack2 aria-hidden="true" stroke={1.75} />}
        title={<span id="account-repos-label">Include repos with no deployment</span>}
        note="Reads every repo the GitHub token can see. They rank last, below everything deployed."
        control={
          <Switch
            aria-labelledby="account-repos-label"
            checked={accountRepos}
            disabled={mutation.isPending}
            onCheckedChange={(next) => mutation.mutate({ includeAccountRepos: next })}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-3.5">
        <dl className="grid flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
          <ScanFacts scan={scan} />
        </dl>
        {scan.state === 'unconfigured' ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={startScan}
            disabled={!startScan || scan.state === 'scanning'}
          >
            {scan.state === 'scanning' ? (
              <IconLoader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <IconRefresh aria-hidden="true" />
            )}
            {scan.state === 'scanning' ? 'Scanning' : 'Scan now'}
          </Button>
        )}
      </div>
    </Panel>
  )
}

function ScanFacts({ scan }: { scan: ReturnType<typeof useScanStatus> }) {
  const row = (term: string, value: string) => (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd>{value}</dd>
    </>
  )
  switch (scan.state) {
    case 'unconfigured':
      return row('Status', 'Nothing connected, so scans are paused')
    case 'queued':
      return row('Status', 'Connected, the first scan starts shortly')
    case 'scanning':
      return row('Status', describeScanning(scan))
    case 'failed':
      return (
        <>
          {row(
            'Last scan',
            scan.lastScanAt ? `Failed ${formatRelative(scan.lastScanAt)}` : 'Failed',
          )}
          {row('Reason', scan.message)}
        </>
      )
    case 'idle':
      return (
        <>
          {row('Last scan', formatRelative(scan.lastScanAt))}
          {row('Next scan', scan.nextScanAt ? formatClock(scan.nextScanAt) : 'Not planned')}
        </>
      )
  }
}
