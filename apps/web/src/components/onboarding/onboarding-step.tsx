import type * as React from 'react'
import { forwardRef, useId } from 'react'
import { IconCheck } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type StepState = 'active' | 'done' | 'todo' | 'locked'

interface OnboardingStepProps {
  index: number
  title: string
  sub: React.ReactNode
  state: StepState
  open: boolean
  optional?: boolean
  onToggle: () => void
  children?: React.ReactNode
}

/** One row of the design's .ob-steps list: a disclosure header and the step's form. */
export const OnboardingStep = forwardRef<HTMLButtonElement, OnboardingStepProps>(
  function OnboardingStep({ index, title, sub, state, open, optional, onToggle, children }, ref) {
    const panelId = useId()
    const locked = state === 'locked'
    const highlighted = open && !locked
    return (
      <li
        aria-current={state === 'active' ? 'step' : undefined}
        className="border-t border-border first:border-t-0"
      >
        <h2 className="text-base">
          <button
            ref={ref}
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-disabled={locked || undefined}
            onClick={() => !locked && onToggle()}
            className={cn(
              'grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 px-4 py-3.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring tab:px-[18px]',
              locked ? 'cursor-default' : 'cursor-pointer hover:bg-sidebar',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'grid size-7 place-items-center rounded-full border-[1.5px] border-input font-mono text-xs font-medium text-muted-foreground',
                highlighted && 'border-primary text-accent-ink shadow-[0_0_0_4px_var(--accent)]',
                state === 'done' &&
                  !highlighted &&
                  'border-transparent bg-success-soft text-success',
              )}
            >
              {state === 'done' && !highlighted ? (
                <IconCheck className="size-3.5" stroke={2} />
              ) : (
                index
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <b className={cn('font-medium', locked && 'text-muted-foreground')}>
                <span className="sr-only">Step {index}: </span>
                {title}
              </b>
              <small className="text-xs font-normal text-pretty text-muted-foreground">{sub}</small>
            </span>
            {state === 'done' ? (
              <Badge variant="success">Done</Badge>
            ) : optional ? (
              <Badge variant="outline">Optional</Badge>
            ) : locked ? (
              <span className="sr-only">Locked until the step before is done</span>
            ) : null}
          </button>
        </h2>
        <div id={panelId} hidden={!open}>
          {open ? (
            <div className="flex flex-col gap-3.5 px-4 pt-1 pb-5 tab:pr-[18px] tab:pl-[60px]">
              {children}
            </div>
          ) : null}
        </div>
      </li>
    )
  },
)
