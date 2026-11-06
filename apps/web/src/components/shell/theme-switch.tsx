import { cn } from '@/lib/utils'
import { cycleTheme, setTheme, THEMES, useTheme } from '@/lib/theme'
import { THEME_ICON, THEME_LABEL } from './theme-meta'

/** Segmented system / light / dark control from the sidebar footer. */
export function ThemeSwitch({ className }: { className?: string }) {
  const theme = useTheme()
  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn('inline-flex gap-0.5 rounded-md bg-muted p-0.5', className)}
    >
      {THEMES.map((t) => {
        const IconCmp = THEME_ICON[t]
        return (
          <button
            key={t}
            type="button"
            aria-pressed={theme === t}
            onClick={() => setTheme(t)}
            className="inline-flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-sm px-2 py-1 text-xs text-foreground-2 transition-colors hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_oklch(0.2_0.02_265/0.12)]"
          >
            <IconCmp aria-hidden="true" className="size-3.5" stroke={1.75} />
            {THEME_LABEL[t]}
          </button>
        )
      })}
    </div>
  )
}

/** One button that cycles the theme, for the icon rail where the segmented control does not fit. */
export function ThemeCycleButton({ className }: { className?: string }) {
  const theme = useTheme()
  const IconCmp = THEME_ICON[theme]
  return (
    <button
      type="button"
      onClick={() => cycleTheme()}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Switch theme`}
      title={`Theme: ${THEME_LABEL[theme]}`}
      className={cn(
        'grid size-9 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      <IconCmp aria-hidden="true" className="size-4" stroke={1.75} />
    </button>
  )
}
