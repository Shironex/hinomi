import { IconCheck, IconLoader2, IconMinus, IconX } from '@tabler/icons-react'
import { formatRelative } from '@/lib/format'
import type { StepStatus, TimelineStep } from '@/lib/fix-run-meta'
import { cn } from '@/lib/utils'

const STATUS_WORD: Record<StepStatus, string> = {
  done: 'done',
  now: 'in progress',
  fail: 'failed',
  todo: 'not yet',
  skip: 'skipped',
}

function Dot({ status }: { status: StepStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'z-[1] grid size-7 place-items-center rounded-full border-[1.5px] [&_svg]:size-3.5',
        status === 'done' && 'border-transparent bg-success-soft text-success',
        status === 'now' &&
          'border-primary bg-primary text-primary-foreground shadow-[0_0_0_4px_var(--accent)]',
        status === 'fail' && 'border-transparent bg-sev-critical-soft text-sev-critical',
        status === 'todo' && 'border-input bg-card text-muted-foreground',
        status === 'skip' && 'border-dashed border-input bg-card text-muted-foreground',
      )}
    >
      {status === 'done' ? <IconCheck stroke={2.4} /> : null}
      {status === 'fail' ? <IconX stroke={2.4} /> : null}
      {status === 'skip' ? <IconMinus stroke={2.4} /> : null}
      {status === 'now' ? <IconLoader2 className="motion-safe:animate-spin" stroke={2} /> : null}
    </span>
  )
}

/** The stages of a fix run from dispatch to the verifying rescan, how far it got and when. */
export function RunTimeline({ steps }: { steps: readonly TimelineStep[] }) {
  return (
    <ol aria-label="Fix run timeline" className="m-0 flex list-none flex-col p-0">
      {steps.map((step, i) => (
        <li
          key={step.key}
          className={cn(
            'relative grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3 pb-4 last:pb-0',
            // The rail between dots: green once the step is done.
            i < steps.length - 1 &&
              'before:absolute before:top-7 before:bottom-0 before:left-[13px] before:w-0.5 before:rounded-[1px] before:bg-border',
            i < steps.length - 1 && step.status === 'done' && 'before:bg-success',
          )}
        >
          <Dot status={step.status} />
          <div className="min-w-0 pt-1">
            <p
              className={cn(
                'text-sm font-semibold',
                (step.status === 'todo' || step.status === 'skip') &&
                  'font-normal text-muted-foreground',
              )}
            >
              {step.title}
              <span className="sr-only">, {STATUS_WORD[step.status]}</span>
            </p>
            <p
              className={cn(
                'mt-0.5 text-xs text-muted-foreground',
                step.status === 'fail' && 'text-sev-critical',
              )}
            >
              {step.detail}
            </p>
          </div>
          <span className="pt-[5px] text-xs whitespace-nowrap text-muted-foreground">
            {step.at ? (
              <time dateTime={step.at} title={step.at}>
                {formatRelative(step.at)}
              </time>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  )
}
