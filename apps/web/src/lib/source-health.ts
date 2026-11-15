import type { SourceDto } from '@hinomi/shared'
import { formatRelative } from '@/lib/format'

/** How a source row in Settings sums up its last sync. */

export type Health = { label: string; tone: 'ok' | 'error' | 'neutral' | 'missing' }

/** `needsToken: false` for a kind that connects without a secret (a Docker socket). */
export function healthOf(source: SourceDto, { needsToken = true } = {}): Health {
  if (!source.enabled) return { label: 'Paused', tone: 'neutral' }
  if (needsToken && !source.hasToken) return { label: 'No token', tone: 'missing' }
  const ok = source.lastOkAt ? Date.parse(source.lastOkAt) : 0
  const failed = source.lastErrorAt ? Date.parse(source.lastErrorAt) : 0
  if (failed > ok) return { label: 'Sync failed', tone: 'error' }
  if (source.lastOkAt) return { label: `Synced ${formatRelative(source.lastOkAt)}`, tone: 'ok' }
  return { label: 'Not synced yet', tone: 'neutral' }
}
