import { IconFileDiff } from '@tabler/icons-react'
import type { DiffFile } from '@/lib/fix-run-meta'
import { cn } from '@/lib/utils'

const SIGN_CLASS = {
  '+': 'bg-success-soft text-foreground',
  '-': 'bg-sev-critical-soft text-foreground',
  ' ': 'text-foreground-2',
} as const

const SIGN_WORD = { '+': 'added', '-': 'removed', ' ': 'unchanged' } as const

/**
 * What the fix PR will change, one block per file, in diff colours with the sign spelled out
 * for screen readers. Lockfiles the install regenerates show a note instead of lines.
 */
export function PlanDiff({
  files,
  className,
  label = 'What the fix pull request changes',
}: {
  files: readonly DiffFile[]
  className?: string
  label?: string
}) {
  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">No file changes: no step can be sent.</p>
  }
  return (
    <ul aria-label={label} className={cn('m-0 flex list-none flex-col gap-2.5 p-0', className)}>
      {files.map((file) => (
        <li key={file.path} className="overflow-hidden rounded-md border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border bg-sidebar px-3 py-2">
            <IconFileDiff
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
              stroke={1.75}
            />
            <span className="min-w-0 truncate font-mono text-xs font-semibold">{file.path}</span>
            {file.note ? (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{file.note}</span>
            ) : null}
          </div>
          {file.lines.length ? (
            <pre className="m-0 overflow-x-auto py-1 font-mono text-xs leading-[1.6]">
              {file.lines.map((line, i) => (
                <span key={i} className={cn('block px-3 whitespace-pre', SIGN_CLASS[line.sign])}>
                  <span aria-hidden="true" className="mr-2 inline-block w-2 select-none">
                    {line.sign}
                  </span>
                  <span className="sr-only">{SIGN_WORD[line.sign]}: </span>
                  {line.text}
                </span>
              ))}
            </pre>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
