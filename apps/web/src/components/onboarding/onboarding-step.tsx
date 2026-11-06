import { IconCheck } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

export type StepState = 'active' | 'done' | 'todo' | 'locked'

export interface SetupStep {
  index: number
  title: string
  sub: string
  state: StepState
}

/**
 * The steps pane of setup, from the design's .stp list: a numbered circle, the step name and a
 * line under it. The open step is lit; done steps get a check; locked ones cannot be opened.
 * From 761 px the full list, below it a row of circles with only the open step named.
 */
export function SetupStepList({
  steps,
  open,
  onOpen,
}: {
  steps: readonly SetupStep[]
  open: number
  onOpen: (index: number) => void
}) {
  return (
    <ol aria-label="Setup steps" className="flex gap-2 tab:flex-col tab:gap-5">
      {steps.map((step) => {
        const current = step.index === open
        const locked = step.state === 'locked'
        const done = step.state === 'done'
        return (
          <li
            key={step.index}
            aria-current={current ? 'step' : undefined}
            className={cn(
              !current && 'max-tab:shrink-0',
              current && 'max-tab:min-w-0 max-tab:flex-1',
            )}
          >
            <button
              type="button"
              aria-disabled={locked || undefined}
              aria-label={`Step ${step.index}: ${step.title}. ${step.sub}${done ? '. Done' : locked ? '. Locked until the step before is done' : ''}`}
              onClick={() => !locked && onOpen(step.index)}
              className={cn(
                'grid w-full grid-cols-[30px_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring',
                locked ? 'cursor-default' : 'cursor-pointer',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-[30px] place-items-center rounded-full border text-sm font-semibold',
                  current
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : done
                      ? 'border-transparent bg-success-soft text-success'
                      : 'border-input bg-muted text-foreground-2',
                )}
              >
                {done && !current ? <IconCheck className="size-3.5" stroke={2.4} /> : step.index}
              </span>
              <span className={cn('flex min-w-0 flex-col', !current && 'max-tab:sr-only')}>
                <b
                  className={cn(
                    'truncate font-semibold',
                    locked ? 'text-foreground-2' : 'text-foreground',
                  )}
                >
                  {step.title}
                </b>
                <small className="truncate text-xs text-muted-foreground max-tab:hidden">
                  {step.sub}
                </small>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
