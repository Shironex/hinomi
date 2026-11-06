import { Fragment } from 'react'
import { Link } from '@tanstack/react-router'
import { IconAlertTriangle, IconLoader2, IconPlugConnected, IconRefresh } from '@tabler/icons-react'
import type { ScanStatus } from '@/hooks/use-shell-data'
import { formatClock, formatRelative } from '@/lib/format'
import { describeScanning } from '@/lib/scan-phases'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AccessStatusLink } from './access-status'
import { BrandMark } from './brand-mark'
import { useShell } from './shell-context'

interface TopBarProps {
  /** Appended to the route's breadcrumb, for the item selected in a split view. */
  extraCrumb?: string | undefined
  className?: string
}

/**
 * The top bar: breadcrumb, scan status, access status and Scan now. Page routes get it across
 * the content column; split routes draw it over their detail pane from 1100 px. Below 761 px it
 * becomes the phone header (brand, page name, icon buttons).
 */
export function TopBar({ extraCrumb, className }: TopBarProps) {
  const { meta, scan, startScan } = useShell()
  const crumbs = extraCrumb ? [...meta.crumbs, { label: extraCrumb }] : meta.crumbs
  const title = crumbs.at(-1)?.label ?? 'Hinomi'
  return (
    <header
      className={cn(
        'flex min-h-[58px] shrink-0 items-center gap-3 border-b border-border text-sm text-foreground-2',
        'bg-sidebar py-2 pr-[max(16px,env(safe-area-inset-right))] pl-[max(16px,env(safe-area-inset-left))]',
        'tab:bg-background tab:py-3 tab:pr-[max(28px,env(safe-area-inset-right))] tab:pl-7',
        className,
      )}
    >
      <Link to="/" aria-label="Hinomi" className="rounded-md tab:hidden">
        <BrandMark size={28} />
      </Link>
      <span className="min-w-0 truncate text-md font-semibold text-foreground tab:hidden">
        {title}
      </span>
      <nav aria-label="Breadcrumb" className="hidden min-w-0 tab:block">
        <ol className="flex min-w-0 items-center gap-2.5">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1
            return (
              <Fragment key={`${crumb.label}-${i}`}>
                <li className={last ? 'min-w-0' : 'shrink-0'}>
                  {last || !crumb.to ? (
                    <span
                      aria-current={last ? 'page' : undefined}
                      className={cn('block truncate', last && 'text-foreground')}
                    >
                      {crumb.label}
                    </span>
                  ) : (
                    <Link
                      to={crumb.to}
                      className="whitespace-nowrap text-accent-ink hover:underline"
                    >
                      {crumb.label}
                    </Link>
                  )}
                </li>
                {last ? null : (
                  <li aria-hidden="true" className="text-muted-foreground">
                    /
                  </li>
                )}
              </Fragment>
            )
          })}
        </ol>
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-1 tab:gap-3">
        <ScanState scan={scan} />
        <AccessStatusLink />
        <ScanButton scan={scan} onScan={startScan} />
      </div>
    </header>
  )
}

/** Last scan in words. Hidden on the phone header, where the rail dot is not shown either. */
function ScanState({ scan }: { scan: ScanStatus }) {
  const base = 'hidden items-center gap-2 whitespace-nowrap desk:flex'
  if (scan.state === 'unconfigured') {
    return (
      <Link to="/onboarding" className={cn(base, 'hover:text-foreground')}>
        <IconPlugConnected aria-hidden="true" className="size-[15px]" stroke={1.75} />
        Not connected yet
      </Link>
    )
  }
  if (scan.state === 'scanning' || scan.state === 'queued') {
    // The button says "Scanning"; the phase goes here.
    const detail = scan.state === 'scanning' ? describeScanning(scan) : 'First scan starting'
    return (
      <span className={cn(base, 'max-w-[360px]')} title={detail}>
        <span className="truncate">{detail}</span>
      </span>
    )
  }
  if (scan.state === 'failed') {
    return (
      <span className={base} title={scan.message}>
        <IconAlertTriangle aria-hidden="true" className="size-[15px] text-wait" stroke={1.75} />
        Last scan failed
      </span>
    )
  }
  const text = `Scanned ${formatRelative(scan.lastScanAt)}`
  return (
    <span
      className={base}
      title={scan.nextScanAt ? `${text}, next ${formatClock(scan.nextScanAt)}` : text}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-success" />
      {text}
    </span>
  )
}

function ScanButton({ scan, onScan }: { scan: ScanStatus; onScan: (() => void) | undefined }) {
  // Nothing to scan before a source is connected; the rail and the status link to setup instead.
  if (scan.state === 'unconfigured') return null
  if (scan.state === 'scanning' || scan.state === 'queued') {
    const label =
      scan.state === 'scanning' && scan.total > 0
        ? `Scanning ${scan.done} of ${scan.total}`
        : 'Scanning'
    return (
      <Button variant="outline" size="sm" disabled className="max-tab:size-10 max-tab:px-0">
        <IconLoader2 aria-hidden="true" className="animate-spin" />
        <span aria-live="polite" className="max-tab:sr-only">
          {label}
        </span>
      </Button>
    )
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onScan}
      disabled={!onScan}
      className="max-tab:size-10 max-tab:px-0"
    >
      <IconRefresh aria-hidden="true" />
      <span className="max-tab:sr-only">Scan now</span>
    </Button>
  )
}
