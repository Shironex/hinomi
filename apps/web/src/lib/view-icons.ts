import type { Reporter } from '@hinomi/shared'
import {
  IconAlertCircle,
  IconAlertOctagon,
  IconAlertTriangle,
  IconBrandGithub,
  IconContainer,
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

/** Fill and ink per severity, for counts: solid for critical, ink only for the rest. */
export const SEVERITY_TONE: Record<SeverityKey, string> = {
  critical: 'bg-sev-critical text-sev-critical-on',
  high: 'text-sev-high',
  moderate: 'text-sev-moderate',
  low: 'text-sev-low',
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
  image: IconContainer,
}

export function sourceKey(sources: readonly Reporter[]): SourceKey {
  if (sources.length === 0) return 'none'
  if (sources.length > 1) return 'both'
  return sources[0]!
}
