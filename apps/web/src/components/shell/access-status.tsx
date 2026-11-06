import { Link } from '@tanstack/react-router'
import { IconLock, IconShieldCheck, IconWorld } from '@tabler/icons-react'
import { accessLabel, accessTone, useAccessStatus } from '@/hooks/use-access'
import { cn } from '@/lib/utils'

const ICON = { ok: IconShieldCheck, warn: IconLock, danger: IconWorld } as const
const ICON_COLOR = { ok: 'text-success', warn: 'text-wait', danger: 'text-sev-critical' } as const

/**
 * The access status from GET /api/access, in the top bar, linking to the Access section of
 * settings. Nothing while it loads or when the server cannot be asked. On the phone header only
 * the icon shows; the label stays the accessible name.
 */
export function AccessStatusLink() {
  const status = useAccessStatus()
  if (!status) return null
  const tone = accessTone(status)
  const IconCmp = ICON[tone]
  const label = accessLabel(status)
  return (
    <Link
      to="/settings"
      hash="settings-access"
      title={label}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-sm whitespace-nowrap hover:text-foreground max-tab:size-10 tab:py-1',
        tone === 'danger' ? 'font-semibold text-sev-critical' : 'text-foreground-2',
      )}
    >
      <IconCmp
        aria-hidden="true"
        className={cn('size-[15px] shrink-0', ICON_COLOR[tone])}
        stroke={1.75}
      />
      <span className="max-tab:sr-only">{label}</span>
    </Link>
  )
}

/** A red bar over every page while Hinomi is reached from a public address. */
export function PublicAccessBanner() {
  const status = useAccessStatus()
  if (status?.state !== 'public') return null
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-[color-mix(in_oklch,var(--sev-critical)_40%,transparent)] bg-sev-critical-soft px-4 py-2 text-sm text-sev-critical tab:px-6"
    >
      <IconWorld aria-hidden="true" className="size-4 shrink-0" stroke={1.75} />
      <span>
        <b className="font-semibold">Reachable from the internet.</b>{' '}
        <span className="text-foreground-2">
          Hinomi has no login and this request came from a public address.
        </span>{' '}
        <Link
          to="/settings"
          hash="settings-access"
          className="font-medium underline underline-offset-2"
        >
          What to do
        </Link>
      </span>
    </div>
  )
}
