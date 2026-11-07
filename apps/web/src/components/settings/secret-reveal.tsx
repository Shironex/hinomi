import { useEffect, useState } from 'react'
import { IconCheck, IconCopy, IconKey } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'

/** The new secret, once. It lives only in this component's state and goes when it is dismissed. */
export function SecretReveal({
  secret,
  where,
  testId,
  onDone,
}: {
  secret: string
  /** Where to paste it, after "Paste it into": "the webhook secret in GitHub". */
  where: string
  testId: string
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Callout variant="warn" icon={IconKey} title="Shown once. Copy it now.">
      <div className="flex flex-col gap-2.5 pt-1">
        <span>
          Hinomi keeps it encrypted and cannot show it again. Paste it into {where}, then close
          this.
        </span>
        <span className="flex max-w-full items-center gap-1 rounded-md border border-border bg-card py-0.5 pr-0.5 pl-2.5">
          <code
            data-testid={testId}
            className="min-w-0 overflow-x-auto font-mono text-sm whitespace-nowrap text-foreground select-all"
          >
            {secret}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? 'Copied' : 'Copy secret'}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(secret)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }}
          >
            {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
          </Button>
        </span>
        <div>
          <Button variant="outline" size="sm" onClick={onDone}>
            I copied it
          </Button>
        </div>
      </div>
    </Callout>
  )
}
