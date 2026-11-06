import {
  IconBell,
  IconCircleCheck,
  IconClockExclamation,
  IconClockPause,
  IconDatabase,
  IconPoint,
  IconRefresh,
  IconShieldCheck,
  IconShieldOff,
  IconThumbUp,
  type Icon,
} from '@tabler/icons-react'

const ICONS: Record<string, Icon> = {
  opened: IconBell,
  snoozed: IconClockPause,
  accepted: IconThumbUp,
  reopened: IconRefresh,
  snooze_expired: IconClockExclamation,
  acceptance_expired: IconClockExclamation,
  fixed: IconShieldCheck,
  resolved: IconCircleCheck,
  dismissed_upstream: IconShieldOff,
  dismissal_noted: IconShieldOff,
  reporters_changed: IconDatabase,
}

export function eventIcon(type: string): Icon {
  return ICONS[type] ?? IconPoint
}

/** Expiries and fixes deserve a tone in a feed. */
export function eventTone(type: string): string | undefined {
  if (type === 'snooze_expired' || type === 'acceptance_expired') return 'text-sev-high'
  if (type === 'fixed' || type === 'resolved') return 'text-success'
  return undefined
}
