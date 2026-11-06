import { Link } from '@tanstack/react-router'
import { formatCount, PRIMARY_NAV, SETTINGS_NAV, type NavKey } from './nav'
import { cn } from '@/lib/utils'

const MORE_KEYS: readonly (NavKey | undefined)[] = ['settings', 'drift', 'onboarding']

/** Phone navigation (up to 760 px): four views plus More, which holds settings and the rest. */
export function MobileTabs({
  current,
  needsAction,
}: {
  current: NavKey | undefined
  needsAction: number | null
}) {
  const items = [...PRIMARY_NAV, SETTINGS_NAV]
  const pip = formatCount(needsAction)
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-border bg-sidebar pt-1.5 pr-[max(4px,env(safe-area-inset-right))] pb-[max(8px,env(safe-area-inset-bottom))] pl-[max(4px,env(safe-area-inset-left))] tab:hidden"
    >
      {items.map((item) => {
        const IconCmp = item.icon
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
            {item.hot && pip ? (
              <span className="absolute top-0 left-[calc(50%+6px)] rounded-full bg-primary px-1.5 text-xs leading-[18px] font-bold text-primary-foreground tabular-nums">
                {pip}
                <span className="sr-only"> need action</span>
              </span>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
