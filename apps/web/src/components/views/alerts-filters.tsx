import {
  GUARD_CHECKS,
  GUARD_COPY,
  type FindingGroup,
  type FindingKind,
  type FindingTier,
  type GuardCheck,
  type GuardLevel,
} from '@hinomi/shared'
import { useEffect, useId, useState } from 'react'
import { IconCheck, IconFilter, IconSearch } from '@tabler/icons-react'
import { Kbd } from '@/components/ui/kbd'
import { DEFAULT_GROUP, sourceFilter, sourceValue, type AlertsSearch } from '@/lib/alerts-search'
import { SEVERITIES, SEVERITY_LABEL, TIER_INFO } from '@/lib/finding-meta'
import { GUARD_LEVEL_LABEL, GUARD_LEVELS_WORST_FIRST } from '@/lib/guard-meta'
import { cn } from '@/lib/utils'
import { SEVERITY_ICON } from '@/lib/view-icons'

const DEPLOYED_TIERS: FindingTier[] = ['blind_spot', 'exposed', 'internal', 'public_low', 'dev']

type Patch = Partial<AlertsSearch>

function sameSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return (a?.length ?? 0) === b.length && b.every((v) => a?.includes(v))
}

function deployedValue(tier: readonly FindingTier[] | undefined): string {
  if (!tier?.length) return 'all'
  if (sameSet(tier, DEPLOYED_TIERS)) return 'deployed'
  if (sameSet(tier, ['not_deployed'])) return 'not'
  if (sameSet(tier, ['released'])) return 'released'
  return 'tiers'
}

const SELECT =
  'h-[30px] w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm text-foreground focus-visible:outline-offset-[-1px]'

function single<T extends string>(values: readonly T[] | undefined): T | 'all' {
  return values?.length === 1 ? values[0]! : 'all'
}

const GROUPS: { value: FindingGroup; label: string }[] = [
  { value: 'tier', label: 'Tier' },
  { value: 'repo', label: 'Repo' },
  { value: 'advisory', label: 'Advisory' },
]

const KINDS: { value: FindingKind; label: string }[] = [
  { value: 'advisory', label: 'Advisories' },
  { value: 'guard', label: 'Guards' },
  { value: 'blind_spot', label: 'Blind spots' },
  { value: 'coverage_note', label: 'Coverage notes' },
]

/** The filters behind "more filters". */
const MORE_FILTERS = ['tier', 'scope', 'source', 'state', 'kind', 'check', 'level'] as const

/** How many of the filters behind "more filters" narrow the list. */
function moreActive(search: AlertsSearch): number {
  return MORE_FILTERS.filter((key) => search[key]?.length).length
}

/**
 * The filters of the alerts list pane: search, severity chips, and the rest behind a "more
 * filters" toggle. Every control maps to a query param, so a filtered view is a link.
 */
export function AlertsFilters({
  search,
  onChange,
}: {
  search: AlertsSearch
  onChange: (patch: Patch) => void
}) {
  const id = useId()
  const [q, setQ] = useState(search.q ?? '')
  const [urlQ, setUrlQ] = useState(search.q)
  const active = moreActive(search)
  const [open, setOpen] = useState(active > 0)

  // Typing updates the URL a beat later; a URL change from elsewhere resets the field.
  if (search.q !== urlQ) {
    setUrlQ(search.q)
    setQ(search.q ?? '')
  }
  useEffect(() => {
    if ((search.q ?? '') === q) return
    const timer = setTimeout(() => onChange({ q: q.trim() ? q : undefined }), 250)
    return () => clearTimeout(timer)
  }, [q, search.q, onChange])

  const severities = search.severity ?? []
  const deployed = deployedValue(search.tier)
  const group = search.group ?? DEFAULT_GROUP

  return (
    <div role="search" aria-label="Filter alerts" className="flex flex-col gap-2.5">
      <div className="relative flex items-center">
        <IconSearch
          aria-hidden="true"
          className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
          stroke={1.75}
        />
        <label htmlFor="alert-search" className="sr-only">
          Search alerts
        </label>
        <input
          id="alert-search"
          type="search"
          data-search-input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          placeholder="Package, repo or summary"
          autoComplete="off"
          className="h-[34px] w-full min-w-0 rounded-md border border-input bg-card pr-9 pl-9 text-sm placeholder:text-muted-foreground focus-visible:outline-offset-[-1px]"
        />
        <Kbd aria-hidden="true" className="absolute right-2.5 max-tab:hidden">
          /
        </Kbd>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label="Severity" className="flex flex-wrap gap-1.5">
          {SEVERITIES.map((severity) => {
            const IconCmp = SEVERITY_ICON[severity]
            // No severity picked means all of them: every chip reads as on.
            const pressed = severities.length === 0 || severities.includes(severity)
            return (
              <button
                key={severity}
                type="button"
                aria-pressed={pressed}
                onClick={() => {
                  const base = severities.length === 0 ? [...SEVERITIES] : severities
                  const next = pressed ? base.filter((s) => s !== severity) : [...base, severity]
                  onChange({
                    severity:
                      next.length === 0 || next.length === SEVERITIES.length ? undefined : next,
                  })
                }}
                className={cn(
                  'inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold',
                  pressed
                    ? 'border-transparent bg-accent text-accent-ink'
                    : 'border-input bg-card text-foreground-2 hover:bg-muted',
                )}
              >
                {pressed ? (
                  <IconCheck aria-hidden="true" className="size-3.5" stroke={2.2} />
                ) : (
                  <IconCmp aria-hidden="true" className="size-3.5" stroke={2} />
                )}
                {SEVERITY_LABEL[severity]}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-more`}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold',
            active
              ? 'border-transparent bg-accent text-accent-ink'
              : 'border-input bg-card text-foreground-2 hover:bg-muted',
          )}
        >
          <IconFilter aria-hidden="true" className="size-3.5" stroke={2} />
          {active ? `${active} more on` : `${MORE_FILTERS.length} more filters`}
        </button>
      </div>

      {open ? (
        <div id={`${id}-more`} className="grid grid-cols-2 gap-2">
          <select
            aria-label="Deployment"
            className={SELECT}
            value={deployed}
            onChange={(e) => {
              const value = e.target.value
              onChange({
                tier:
                  value === 'deployed'
                    ? DEPLOYED_TIERS
                    : value === 'not'
                      ? ['not_deployed']
                      : value === 'released'
                        ? ['released']
                        : value === 'all'
                          ? undefined
                          : search.tier,
              })
            }}
          >
            <option value="all">Deployed or not</option>
            <option value="deployed">Deployed</option>
            <option value="not">Not deployed</option>
            <option value="released">{TIER_INFO.released.name}</option>
            {deployed === 'tiers' ? (
              <option value="tiers">{search.tier?.map((t) => TIER_INFO[t].name).join(', ')}</option>
            ) : null}
          </select>

          <select
            aria-label="Dependency type"
            className={SELECT}
            value={single(search.scope)}
            onChange={(e) =>
              onChange({
                scope: e.target.value === 'all' ? undefined : [e.target.value as 'runtime' | 'dev'],
              })
            }
          >
            <option value="all">Runtime and dev</option>
            <option value="runtime">Runtime</option>
            <option value="dev">Dev</option>
            <option value="unknown">Unknown scope</option>
          </select>

          <select
            aria-label="Source"
            className={SELECT}
            value={sourceValue(search)}
            onChange={(e) => onChange(sourceFilter(e.target.value))}
          >
            <option value="all">Any source</option>
            <option value="github">Reported by GitHub</option>
            <option value="osv">Reported by OSV</option>
            <option value="both">Reported by both</option>
          </select>

          <select
            aria-label="State"
            className={SELECT}
            value={single(search.state)}
            onChange={(e) =>
              onChange({
                state: e.target.value === 'all' ? undefined : [e.target.value as 'open'],
              })
            }
          >
            <option value="all">Any state but fixed</option>
            <option value="open">Open</option>
            <option value="snoozed">Snoozed</option>
            <option value="accepted">Risk accepted</option>
            <option value="dismissed_upstream">Dismissed on GitHub</option>
            <option value="fixing">Fix in progress</option>
            <option value="fixed">Fixed</option>
          </select>

          <select
            aria-label="Kind"
            className={SELECT}
            value={single(search.kind)}
            onChange={(e) =>
              onChange({
                kind: e.target.value === 'all' ? undefined : [e.target.value as FindingKind],
              })
            }
          >
            <option value="all">Any kind</option>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Guard level"
            className={SELECT}
            value={single(search.level)}
            onChange={(e) =>
              onChange({
                level: e.target.value === 'all' ? undefined : [e.target.value as GuardLevel],
              })
            }
          >
            <option value="all">Any guard level</option>
            {GUARD_LEVELS_WORST_FIRST.map((level) => (
              <option key={level} value={level}>
                {GUARD_LEVEL_LABEL[level]}
              </option>
            ))}
          </select>

          <select
            aria-label="Guard check"
            className={cn(SELECT, 'col-span-2')}
            value={single(search.check)}
            onChange={(e) =>
              onChange({
                check: e.target.value === 'all' ? undefined : [e.target.value as GuardCheck],
              })
            }
          >
            <option value="all">Any guard check</option>
            {GUARD_CHECKS.map((check) => (
              <option key={check} value={check}>
                {GUARD_COPY[check].title}
              </option>
            ))}
          </select>

          <label className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
            Group by
            <select
              className={cn(SELECT, 'w-auto flex-1')}
              value={group}
              onChange={(e) => {
                const g = e.target.value as FindingGroup
                onChange({ group: g === DEFAULT_GROUP ? undefined : g })
              }}
            >
              {GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
              <option value="none">No groups</option>
            </select>
          </label>
        </div>
      ) : null}
    </div>
  )
}
