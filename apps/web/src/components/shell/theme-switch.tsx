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
            className="inline-flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-sm px-2 py-1 text-xs text-foreground-2 transition-colors hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_oklch(0.2_0.03_305/0.12)]"
          >
            <IconCmp aria-hidden="true" className="size-3.5" stroke={1.75} />
            {THEME_LABEL[t]}
          </button>
        )
      })}
    </div>
  )
}

/** One button that cycles the theme, for the icon rail: icon over the word, like the rail items. */
export function ThemeCycleButton({ className }: { className?: string }) {
  const theme = useTheme()
  const IconCmp = THEME_ICON[theme]
  return (
    <button
      type="button"
      onClick={() => cycleTheme()}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Switch theme`}
      title={`Theme: ${THEME_LABEL[theme]}`}
      className={cn('cursor-pointer', className)}
    >
      <IconCmp aria-hidden="true" className="size-[22px] text-muted-foreground" stroke={1.75} />
      Theme
    </button>
  )
}
