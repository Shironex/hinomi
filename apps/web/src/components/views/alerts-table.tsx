import type { FindingGroup, FindingListItem } from '@hinomi/shared'
import { useEffect, useRef } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { FindingStateText } from '@/components/findings/finding-state'
import { DECIDED_FILL } from '@/components/findings/finding-row'
import { RankMarker } from '@/components/findings/rank-marker'
import { BlindSpotBadge, ImageOnlyBadge, SeverityBadge } from '@/components/findings/severity-badge'
import {
  blindSpotSubject,
  factorFlags,
  findingTitle,
  formatAge,
  isDecided,
  SCOPE_LABEL,
  sourcesTitle,
  TIER_INFO,
  tierTitle,
} from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import type { RowGroup } from '@/lib/alerts-search'
import { cn } from '@/lib/utils'
import { SOURCE_ICON, sourceKey } from '@/lib/view-icons'

const number = new Intl.NumberFormat('en-US')

function groupTitle(group: RowGroup, by: FindingGroup): React.ReactNode {
  if (by === 'tier' && group.key in TIER_INFO) {
    const tier = group.key as keyof typeof TIER_INFO
    return (
      <>
        <span>{tierTitle(tier)}</span>
        <span className="font-normal text-muted-foreground tabular-nums">
          {number.format(group.count)} finding{group.count === 1 ? '' : 's'}
        </span>
        <span className="hidden font-normal text-muted-foreground desk:inline">
          {TIER_INFO[tier].hint}
        </span>
      </>
    )
  }
  return (
    <>
      <span className={by === 'none' ? '' : 'font-mono'}>{group.label}</span>
      <span className="font-normal text-muted-foreground tabular-nums">
        {number.format(group.count)} finding{group.count === 1 ? '' : 's'}
      </span>
    </>
  )
}

function GroupCheckbox({
  group,
  selected,
  onToggle,
}: {
  group: RowGroup
  selected: ReadonlySet<number>
  onToggle: (ids: number[], on: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const ids = group.items.map((i) => i.id)
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = !all && ids.some((id) => selected.has(id))
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some
  }, [some])
  if (ids.length === 0) return null
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      onChange={() => onToggle(ids, !all)}
      aria-label={`Select the ${ids.length} loaded in ${group.label || 'this list'}`}
      className="size-4 cursor-pointer accent-primary"
    />
  )
}

const TD = 'border-t border-border px-3 py-2.5 align-middle max-tab:border-0 max-tab:p-0'
const HIDE_CARD = 'max-tab:hidden'
const HIDE_MID = 'tab:max-desk:hidden'

function AlertRow({
  item,
  checked,
  onCheck,
}: {
  item: FindingListItem
  checked: boolean
  onCheck: (on: boolean) => void
}) {
  const navigate = useNavigate()
  const advisory = item.advisory
  const decided = isDecided(item.state)
  const SourceIcon = SOURCE_ICON[sourceKey(item.sources)]
  const name =
    item.kind === 'advisory' ? (advisory?.packageName ?? 'Advisory') : blindSpotSubject(item)
  return (
    <tr
      data-row
      data-finding-id={item.id}
      aria-selected={checked}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a, button, input, label')) return
        void navigate({ to: '/finding/$id', params: { id: String(item.id) } })
      }}
      className={cn(
        'cursor-pointer hover:bg-sidebar max-tab:grid max-tab:grid-cols-[24px_auto_minmax(0,1fr)] max-tab:items-center max-tab:gap-x-2.5 max-tab:gap-y-1.5 max-tab:border-t max-tab:border-border max-tab:p-3',
        checked && 'bg-accent hover:bg-accent',
        !checked && decided && DECIDED_FILL,
      )}
    >
      <td className={cn(TD, 'w-9 pr-0 max-tab:row-start-1')}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          aria-label={`Select ${name}${item.repo ? ` in ${item.repo.fullName}` : ''}`}
          className="size-4 cursor-pointer accent-primary"
        />
      </td>
      <td className={cn(TD, HIDE_CARD)}>
        <RankMarker
          flags={factorFlags(item)}
          strong={(item.tier === 'exposed' || item.tier === 'blind_spot') && !decided}
        />
      </td>
      <td className={cn(TD, 'max-tab:row-start-1')}>
        {item.kind === 'coverage_note' ? (
          <ImageOnlyBadge />
        ) : item.kind === 'blind_spot' ? (
          <BlindSpotBadge />
        ) : (
          <SeverityBadge severity={item.factors.severity} />
        )}
      </td>
      <td
        className={cn(TD, 'max-tab:col-span-2 max-tab:col-start-2 max-tab:row-start-2 tab:w-full')}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <b className="font-medium">
            <Link
              to="/finding/$id"
              params={{ id: String(item.id) }}
              data-row-link
              className="font-mono text-foreground hover:text-accent-ink"
            >
              {name}
            </Link>
            {item.kind === 'advisory' &&
            (item.installedVersion || advisory?.firstPatchedVersion) ? (
              <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                {item.installedVersion ?? '?'}
                {advisory?.firstPatchedVersion ? ` → ${advisory.firstPatchedVersion}` : ''}
              </span>
            ) : null}
          </b>
          <small className="text-xs text-muted-foreground">
            {findingTitle(item)}
            {item.kind === 'advisory' && !advisory?.firstPatchedVersion
              ? '. No patched version yet'
              : ''}
            {item.unscored ? '. Unscored, ranked as moderate' : ''}
          </small>
          <small className="text-xs text-muted-foreground tab:hidden">
            {[item.repo?.fullName, item.deployments.map((d) => d.name).join(', ')]
              .filter(Boolean)
              .join(', ')}
          </small>
        </span>
      </td>
      <td className={cn(TD, HIDE_CARD, 'text-sm whitespace-nowrap')}>
        {item.repo ? (
          <span className="font-mono text-[12.5px]">{item.repo.name}</span>
        ) : (
          <span className="text-muted-foreground">No repo</span>
        )}
        {item.deployments.length ? (
          <small className="block text-xs text-muted-foreground">
            {item.deployments[0]!.name}
            {item.deployments.length > 1 ? ` +${item.deployments.length - 1}` : ''}
          </small>
        ) : null}
      </td>
      <td className={cn(TD, HIDE_CARD, HIDE_MID, 'text-sm')}>
        {item.kind === 'advisory' ? SCOPE_LABEL[item.scope] : 'Coverage'}
      </td>
      <td className={cn(TD, HIDE_CARD, HIDE_MID)} title={sourcesTitle(item.sources)}>
        <SourceIcon
          aria-label={sourcesTitle(item.sources)}
          className="size-4 text-foreground-2"
          stroke={1.75}
        />
      </td>
      <td className={cn(TD, HIDE_CARD, HIDE_MID, 'text-sm text-muted-foreground tabular-nums')}>
        <time dateTime={item.firstSeenAt} title={`First seen ${formatRelative(item.firstSeenAt)}`}>
          {formatAge(item.firstSeenAt)}
        </time>
      </td>
      <td className={cn(TD, 'max-tab:col-start-3 max-tab:row-start-1 max-tab:justify-self-end')}>
        <FindingStateText item={item} table />
      </td>
    </tr>
  )
}

export function AlertsTable({
  groups,
  by,
  selected,
  onToggle,
  caption,
}: {
  groups: RowGroup[]
  by: FindingGroup
  selected: ReadonlySet<number>
  onToggle: (ids: number[], on: boolean) => void
  caption: string
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table data-list className="w-full border-collapse text-sm max-tab:block">
        <caption className="sr-only">{caption}</caption>
        <thead className="max-tab:hidden">
          <tr className="bg-sidebar text-left text-xs text-muted-foreground">
            <th scope="col" className="w-9 px-3 py-2 pr-0 font-medium">
              <span className="sr-only">Select</span>
            </th>
            <th scope="col" className="px-3 py-2 font-mono font-medium whitespace-nowrap">
              <span aria-hidden="true">S R D P</span>
              <span className="sr-only">Exposure factors</span>
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Severity
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Package and advisory
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Repo
            </th>
            <th scope="col" className={cn('px-3 py-2 font-medium', HIDE_MID)}>
              Dependency
            </th>
            <th scope="col" className={cn('px-3 py-2 font-medium', HIDE_MID)}>
              Source
            </th>
            <th scope="col" className={cn('px-3 py-2 font-medium', HIDE_MID)}>
              Age
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              State
            </th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key} className="max-tab:block">
            {by !== 'none' ? (
              <tr className="bg-sidebar text-xs font-medium text-foreground-2 max-tab:flex max-tab:items-center max-tab:border-t max-tab:border-border">
                <td className="w-9 border-t border-border px-3 py-2 pr-0 max-tab:border-0">
                  <GroupCheckbox group={group} selected={selected} onToggle={onToggle} />
                </td>
                <td
                  colSpan={8}
                  className="border-t border-border px-3 py-2 max-tab:border-0 max-tab:pl-0"
                >
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {by === 'tier' && group.key === 'blind_spot' ? (
                      <BlindSpotBadge label={String(group.count)} />
                    ) : null}
                    {groupTitle(group, by)}
                    {by === 'tier' && group.key === 'exposed' ? (
                      <Link to="/" className="ml-auto font-normal text-accent-ink hover:underline">
                        Open exposure view
                      </Link>
                    ) : null}
                  </span>
                </td>
              </tr>
            ) : null}
            {group.items.map((item) => (
              <AlertRow
                key={item.id}
                item={item}
                checked={selected.has(item.id)}
                onCheck={(on) => onToggle([item.id], on)}
              />
            ))}
            {group.items.length < group.count ? (
              <tr className="max-tab:block">
                <td
                  colSpan={9}
                  className="border-t border-border px-3 py-2 text-center text-xs text-muted-foreground max-tab:block"
                >
                  {number.format(group.count - group.items.length)} more in this group, load more
                  below
                </td>
              </tr>
            ) : null}
          </tbody>
        ))}
      </table>
    </div>
  )
}
