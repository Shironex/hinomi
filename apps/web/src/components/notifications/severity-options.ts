import type { Severity } from '@hinomi/shared'

/** Choices for a channel's least severe finding, in words. */
export const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: 'critical', label: 'Critical only' },
  { value: 'high', label: 'High and above' },
  { value: 'moderate', label: 'Moderate and above' },
  { value: 'low', label: 'Everything' },
]
