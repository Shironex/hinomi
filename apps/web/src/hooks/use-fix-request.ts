import { useSyncExternalStore } from 'react'
import { getFixRequest, subscribeFix, type FixRequest } from '@/lib/fix-request'

/** The open "Fix with Hinomi" request, or null. */
export function useFixRequest(): FixRequest | null {
  return useSyncExternalStore(subscribeFix, getFixRequest, () => null)
}
