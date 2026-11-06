import type { DeploymentItem } from '@hinomi/shared'
import { deploymentFacts, type HeatLevel } from '@/lib/deployment-map'
import { cn } from '@/lib/utils'

export const HEAT_FILL: Record<HeatLevel, string> = {
  0: 'bg-background',
  1: 'bg-(--heat-1)',
  2: 'bg-(--heat-2)',
  3: 'bg-(--heat-3) border-[color-mix(in_oklab,var(--primary)_45%,var(--border))]',
}

/** Cyan stripes over the tile's heat, for an app with an open blind spot. Never red. */
const BLIND_HATCH: Record<HeatLevel, string> = {
  0: '[--tile:var(--background)]',
  1: '[--tile:var(--heat-1)]',
  2: '[--tile:var(--heat-2)]',
  3: '[--tile:var(--heat-3)]',
}

/** Classes of a tile's link: the fill and edge say heat, blind spot, no repo, or faded. */
export function tileClass(d: DeploymentItem): string {
  const f = deploymentFacts(d)
  return cn(
    'flex min-h-[122px] min-w-0 flex-col gap-2 rounded-lg border border-border px-3.5 pt-3.5 pb-[13px] text-foreground no-underline',
    'transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    f.unmapped
      ? 'border-dashed border-blind bg-background'
      : f.stopped || f.imageOnly
        ? 'border-dashed bg-transparent'
        : f.blind
          ? cn(
              BLIND_HATCH[f.heat],
              'border-[color-mix(in_oklab,var(--blind)_60%,var(--border))] bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--blind)_14%,var(--tile))_0_6px,var(--tile)_6px_12px)]',
            )
          : HEAT_FILL[f.heat],
  )
}
