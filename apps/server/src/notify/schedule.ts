/**
 * Milliseconds from `now` until the next time the local clock shows `hour`:00.
 * Always positive: at exactly that hour the next one is a day away.
 */
export function msUntilNextDigest(now: Date, hour: number): number {
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}
