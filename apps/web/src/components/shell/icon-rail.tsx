import { Link } from '@tanstack/react-router'
import { IconAlertTriangle, IconLoader2, IconPlugConnected, type Icon } from '@tabler/icons-react'
import type { NavCounts, ScanStatus } from '@/hooks/use-shell-data'
import { formatRelative } from '@/lib/format'
import { describeScanning } from '@/lib/scan-phases'
import { cn } from '@/lib/utils'
import { BrandMark } from './brand-mark'
import { formatCount, RAIL_NAV, SETTINGS_NAV, type NavItem, type NavKey } from './nav'
import { ThemeCycleButton } from './theme-switch'

interface IconRailProps {
  current: NavKey | undefined
  counts: NavCounts
  scan: ScanStatus
}

/** The 88 px icon rail from 761 px up: icon over label, counts, and the scan status dot. */
export function IconRail({ current, counts, scan }: IconRailProps) {
  const firstRun = current === 'onboarding'
  return (
    <aside
      aria-label="Rail"
      className="sticky top-0 hidden h-dvh w-[88px] shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar px-2 py-4 tab:flex"
    >
      <Link to="/" title="Hinomi" aria-label="Hinomi" className="mb-3.5 rounded-md">
        <BrandMark />
      </Link>
      <nav aria-label="Main" className="flex flex-1 flex-col items-center gap-1">
        {RAIL_NAV.map((item) => (
          <RailLink
            key={item.key}
            item={item}
            current={current}
            disabled={firstRun}
            count={item.count ? counts[item.count] : null}
          />
        ))}
        <span className="flex-1" />
        <ThemeCycleButton className={cn(itemClass, 'hover:bg-muted hover:text-foreground')} />
        <RailLink item={SETTINGS_NAV} current={current} />
      </nav>
      <ScanDot scan={scan} />
    </aside>
  )
}

const itemClass =
  'relative flex w-[72px] flex-col items-center gap-1 rounded-md pt-[9px] pb-2 text-xs font-[550] text-foreground-2'

function RailLink({
  item,
  current,
  count,
  disabled,
}: {
  item: NavItem
  current: NavKey | undefined
  count?: number | null
  disabled?: boolean
}) {
  const IconCmp = item.icon
  const active = current === item.key
  const shown = disabled ? null : formatCount(count)
  const title = shown ? `${item.label}, ${shown}` : item.label
  const badge = shown && (item.hot || item.live) ? shown : null
  const content = (
    <>
      <IconCmp
        aria-hidden="true"
        className={cn('size-[22px]', active ? 'text-accent-ink' : 'text-muted-foreground')}
        stroke={1.75}
      />
      {item.railLabel}
      {badge ? (
        <span
          className={cn(
            'absolute top-0.5 left-[calc(50%+6px)] rounded-full px-1.5 text-xs leading-[18px] font-bold tabular-nums',
            item.hot ? 'bg-accent text-accent-ink' : 'bg-muted text-foreground-2',
          )}
        >
          {badge}
          <span className="sr-only">{item.hot ? ' need action' : ' running'}</span>
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
      title={title}
      aria-current={active ? 'page' : undefined}
      className={cn(
        itemClass,
        'hover:bg-muted hover:text-foreground',
        active && 'bg-muted text-foreground',
      )}
    >
      {content}
    </Link>
  )
}

/** The scan status as a dot at the foot of the rail; the words are in the top bar. */
function ScanDot({ scan }: { scan: ScanStatus }) {
  const wrap = 'mt-2.5 mb-1 grid size-6 place-items-center'
  const icon = (IconCmp: Icon, className: string, title: string) => (
    <span className={wrap} title={title}>
      <IconCmp aria-hidden="true" className={cn('size-4', className)} stroke={1.75} />
      <span className="sr-only">{title}</span>
    </span>
  )
  if (scan.state === 'unconfigured')
    return icon(IconPlugConnected, 'text-muted-foreground', 'Not connected yet')
  if (scan.state === 'queued')
    return icon(IconLoader2, 'animate-spin text-accent-ink', 'First scan starting')
  if (scan.state === 'scanning')
    return icon(IconLoader2, 'animate-spin text-accent-ink', describeScanning(scan))
  if (scan.state === 'failed')
    return icon(IconAlertTriangle, 'text-wait', `Last scan failed: ${scan.message}`)
  const title = `Scanned ${formatRelative(scan.lastScanAt)}`
  return (
    <span className={wrap} title={title}>
      <span aria-hidden="true" className="size-2 rounded-full bg-success" />
      <span className="sr-only">{title}</span>
    </span>
  )
}
