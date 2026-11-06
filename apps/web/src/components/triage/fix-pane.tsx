import { FINDING_TIERS, type FixItem } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconLock, IconPackage, IconRobot, IconServer2, IconWorld } from '@tabler/icons-react'
import { SeverityCounts } from '@/components/findings/severity-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { displayDomain, TIER_INFO } from '@/lib/finding-meta'
import { findingsQuery } from '@/lib/view-api'
import { FIX_AGENT_NOTE, joinAnd } from '@/lib/triage'
import { FixBox, PaneSection } from './finding-sections'
import { TriageRow } from './triage-row'

const number = new Intl.NumberFormat('en-US')

/** Where a fix lands: its apps, or its repos when nothing runs them. */
function fixWhere(fix: FixItem): string {
  if (fix.apps.length)
    return joinAnd(
      fix.apps.map((a) => a.name),
      2,
    )
  return (
    joinAnd(
      fix.repos.map((r) => r.repo.name),
      2,
    ) || 'Not deployed'
  )
}

/** One bump in the By fix list: package and target, how many findings it clears, where. */
export function FixRow({ fix, rank }: { fix: FixItem; rank: number }) {
  return (
    <span className="grid grid-cols-[24px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-1">
      <span className="row-span-2 pt-[3px] font-mono text-xs text-muted-foreground tabular-nums">
        {rank}
      </span>
      <span className="min-w-0 truncate pt-0.5 font-mono text-sm font-semibold text-foreground">
        {fix.packageName}{' '}
        {fix.target ? (
          <>
            <span aria-label="to">→</span>{' '}
            <b className="font-semibold text-success">{fix.target}</b>
          </>
        ) : (
          <span className="font-normal text-muted-foreground">no patch yet</span>
        )}
      </span>
      <span className="text-right text-md font-semibold text-accent-ink tabular-nums">
        {number.format(fix.findings.total)}
        <span className="sr-only"> findings cleared, </span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {fixWhere(fix)}
        {fix.exposedCritical ? (
          <span className="ml-2 font-medium text-sev-critical">exposed critical</span>
        ) : null}
      </span>
      <span aria-hidden="true" className="text-right text-xs text-muted-foreground">
        cleared
      </span>
    </span>
  )
}

/** Tiers with findings, most urgent first, with how many the bump clears in each. */
function TierCounts({ fix }: { fix: FixItem }) {
  const rows = FINDING_TIERS.filter((t) => (fix.findings.byTier[t] ?? 0) > 0)
  return (
    <ul className="m-0 flex list-none flex-col p-0 text-sm">
      {rows.map((tier) => (
        <li
          key={tier}
          className="flex items-baseline justify-between gap-3 border-t border-border py-2 first:border-t-0 first:pt-0"
        >
          <span className="text-foreground-2">{TIER_INFO[tier].name}</span>
          <b className="font-semibold tabular-nums">
            {number.format(fix.findings.byTier[tier] ?? 0)}
          </b>
        </li>
      ))}
    </ul>
  )
}

/** The findings the bump clears, as rows into their own detail. */
function ClearedFindings({ fix }: { fix: FixItem }) {
  const query = useQuery(
    findingsQuery({
      q: fix.packageName,
      repo: fix.repos.map((r) => r.repo.id),
      kind: ['advisory'],
      state: ['open'],
      limit: 50,
    }),
  )
  const wanted = new Set(fix.findingIds)
  const items = (query.data?.items ?? []).filter((i) => wanted.has(i.id))
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading the findings</p>
  if (!items.length) return null
  return (
    <PaneSection
      title="What it clears"
      aside={
        items.length < fix.findingIds.length
          ? `${items.length} of ${number.format(fix.findingIds.length)} shown`
          : undefined
      }
    >
      <ul className="m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0">
        {items.map((item) => (
          <li key={item.id} className="border-t border-border first:border-t-0">
            <Link
              to="/finding/$id"
              params={{ id: String(item.id) }}
              className="block px-[18px] py-3 text-inherit no-underline hover:bg-muted"
            >
              <TriageRow item={item} />
            </Link>
          </li>
        ))}
      </ul>
    </PaneSection>
  )
}

/** The detail of one bump: what it clears, in which repos (with each repo's own target) and apps. */
export function FixPane({ fix, focused }: { fix: FixItem; focused: boolean }) {
  const repos = fix.repos.length
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
          <Badge variant="accent">
            <IconPackage aria-hidden="true" />
            Fix
          </Badge>
          <span>{fix.ecosystem}</span>
          {fix.exposedCritical ? (
            <span className="font-medium text-sev-critical">Clears an exposed critical</span>
          ) : null}
        </div>
        <h1 className={focused ? 'text-lg tab:text-xl' : 'text-lg'}>
          {fix.target ? (
            <>
              Upgrade <span className="font-mono">{fix.packageName}</span> to{' '}
              <span className="font-mono text-success">{fix.target}</span>
            </>
          ) : (
            <>
              <span className="font-mono">{fix.packageName}</span> has no patched version yet
            </>
          )}
        </h1>
        <p className="max-w-[68ch] text-foreground-2">
          {fix.target
            ? `One upgrade clears ${number.format(fix.findings.total)} open finding${fix.findings.total === 1 ? '' : 's'} in ${repos} repo${repos === 1 ? '' : 's'}${fix.apps.length ? ` and ${fix.apps.length} app${fix.apps.length === 1 ? '' : 's'}` : ''}.`
            : `${number.format(fix.findings.total)} open finding${fix.findings.total === 1 ? '' : 's'} wait for a release. Snooze them until a new advisory, or replace the package.`}
          {fix.mixedTargets
            ? ' Repos need different versions; the highest clears them all, and each repo lists its own below.'
            : ''}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {fix.target ? (
            <Button disabled title={FIX_AGENT_NOTE} aria-describedby="fix-pane-note">
              <IconRobot aria-hidden="true" />
              Run fix agent
            </Button>
          ) : null}
          <SeverityCounts counts={fix.findings.bySeverity} />
          <span id="fix-pane-note" className="text-xs text-muted-foreground">
            {fix.target ? FIX_AGENT_NOTE : null}
          </span>
        </div>
      </div>
      <FixBox>
        <h2 className="text-base">By tier</h2>
        <TierCounts fix={fix} />
      </FixBox>
      <PaneSection
        title="Repos"
        aside={fix.mixedTargets ? 'Each needs its own version' : undefined}
      >
        <ul className="m-0 flex list-none flex-col p-0">
          {fix.repos.map((r) => (
            <li
              key={r.repo.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-t border-border py-2.5 text-sm first:border-t-0 first:pt-0"
            >
              <Link
                to="/alerts"
                search={{ repo: [r.repo.id], q: fix.packageName }}
                className="truncate font-mono font-medium text-foreground hover:underline"
              >
                {r.repo.fullName}
              </Link>
              <span className="text-muted-foreground tabular-nums">
                {number.format(r.findings)} finding{r.findings === 1 ? '' : 's'}
              </span>
              <span className="col-span-2 text-xs text-muted-foreground">
                {r.target ? (
                  <>
                    Needs <span className="font-mono text-success">{r.target}</span>
                  </>
                ) : (
                  'No patched version yet'
                )}
              </span>
            </li>
          ))}
        </ul>
      </PaneSection>
      <PaneSection title="Apps" aside={fix.apps.length ? undefined : 'None deployed'}>
        {fix.apps.length ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {fix.apps.map((d) => {
              const Icon = d.reach === 'public' ? IconWorld : IconLock
              return (
                <li
                  key={d.id}
                  className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-t border-border py-2.5 first:border-t-0 first:pt-0"
                >
                  <Icon aria-hidden="true" className="size-4 text-muted-foreground" stroke={1.75} />
                  <Link
                    to="/deployments/$id"
                    params={{ id: String(d.id) }}
                    className="truncate font-semibold text-foreground hover:underline"
                  >
                    {d.name}
                  </Link>
                  {d.server ? (
                    <Badge variant="default">
                      <IconServer2 aria-hidden="true" />
                      {d.server}
                    </Badge>
                  ) : (
                    <span />
                  )}
                  <small className="col-start-2 text-xs text-muted-foreground">
                    {d.domains.map(displayDomain).join(', ') || 'Internal only'}
                  </small>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No deployment runs these repos. The bump still counts: a repo with no deployment can
            ship later.
          </p>
        )}
      </PaneSection>
      <ClearedFindings fix={fix} />
    </>
  )
}
