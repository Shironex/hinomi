import { ApiError } from './api'

/** Turns any thrown value into a sentence a person can act on. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return 'This device is offline. Hinomi will load again when the connection is back.'
      }
      return 'The Hinomi server did not answer. Check that it is running and reachable from this browser.'
    }
    if (error.kind === 'parse') {
      return 'The server answered with data this page does not understand. The web app and server may be on different versions.'
    }
    if (error.status === 404) return 'The server has no record of this. It may have been removed.'
    return `${error.message}.`
  }
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong while loading this page.'
}
