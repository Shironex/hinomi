/**
 * The one place that reads the wall clock. Code that needs the time calls these
 * (or takes a `now` option that defaults to them), so tests can fake time in one spot.
 */
export function currentTime(): Date {
  return new Date()
}

export function nowMs(): number {
  return Date.now()
}
