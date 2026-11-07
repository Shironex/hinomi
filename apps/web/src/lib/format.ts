import { nowMs } from '@hinomi/shared'
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/** "14 minutes ago", "yesterday". `now` is injectable for tests. */
export function formatRelative(iso: string, now: number = nowMs()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  let value = (then - now) / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit)
    value /= size
  }
  return iso
}

/** "18:00" in the viewer's time zone. */
export function formatClock(iso: string): string {
  const then = Date.parse(iso)
  return Number.isNaN(then) ? iso : clock.format(then)
}
