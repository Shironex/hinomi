import { useEffect, useState } from 'react'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

/** A shell command in mono with a copy button that confirms in place. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span className="flex max-w-full items-center gap-1 rounded-md border border-border bg-card py-0.5 pr-0.5 pl-2.5">
      <code className="min-w-0 overflow-x-auto font-mono text-xs whitespace-nowrap text-foreground">
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? 'Copied' : `Copy ${command}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }}
      >
        {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
      </Button>
    </span>
  )
}
