import type { DeferKind } from './view-api'

/** Expiry choices and copy of the snooze and accept form. */

export const DAY_MS = 86_400_000

export const EXPIRY_CHOICES = [
  { value: '7', label: 'In 7 days' },
  { value: '30', label: 'In 30 days' },
  { value: '90', label: 'In 90 days' },
  { value: 'date', label: 'On a date' },
] as const

export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]['value']

/** "2026-11-07" for a date input, in local time. */
export function localDay(time: number): string {
  const d = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The expiry as an ISO timestamp: n days from now, or the end of the picked day. */
export function expiryToIso(choice: ExpiryChoice, date: string, now: number): string | null {
  if (choice !== 'date') return new Date(now + Number(choice) * DAY_MS).toISOString()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const end = new Date(`${date}T23:59:00`)
  if (Number.isNaN(end.getTime()) || end.getTime() <= now) return null
  return end.toISOString()
}

export const DEFER_COPY: Record<DeferKind, { verb: string; done: string }> = {
  snooze: { verb: 'Snooze', done: 'Snoozed' },
  accept: { verb: 'Accept risk', done: 'Risk accepted' },
}
