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
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-border bg-card pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] tab:hidden"
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
              'relative flex min-h-14 flex-col items-center justify-center gap-[3px] px-0.5 pt-2 pb-[9px] text-[10.5px] font-medium text-muted-foreground',
              active && 'text-accent-ink',
            )}
          >
            <IconCmp aria-hidden="true" className="size-5" stroke={1.75} />
            {item.tabLabel}
            {item.hot && pip ? (
              <span className="absolute top-[5px] left-[calc(50%+6px)] grid h-4 min-w-4 place-items-center rounded-full bg-sev-critical px-1 text-[10px] text-card">
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
