import type { FindingListItem } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import { IconClock, IconLock, IconServer2, IconWorld } from '@tabler/icons-react'
import { FindingStateText } from './finding-state'
import { RankMarker } from './rank-marker'
import { BlindSpotBadge, ImageOnlyBadge, SeverityBadge } from './severity-badge'
import { SourceBadge } from './source-badge'
import {
  blindSpotSubject,
  displayDomain,
  factorFlags,
  findingTitle,
  isDecided,
  VERSION_UNKNOWN,
  VERSION_UNKNOWN_HINT,
} from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Hatched fill for snoozed and accepted rows: still listed, visibly decided. */
export const DECIDED_FILL =
  'bg-[repeating-linear-gradient(135deg,transparent_0_8px,color-mix(in_oklch,var(--muted)_45%,transparent)_8px_9px)]'

function Where({ item }: { item: FindingListItem }) {
  const deployments = item.deployments
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      {deployments.length > 0 ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {deployments.some((d) => d.reach === 'public') ? (
            <IconWorld aria-hidden="true" className="size-3.5 shrink-0" stroke={1.75} />
          ) : (
            <IconLock aria-hidden="true" className="size-3.5 shrink-0" stroke={1.75} />
          )}
          <span className="min-w-0">
            {deployments
              .map((d) => (d.domains[0] ? `${d.name} (${displayDomain(d.domains[0])})` : d.name))
              .join(', ')}
          </span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <IconServer2 aria-hidden="true" className="size-3.5" stroke={1.75} />
          Not deployed
        </span>
      )}
      {item.kind === 'advisory' && item.repo ? (
        <span className="font-mono">{item.repo.fullName}</span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <IconClock aria-hidden="true" className="size-3.5" stroke={1.75} />
        First seen {formatRelative(item.firstSeenAt)}
      </span>
      {item.kind === 'advisory' ? <SourceBadge sources={item.sources} /> : null}
    </div>
  )
}

/**
 * One ranked finding on the exposure list and deployment pages: rank, the four box marker,
 * package and fix, summary, where it runs, and its state. The summary link covers the row.
 */
export function FindingRow({ item, rank }: { item: FindingListItem; rank?: number }) {
  const decided = isDecided(item.state)
  const flags = factorFlags(item)
  const exposedLike = item.tier === 'exposed' || item.tier === 'blind_spot'
  const advisory = item.advisory
  return (
    <div
      data-row
      className={cn(
        'relative grid grid-cols-[minmax(0,1fr)] items-center gap-2.5 border-t border-border p-3.5 first:border-t-0 hover:bg-sidebar tab:grid-cols-[28px_46px_minmax(0,1fr)_auto] tab:gap-3.5 tab:px-4',
        decided && DECIDED_FILL,
      )}
    >
      <span className="hidden text-right font-mono text-sm text-muted-foreground tab:block">
        {rank ?? ''}
      </span>
      <RankMarker
        flags={flags}
        strong={exposedLike && !decided}
        className="hidden tab:inline-grid"
      />
      <div className="flex min-w-0 flex-col gap-[5px]">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {item.kind === 'coverage_note' ? (
            <>
              <ImageOnlyBadge />
              <span className="font-mono text-sm font-medium">{blindSpotSubject(item)}</span>
              <span className="text-xs text-muted-foreground">covered by the image scan later</span>
            </>
          ) : item.kind === 'blind_spot' ? (
            <>
              <BlindSpotBadge />
              <span className="font-mono text-sm font-medium">{blindSpotSubject(item)}</span>
              <span className="text-xs text-muted-foreground">ranked like a critical</span>
            </>
          ) : (
            <>
              <SeverityBadge severity={item.factors.severity} />
              <span className="font-mono text-sm font-medium">{advisory?.packageName}</span>
              {item.installedVersion || advisory?.firstPatchedVersion ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {item.installedVersion ?? (
                    <span title={VERSION_UNKNOWN_HINT}>{VERSION_UNKNOWN}</span>
                  )}
                  {advisory?.firstPatchedVersion ? (
                    <>
                      {' '}
                      <span aria-label="patched in">→</span>{' '}
                      <b className="font-medium text-success">{advisory.firstPatchedVersion}</b>
                    </>
                  ) : (
                    ', no patch yet'
                  )}
                </span>
              ) : null}
              {advisory?.cvssScore != null ? (
                <span className="font-mono text-[11px] text-muted-foreground">
                  CVSS {advisory.cvssScore.toFixed(1)}
                </span>
              ) : null}
              {item.stopped ? (
                <span className="text-xs text-muted-foreground">every deployment stopped</span>
              ) : null}
            </>
          )}
        </div>
        <Link
          to="/finding/$id"
          params={{ id: String(item.id) }}
          data-row-link
          className="block text-base text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-[-2px] max-tab:whitespace-normal tab:truncate"
        >
          {findingTitle(item)}
        </Link>
        <Where item={item} />
      </div>
      <div className="flex items-center justify-between gap-1.5 tab:flex-col tab:items-end">
        <FindingStateText item={item} />
        {decided && item.stateReason ? (
          <span
            className="max-w-[28ch] truncate text-xs text-muted-foreground"
            title={item.stateReason}
          >
            {item.stateReason}
          </span>
        ) : null}
      </div>
    </div>
  )
}
