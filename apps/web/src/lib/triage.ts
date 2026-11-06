import type { FindingListItem, FixItem } from '@hinomi/shared'
import { blindSpotSubject } from './finding-meta'

/** Helpers of the triage lists and detail panes (Exposure, All alerts, By fix). */

export const FIX_AGENT_NOTE = 'The fix agent arrives in phase 1.'

/** "a", "a and b", "a, b and c", "a, b and 3 more". */
export function joinAnd(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length > max) {
    return `${items.slice(0, max - 1).join(', ')} and ${items.length - max + 1} more`
  }
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** Package name, or what the blind spot or note is on. */
export function findingName(item: FindingListItem): string {
  if (item.kind !== 'advisory') return blindSpotSubject(item)
  return item.advisory?.packageName ?? 'Advisory'
}

/** "tessera 14.2.9", for the breadcrumb and labels. */
export function fixLabel(fix: FixItem): string {
  return fix.target ? `${fix.packageName} ${fix.target}` : `${fix.packageName}, no patch yet`
}

/** "Patch release" when only the last number moves, and so on; null when it cannot tell. */
export function releaseKind(from: string | null, to: string | null): string | null {
  const parse = (v: string | null) =>
    v
      ?.match(/^v?(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number)
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return null
  if (a[0] !== b[0]) return 'Major release, read the changelog first'
  if (a[1] !== b[1]) return 'Minor release'
  return 'Patch release'
}
