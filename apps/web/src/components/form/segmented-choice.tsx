import { useId } from 'react'
import type { Icon } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon: Icon
}

/** A few exclusive options as a segmented radio group, like the channel type picker. */
export function SegmentedChoice<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
}) {
  // Two groups can be on screen at once (adding a source while replacing another's token).
  const name = useId()
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="inline-flex w-fit flex-wrap gap-0.5 rounded-md bg-muted p-0.5">
        {options.map((option) => {
          const OptionIcon = option.icon
          return (
            <label
              key={option.value}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs text-foreground-2 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-ring hover:text-foreground',
                value === option.value &&
                  'bg-card text-foreground shadow-[0_1px_2px_oklch(0.2_0.02_265/0.12)]',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <OptionIcon aria-hidden="true" className="size-3.5" stroke={1.75} />
              {option.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
