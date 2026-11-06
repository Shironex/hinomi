import type { FindingTier } from '@hinomi/shared'
import { useEffect, useState } from 'react'
import { IconSearch } from '@tabler/icons-react'
import { SEVERITY_ICON } from '@/lib/view-icons'
import { Kbd } from '@/components/ui/kbd'
import { sourceFilter, sourceValue, type AlertsSearch } from '@/lib/alerts-search'
import { SEVERITIES, SEVERITY_LABEL, TIER_INFO } from '@/lib/finding-meta'
import { cn } from '@/lib/utils'

const DEPLOYED_TIERS: FindingTier[] = ['blind_spot', 'exposed', 'internal', 'public_low', 'dev']

type Patch = Partial<AlertsSearch>

function sameSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return (a?.length ?? 0) === b.length && b.every((v) => a?.includes(v))
}

function deployedValue(tier: readonly FindingTier[] | undefined): string {
  if (!tier?.length) return 'all'
  if (sameSet(tier, DEPLOYED_TIERS)) return 'deployed'
  if (sameSet(tier, ['not_deployed'])) return 'not'
  return 'tiers'
}

const SELECT =
  'h-7 min-w-0 rounded-full border border-input bg-card px-2 text-xs text-foreground focus-visible:outline-offset-[-1px]'

function single<T extends string>(values: readonly T[] | undefined): T | 'all' {
  return values?.length === 1 ? values[0]! : 'all'
}

/** Filters narrow the list, nothing is removed: every control maps to a query param. */
export function AlertsFilters({
  search,
  onChange,
}: {
  search: AlertsSearch
  onChange: (patch: Patch) => void
}) {
  const [q, setQ] = useState(search.q ?? '')
  const [urlQ, setUrlQ] = useState(search.q)

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

  return (
    <div
      role="search"
      aria-label="Filter alerts"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2.5"
    >
      <div role="group" aria-label="Severity" className="flex flex-wrap gap-2">
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
                'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
                pressed
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-input bg-card text-foreground-2 hover:bg-muted',
              )}
            >
              <IconCmp aria-hidden="true" className="size-[13px]" stroke={2} />
              {SEVERITY_LABEL[severity]}
            </button>
          )
        })}
      </div>

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
                  : value === 'all'
                    ? undefined
                    : search.tier,
          })
        }}
      >
        <option value="all">Deployed or not</option>
        <option value="deployed">Deployed</option>
        <option value="not">Not deployed</option>
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

      <div className="relative flex min-w-[180px] flex-1 items-center">
        <IconSearch
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
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
          placeholder="Package, advisory, repo or app"
          autoComplete="off"
          className="h-7 w-full min-w-0 rounded-full border border-input bg-card pr-8 pl-8 text-xs placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:outline-offset-[-1px]"
        />
        <Kbd aria-hidden="true" className="absolute right-2.5 max-tab:hidden">
          /
        </Kbd>
      </div>
    </div>
  )
}
