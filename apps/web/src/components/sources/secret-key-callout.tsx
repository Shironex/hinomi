import { IconKey, IconRefresh } from '@tabler/icons-react'
import { CopyCommand } from '@/components/copy-command'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'

/**
 * Shown instead of token forms while HINOMI_SECRET_KEY is missing: the server
 * would refuse to store a token, so the fix comes first.
 */
export function SecretKeyCallout({
  onRecheck,
  rechecking = false,
}: {
  onRecheck?: () => void
  rechecking?: boolean
}) {
  return (
    <Callout variant="warn" icon={IconKey} title="Set HINOMI_SECRET_KEY before connecting">
      <div className="flex flex-col gap-2.5">
        <p>
          Hinomi encrypts every token with this key, and it is not set on the server, so tokens
          cannot be saved yet.
        </p>
        <ol className="flex list-decimal flex-col gap-2 pl-5 marker:text-muted-foreground">
          <li>
            <span className="mb-1 block">Generate a key:</span>
            <CopyCommand command="openssl rand -base64 32" />
          </li>
          <li>
            Set it as <code className="font-mono text-[0.92em]">HINOMI_SECRET_KEY</code> in the
            container environment (for example in your compose file).
          </li>
          <li>Restart Hinomi, then check again.</li>
        </ol>
        {onRecheck ? (
          <div>
            <Button variant="outline" size="sm" onClick={onRecheck} disabled={rechecking}>
              <IconRefresh aria-hidden="true" className={rechecking ? 'animate-spin' : undefined} />
              Check again
            </Button>
          </div>
        ) : null}
      </div>
    </Callout>
  )
}
