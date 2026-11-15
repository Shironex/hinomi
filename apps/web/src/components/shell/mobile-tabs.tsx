import { Link } from '@tanstack/react-router'
import type { NavCounts } from '@/hooks/use-shell-data'
import { formatCount, PRIMARY_NAV, SETTINGS_NAV, type NavKey } from './nav'
import { cn } from '@/lib/utils'

const MORE_KEYS: readonly (NavKey | undefined)[] = ['settings', 'guards', 'onboarding']

/** Phone navigation (up to 760 px): four views plus More, which holds settings and the rest. */
export function MobileTabs({
  current,
  counts,
}: {
  current: NavKey | undefined
  counts: NavCounts
}) {
  const items = [...PRIMARY_NAV, SETTINGS_NAV]
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-border bg-sidebar pt-1.5 pr-[max(4px,env(safe-area-inset-right))] pb-[max(8px,env(safe-area-inset-bottom))] pl-[max(4px,env(safe-area-inset-left))] tab:hidden"
    >
      {items.map((item) => {
        const IconCmp = item.icon
        const pip =
          item.hot || item.live ? formatCount(item.count ? counts[item.count] : null) : null
        const active = item.key === 'settings' ? MORE_KEYS.includes(current) : current === item.key
        return (
          <Link
            key={item.key}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex min-h-12 flex-col items-center justify-center gap-[3px] py-1.5 text-xs font-[550] text-foreground-2',
              active && 'text-accent-ink',
            )}
          >
            <IconCmp aria-hidden="true" className="size-[22px]" stroke={1.75} />
            {item.tabLabel}
            {pip ? (
              <span
                className={cn(
                  'absolute top-0 left-[calc(50%+6px)] rounded-full px-1.5 text-xs leading-[18px] font-bold tabular-nums',
                  item.hot ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground-2',
                )}
              >
                {pip}
                <span className="sr-only">
                  {item.badgeNote ?? (item.hot ? ' need action' : ' running')}
                </span>
              </span>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
