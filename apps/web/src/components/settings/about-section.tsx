import { useQuery } from '@tanstack/react-query'
import { IconExternalLink, IconInfoCircle, IconRefresh } from '@tabler/icons-react'
import { CopyCommand } from '@/components/copy-command'
import { ErrorState } from '@/components/states/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useUpdateCheckSetting } from '@/hooks/use-update-check-setting'
import { describeError } from '@/lib/errors'
import { formatDate } from '@/lib/finding-meta'
import { versionQuery } from '@/lib/queries'
import { shortCommit, upgradeLine, versionLabel } from '@/lib/version'
import { Panel, SaveStatus, SetBox, SetRow } from './settings-section'

const linkClass =
  'inline-flex items-center gap-1 text-accent-ink underline-offset-2 hover:underline'

/** Which build is running, and the one switch for the daily check of the latest release. */
export function AboutSection() {
  const version = useQuery(versionQuery)
  const check = useUpdateCheckSetting()

  if (version.isPending) {
    return (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-8 w-full" />
      </Panel>
    )
  }
  if (version.isError) {
    return (
      <ErrorState
        title="The version did not load"
        error={version.error}
        onRetry={() => void version.refetch()}
      />
    )
  }

  const v = version.data
  const commit = shortCommit(v.commit)
  const row = (term: string, value: React.ReactNode) => (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  )

  return (
    <>
      <Panel>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
          {row('Version', <span className="font-semibold">{versionLabel(v)}</span>)}
          {row('Commit', commit ? <code className="font-mono">{commit}</code> : 'Not recorded')}
          {row('Built', v.buildDate ? formatDate(v.buildDate) : 'Not recorded')}
          {row(
            'Release notes',
            v.releaseNotesUrl ? (
              <a
                href={v.releaseNotesUrl}
                target="_blank"
                rel="noreferrer noopener"
                className={linkClass}
              >
                {versionLabel(v)}
                <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
              </a>
            ) : (
              'A dev build has none'
            ),
          )}
          {row(
            'Image',
            v.imageTag ? <code className="font-mono">{v.imageTag}</code> : 'Built locally',
          )}
        </dl>
        {v.update ? (
          <div role="status" className="flex flex-col gap-2 border-t border-border pt-3.5 text-sm">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <IconRefresh aria-hidden="true" className="size-4 text-accent-ink" stroke={1.75} />
              <span className="font-semibold">v{v.update.version} available</span>
              <a
                href={v.update.url}
                target="_blank"
                rel="noreferrer noopener"
                className={linkClass}
              >
                Release notes
                <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
              </a>
            </p>
            <p className="text-xs text-muted-foreground">
              With the bundled compose file, set the version and recreate the container, or pull{' '}
              <code className="font-mono text-foreground">{v.update.imageTag}</code>.
            </p>
            <CopyCommand command={upgradeLine(v.update)} />
          </div>
        ) : null}
      </Panel>
      <SetBox>
        <SetRow
          icon={<IconInfoCircle stroke={1.75} />}
          title="Check for new releases"
          sub="Once a day Hinomi reads the latest release from GitHub, with no data sent beyond the request itself. It is the only call Hinomi makes that is not to a source you connected."
          aside={
            <Switch
              aria-label="Check for new releases"
              checked={check.enabled}
              disabled={check.mutation.isPending || check.settings.isPending}
              onCheckedChange={check.setEnabled}
            />
          }
        >
          <SaveStatus
            pending={check.mutation.isPending}
            saved={check.mutation.isSuccess}
            error={check.mutation.isError ? describeError(check.mutation.error) : null}
          />
        </SetRow>
      </SetBox>
    </>
  )
}
