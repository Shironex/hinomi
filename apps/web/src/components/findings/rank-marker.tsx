import { factorsText } from '@/lib/finding-meta'
import { cn } from '@/lib/utils'

/**
 * The four box rank marker: severity, runtime, deployed, public. `null` is unknown (blind
 * spots). `strong` paints the on boxes in the critical color, for exposed rows.
 */
export function RankMarker({
  flags,
  strong = false,
  className,
}: {
  flags: readonly (boolean | null)[]
  strong?: boolean
  className?: string
}) {
  const text = factorsText(flags)
  return (
    <span
      role="img"
      aria-label={`Exposure factors: ${text}`}
      title={text}
      className={cn(
        'inline-grid flex-none grid-cols-[repeat(4,10px)] items-center gap-0.5',
        className,
      )}
    >
      {flags.map((on, i) => (
        <i
          key={i}
          className={cn(
            'block h-3.5 rounded-[2px]',
            on === null
              ? 'bg-[repeating-linear-gradient(135deg,var(--muted)_0_2px,var(--input)_2px_3px)] shadow-[inset_0_0_0_1px_var(--border)]'
              : on
                ? strong
                  ? 'bg-sev-critical'
                  : 'bg-foreground-2'
                : 'bg-muted shadow-[inset_0_0_0_1px_var(--border)]',
          )}
        />
      ))}
    </span>
  )
}

const LEGEND = [
  ['S', 'Severity'],
  ['R', 'Runtime'],
  ['D', 'Deployed'],
  ['P', 'Public'],
] as const

export function FactorLegend({ className }: { className?: string }) {
  return (
    <span className={cn('flex flex-wrap gap-3.5 text-xs text-muted-foreground', className)}>
      {LEGEND.map(([letter, word]) => (
        <span key={letter} className="inline-flex items-center gap-1.5">
          <b
            aria-hidden="true"
            className="inline-flex size-5 items-center justify-center rounded-[3px] bg-muted font-mono text-[13px] font-semibold text-foreground-2"
          >
            {letter}
          </b>
          {word}
        </span>
      ))}
    </span>
  )
}
