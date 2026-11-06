import type { Reporter } from '@hinomi/shared'
import {
  IconAlertCircle,
  IconAlertOctagon,
  IconAlertTriangle,
  IconBrandGithub,
  IconDatabase,
  IconEyeOff,
  IconInfoCircle,
  IconLayersIntersect,
  type Icon,
} from '@tabler/icons-react'
import type { SeverityKey } from './finding-meta'

/** Icons and color classes per severity and source, shared by badges, chips and bars. */

export const SEVERITY_ICON: Record<SeverityKey, Icon> = {
  critical: IconAlertOctagon,
  high: IconAlertTriangle,
  moderate: IconAlertCircle,
  low: IconInfoCircle,
}

/** Soft fill and ink per severity, for chips and counts. */
export const SEVERITY_TONE: Record<SeverityKey, string> = {
  critical: 'bg-sev-critical-soft text-sev-critical',
  high: 'bg-sev-high-soft text-sev-high',
  moderate: 'bg-sev-moderate-soft text-sev-moderate',
  low: 'bg-sev-low-soft text-sev-low',
}

/** Solid fill per severity, for bars. */
export const SEVERITY_FILL: Record<SeverityKey, string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  moderate: 'bg-sev-moderate',
  low: 'bg-sev-low',
}

export type SourceKey = 'none' | 'both' | Reporter

export const SOURCE_ICON: Record<SourceKey, Icon> = {
  none: IconEyeOff,
  both: IconLayersIntersect,
  github: IconBrandGithub,
  osv: IconDatabase,
}

export function sourceKey(sources: readonly Reporter[]): SourceKey {
  if (sources.length === 0) return 'none'
  if (sources.length > 1) return 'both'
  return sources[0]!
}
