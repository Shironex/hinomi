import { Fragment } from 'react'
import { Link } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconChevronRight,
  IconLoader2,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react'
import type { ScanStatus } from '@/hooks/use-shell-data'
import type { RouteMeta } from '@/lib/route-meta'
import { describeScanning } from '@/lib/scan-phases'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { BrandMark } from './brand-mark'

interface TopBarProps {
  crumbs: RouteMeta['crumbs']
  scan: ScanStatus
  onSearch: () => void
  /** Starts a scan. The button stays disabled until a handler exists. */
  onScan?: () => void
}

export function TopBar({ crumbs, scan, onSearch, onScan }: TopBarProps) {
  return (
    <header className="sticky top-0 z-10 flex min-h-[52px] items-center gap-3 border-b border-border bg-[color-mix(in_oklch,var(--background)_88%,transparent)] py-2.5 pr-[max(16px,env(safe-area-inset-right))] pl-[max(16px,env(safe-area-inset-left))] backdrop-blur-sm backdrop-saturate-[1.2] tab:pr-[max(24px,env(safe-area-inset-right))] tab:pl-[max(24px,env(safe-area-inset-left))]">
      <Link to="/" className="flex items-center gap-2 font-semibold text-foreground tab:hidden">
        <BrandMark size={20} />
        Hinomi
      </Link>
      <nav aria-label="Breadcrumb" className="hidden min-w-0 tab:block">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1
            return (
              <Fragment key={`${crumb.label}-${i}`}>
                <li className={last ? 'min-w-0' : undefined}>
                  {last || !crumb.to ? (
                    <span
                      aria-current={last ? 'page' : undefined}
                      className="block truncate font-medium text-foreground"
                    >
                      {crumb.label}
                    </span>
                  ) : (
                    <Link
                      to={crumb.to}
                      className="whitespace-nowrap text-muted-foreground hover:text-foreground"
                    >
                      {crumb.label}
                    </Link>
                  )}
                </li>
                {last ? null : (
                  <li aria-hidden="true">
                    <IconChevronRight className="size-3.5" stroke={1.75} />
                  </li>
                )}
              </Fragment>
            )
          })}
        </ol>
      </nav>
      <div className="flex-1" />
      <SearchTrigger onSearch={onSearch} />
      <ScanSlot scan={scan} onScan={onScan} />
    </header>
  )
}

function SearchTrigger({ onSearch }: { onSearch: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onSearch}
        className="hidden h-8 w-56 cursor-pointer items-center gap-2 rounded-md border border-input bg-card pr-2 pl-2.5 text-sm text-muted-foreground transition-colors hover:border-[color-mix(in_oklch,var(--input),var(--foreground)_15%)] hover:text-foreground desk:flex"
      >
        <IconSearch aria-hidden="true" className="size-4" stroke={1.75} />
        <span className="flex-1 text-left">Search alerts</span>
        <Kbd aria-hidden="true">/</Kbd>
      </button>
      <Button
        variant="ghost"
        size="icon-lg"
        onClick={onSearch}
        aria-label="Search alerts"
        className="-mr-1.5 tab:size-8 desk:hidden"
      >
        <IconSearch aria-hidden="true" stroke={1.75} />
      </Button>
    </>
  )
}

function ScanSlot({ scan, onScan }: { scan: ScanStatus; onScan?: (() => void) | undefined }) {
  // Nothing to scan before a source is connected; the sidebar links to setup instead.
  if (scan.state === 'unconfigured') return null
  if (scan.state === 'scanning' || scan.state === 'queued') {
    const detail = scan.state === 'scanning' ? describeScanning(scan) : 'First scan starting'
    return (
      <Button variant="outline" size="sm" disabled title={detail}>
        <IconLoader2 aria-hidden="true" className="animate-spin" />
        <span aria-live="polite">
          {scan.state === 'scanning' && scan.total > 0
            ? `Scanning ${scan.done} of ${scan.total}`
            : 'Scanning'}
        </span>
      </Button>
    )
  }
  return (
    <div className="flex items-center gap-2">
      {scan.state === 'failed' ? (
        <Badge variant="critical" title={scan.message}>
          <IconAlertTriangle aria-hidden="true" />
          Scan failed
        </Badge>
      ) : null}
      <Button variant="outline" size="sm" onClick={onScan} disabled={!onScan}>
        <IconRefresh aria-hidden="true" />
        Scan now
      </Button>
    </div>
  )
}
