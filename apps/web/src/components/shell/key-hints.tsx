import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import type { KeyHint } from './key-hints-meta'
import { useShell } from './shell-context'

/**
 * The key hint bar at the foot of the content (page routes) or the detail pane (split routes).
 * Keyboard only, so it is hidden on the phone. "? all keys" opens the shortcuts dialog.
 */
export function KeyHintBar({
  hints,
  className,
}: {
  hints: readonly KeyHint[]
  className?: string
}) {
  const { openHelp } = useShell()
  return (
    <div
      className={cn(
        'hidden shrink-0 flex-wrap items-center gap-x-[18px] gap-y-2 border-t border-border bg-sidebar px-7 py-3 text-xs text-foreground-2 tab:flex',
        className,
      )}
    >
      <span className="sr-only">Keyboard:</span>
      {hints.map((hint) => (
        <span key={hint.label} className="inline-flex items-center gap-1.5">
          {hint.keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
          {hint.label}
        </span>
      ))}
      <button
        type="button"
        onClick={openHelp}
        className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-sm hover:text-foreground"
      >
        <Kbd>?</Kbd>
        all keys
      </button>
    </div>
  )
}
