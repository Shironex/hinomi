import { useId } from 'react'
import type { ReleaseTierMode, RepoDetail } from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconExternalLink,
  IconGitMerge,
  IconLoader2,
  IconPackage,
  IconRocket,
  IconWand,
} from '@tabler/icons-react'
import { SegmentedChoice, type SegmentedOption } from '@/components/form/segmented-choice'
import { Badge } from '@/components/ui/badge'
import { Callout } from '@/components/ui/callout'
import { Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import { describeError } from '@/lib/errors'
import { formatDate } from '@/lib/finding-meta'
import { formatRelative, plural } from '@/lib/format'
import {
  FIXED_ON_MAIN_HINT,
  FIXED_ON_MAIN_LABEL,
  releaseUrl,
  releaseVerdict,
  TIER_MODE_INFO,
} from '@/lib/release-meta'
import { settingsKeys, updateRepoReleaseTier } from '@/lib/settings-api'
import { refreshAfterDecision } from '@/lib/view-api'

const MODE_OPTIONS: readonly SegmentedOption<ReleaseTierMode>[] = [
  { value: 'auto', label: TIER_MODE_INFO.auto.label, icon: IconWand },
  { value: 'on', label: TIER_MODE_INFO.on.label, icon: IconCheck },
  { value: 'off', label: TIER_MODE_INFO.off.label, icon: IconBan },
]

/** How many installer names to list before "and N more". */
const ASSETS_SHOWN = 4

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-1 py-3 text-sm first:pt-0 last:pb-0 tab:grid-cols-[132px_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  )
}

function LatestRelease({ repo }: { repo: RepoDetail }) {
  const { release } = repo
  if (!release.latestTag) {
    return (
      <span className="text-foreground-2">
        {release.status === 'not_checked' ? 'Not checked yet' : 'No final release on GitHub'}
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <a
        href={releaseUrl(repo.fullName, release.latestTag)}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 font-mono text-sm font-medium text-accent-ink underline-offset-2 hover:underline"
      >
        {release.latestTag}
        <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
        <span className="sr-only">(opens on GitHub)</span>
      </a>
      {release.latestAt ? (
        <time
          dateTime={release.latestAt}
          title={formatRelative(release.latestAt)}
          className="text-foreground-2"
        >
          {formatDate(release.latestAt)}
        </time>
      ) : null}
    </span>
  )
}

function Installers({ release }: { release: RepoDetail['release'] }) {
  if (release.installers === null) {
    return <span className="text-foreground-2">Not checked yet</span>
  }
  if (!release.installers) {
    return (
      <span className="text-foreground-2">
        No installer files, only source archives or nothing uploaded
      </span>
    )
  }
  const shown = release.installerAssets.slice(0, ASSETS_SHOWN)
  const more = release.installerAssets.length - shown.length
  return (
    <span className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <IconPackage aria-hidden="true" className="size-3.5 text-foreground-2" stroke={1.75} />
        Has installers
      </span>
      {shown.length > 0 ? (
        <ul aria-label="Installer files" className="m-0 flex list-none flex-col gap-0.5 p-0">
          {shown.map((name) => (
            <li key={name} className="truncate font-mono text-xs text-foreground-2" title={name}>
              {name}
            </li>
          ))}
          {more > 0 ? <li className="text-xs text-muted-foreground">and {more} more</li> : null}
        </ul>
      ) : null}
    </span>
  )
}

function FindingsLine({ repo }: { repo: RepoDetail }) {
  const { release } = repo
  if (release.status !== 'released' && release.openFindings === 0) {
    return <span className="text-foreground-2">Nothing scanned at a release tag</span>
  }
  const waiting = release.fixedOnDefaultBranch
  return (
    <span className="flex flex-col gap-1">
      <span>
        {release.openFindings === 0
          ? `No open advisories in ${release.latestTag ?? 'the latest release'}`
          : `${plural(release.openFindings, 'open advisory', 'open advisories')} in ${release.latestTag ?? 'the latest release'}`}
      </span>
      {waiting > 0 ? (
        <span className="inline-flex items-start gap-1.5 font-medium" title={FIXED_ON_MAIN_HINT}>
          <IconGitMerge
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-success"
            stroke={1.75}
          />
          <span>
            {waiting} of them: {FIXED_ON_MAIN_LABEL.toLowerCase()}
          </span>
        </span>
      ) : null}
      {release.openFindings > 0 ? (
        <Link
          to="/alerts"
          search={{ repo: [repo.id] }}
          className="w-fit text-xs text-accent-ink underline-offset-2 hover:underline"
        >
          See them in All alerts
        </Link>
      ) : null}
    </span>
  )
}

/**
 * The desktop release tier of one repo: the latest release, whether it ships installers, the
 * tier it lands in and why, and the mode that overrides the installer check. A repo with a
 * deployment keeps its deploy tiers, and the panel says so.
 */
export function ReleasePanel({ repo }: { repo: RepoDetail }) {
  const queryClient = useQueryClient()
  const headingId = useId()
  const { release } = repo
  const verdict = releaseVerdict(release)
  const mutation = useMutation({
    mutationFn: (tier: ReleaseTierMode) => updateRepoReleaseTier(repo.id, { tier }),
    onSuccess: async (next) => {
      queryClient.setQueryData(settingsKeys.repo(repo.id), next)
      // Turning the tier on or off resolves or opens release findings on the next scan, and
      // the repo list and every finding view read the tier.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsKeys.repo(repo.id) }),
        queryClient.invalidateQueries({ queryKey: settingsKeys.repos }),
        refreshAfterDecision(queryClient),
      ])
    },
  })
  const mode = mutation.isPending && mutation.variables ? mutation.variables : release.tier

  return (
    <section aria-labelledby={headingId}>
      <Panel>
        <PanelHeader title={<span id={headingId}>Release</span>} icon={IconRocket}>
          <Badge variant={verdict.released ? 'success' : 'outline'}>
            {verdict.released ? (
              <IconCheck aria-hidden="true" stroke={2} />
            ) : (
              <IconBan aria-hidden="true" stroke={2} />
            )}
            {verdict.title}
          </Badge>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-4">
          <p className="max-w-[68ch] text-sm text-foreground-2">{verdict.why}</p>
          <dl className="m-0 flex flex-col divide-y divide-border">
            <Row label="Latest release">
              <LatestRelease repo={repo} />
            </Row>
            <Row label="Installers">
              <Installers release={release} />
            </Row>
            <Row label="Findings">
              <FindingsLine repo={repo} />
            </Row>
            <Row label="Last checked">
              <span className="text-foreground-2">
                {release.checkedAt ? formatRelative(release.checkedAt) : 'Never'}
              </span>
            </Row>
          </dl>
          {release.lockfileMissing ? (
            <Callout variant="warn" icon={IconAlertTriangle} title="No lockfile at this tag">
              Hinomi found no lockfile it reads in {release.latestTag ?? 'the latest release'}, so
              the released version is not checked.
            </Callout>
          ) : null}
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <div className="flex items-center gap-2">
              <SegmentedChoice
                legend="Release tier"
                options={MODE_OPTIONS}
                value={mode}
                disabled={mutation.isPending}
                onChange={(next) => {
                  if (next !== release.tier) mutation.mutate(next)
                }}
              />
              {mutation.isPending ? (
                <IconLoader2
                  aria-label="Saving"
                  className="mt-6 size-3.5 text-muted-foreground motion-safe:animate-spin"
                />
              ) : null}
            </div>
            <p className="max-w-[68ch] text-xs text-muted-foreground">
              {TIER_MODE_INFO[mode].hint}
            </p>
            {mutation.isError ? (
              <p role="alert" className="text-sm text-sev-critical">
                The tier did not save: {describeError(mutation.error)}
              </p>
            ) : null}
          </div>
        </PanelBody>
      </Panel>
    </section>
  )
}
