import { Link } from '@tanstack/react-router'
import {
  IconKeyboard,
  IconLoader2,
  IconPlugConnected,
  IconAlertTriangle,
} from '@tabler/icons-react'
import type { NavCounts, ScanStatus } from '@/hooks/use-shell-data'
import { formatClock, formatRelative } from '@/lib/format'
import { describeScanning } from '@/lib/scan-phases'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { AccessLine } from './access-line'
import { BrandMark } from './brand-mark'
import { DRIFT_NAV, formatCount, PRIMARY_NAV, SETTINGS_NAV, type NavItem, type NavKey } from './nav'
import { ThemeCycleButton, ThemeSwitch } from './theme-switch'

interface SidebarProps {
  current: NavKey | undefined
  counts: NavCounts
  scan: ScanStatus
  onOpenHelp: () => void
}

/** Labels collapse to screen-reader text on the 761 to 1024 px icon rail. */
const LABEL = 'sr-only desk:not-sr-only desk:truncate'

const itemClass =
  'relative flex items-center justify-center gap-2.5 rounded-md py-[9px] text-base font-medium text-foreground-2 desk:justify-start desk:px-2.5 desk:py-[7px]'

export function Sidebar({ current, counts, scan, onOpenHelp }: SidebarProps) {
  const firstRun = current === 'onboarding'
  return (
    <aside
      aria-label="Sidebar"
      className="sticky top-0 hidden h-dvh flex-col gap-1 border-r border-border bg-sidebar py-3.5 pr-2 pl-[max(8px,env(safe-area-inset-left))] tab:flex desk:pr-2.5 desk:pl-[max(10px,env(safe-area-inset-left))]"
    >
      <Link
        to="/"
        title="Hinomi"
        className="flex items-center justify-center gap-[9px] rounded-md pt-1 pb-3.5 text-foreground desk:justify-start desk:px-2"
      >
        <BrandMark />
        <span className={cn(LABEL, 'text-[15px] font-semibold tracking-[-0.01em]')}>Hinomi</span>
      </Link>

      <nav aria-label="Main" className="flex flex-col gap-px">
        {PRIMARY_NAV.map((item) => (
          <SidebarLink
            key={item.key}
            item={item}
            current={current}
            disabled={firstRun}
            count={item.count ? counts[item.count] : null}
          />
        ))}
        <SectionLabel>Next</SectionLabel>
        <SidebarLink item={DRIFT_NAV} current={current} disabled={firstRun} soon />
        <SectionLabel>Instance</SectionLabel>
        <SidebarLink item={SETTINGS_NAV} current={current} />
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2 border-t border-border pt-2.5 desk:items-stretch desk:px-1">
        <AccessLine labelClassName={LABEL} />
        <ScanLine scan={scan} />
        <ThemeSwitch className="hidden desk:flex" />
        <ThemeCycleButton className="desk:hidden" />
        <button
          type="button"
          onClick={onOpenHelp}
          title="Keyboard shortcuts"
          className="flex cursor-pointer items-center justify-center gap-[7px] rounded-sm p-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground desk:justify-start desk:py-1"
        >
          <IconKeyboard aria-hidden="true" className="size-3.5" stroke={1.75} />
          <span className={LABEL}>Keyboard shortcuts</span>
          <Kbd className="ml-auto hidden desk:inline-flex" aria-hidden="true">
            ?
          </Kbd>
        </button>
      </div>
    </aside>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <>
      <div aria-hidden="true" className="mx-2 my-1.5 h-px bg-border desk:hidden" />
      <div className="hidden px-2.5 pt-3.5 pb-1.5 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase desk:block">
        {children}
      </div>
    </>
  )
}

interface SidebarLinkProps {
  item: NavItem
  current: NavKey | undefined
  count?: number | null
  disabled?: boolean
  soon?: boolean
}

function SidebarLink({ item, current, count, disabled, soon }: SidebarLinkProps) {
  const IconCmp = item.icon
  const active = current === item.key
  const shown = formatCount(count)
  const content = (
    <>
      <IconCmp
        aria-hidden="true"
        className={cn('size-4 shrink-0', active && 'text-accent-ink')}
        stroke={1.75}
      />
      <span className={LABEL}>{item.label}</span>
      {soon ? (
        <span className="ml-auto hidden rounded-full border border-input px-1.5 py-px text-[10.5px] font-medium text-muted-foreground desk:inline">
          Phase 2
        </span>
      ) : null}
      {shown && !disabled ? (
        <span
          className={cn(
            'text-xs tabular-nums desk:static desk:ml-auto',
            item.hot
              ? 'absolute top-0.5 right-1 text-[10px] font-semibold text-sev-critical desk:text-xs'
              : 'hidden text-muted-foreground desk:inline',
          )}
        >
          {shown}
          {item.hot ? <span className="sr-only"> need action</span> : null}
        </span>
      ) : null}
    </>
  )

  if (disabled) {
    return (
      <span
        aria-disabled="true"
        title={`${item.label} (connect a source first)`}
        className={cn(itemClass, 'opacity-45')}
      >
        {content}
      </span>
    )
  }

  return (
    <Link
      to={item.to}
      title={soon ? `${item.label} (phase 2)` : item.label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        itemClass,
        'hover:bg-muted hover:text-foreground',
        active && 'bg-card text-foreground shadow-[0_0_0_1px_var(--border)] hover:bg-card',
      )}
    >
      {content}
    </Link>
  )
}

function ScanLine({ scan }: { scan: ScanStatus }) {
  const base =
    'flex items-center justify-center gap-2 px-1.5 text-xs text-muted-foreground desk:justify-start'
  if (scan.state === 'unconfigured') {
    return (
      <Link
        to="/onboarding"
        className={cn(base, 'rounded-sm py-1 hover:text-foreground')}
        title="Not connected yet"
      >
        <IconPlugConnected aria-hidden="true" className="size-3.5 shrink-0" stroke={1.75} />
        <span className={LABEL}>Not connected yet</span>
      </Link>
    )
  }
  if (scan.state === 'scanning' || scan.state === 'queued') {
    // The rail is narrow: a short label, the phase in the tooltip.
    const title = scan.state === 'queued' ? 'First scan starting' : describeScanning(scan)
    const text =
      scan.state === 'scanning' && scan.total > 0
        ? `Scanning ${scan.done} of ${scan.total}`
        : scan.state === 'queued'
          ? 'Scan starting'
          : 'Scanning'
    return (
      <div className={base} title={title}>
        <IconLoader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" stroke={1.75} />
        <span className={LABEL}>{text}</span>
      </div>
    )
  }
  if (scan.state === 'failed') {
    return (
      <div className={cn(base, 'text-sev-critical')} title={scan.message}>
        <IconAlertTriangle aria-hidden="true" className="size-3.5 shrink-0" stroke={1.75} />
        <span className={LABEL}>Last scan failed</span>
      </div>
    )
  }
  const text = `Scanned ${formatRelative(scan.lastScanAt)}${scan.nextScanAt ? `, next ${formatClock(scan.nextScanAt)}` : ''}`
  return (
    <div className={base} title={text}>
      <span
        aria-hidden="true"
        className="size-[7px] shrink-0 rounded-full bg-success shadow-[0_0_0_3px_var(--success-soft)]"
      />
      <span className={LABEL}>{text}</span>
    </div>
  )
}
