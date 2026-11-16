import type { AuditAction, AuditEvent } from '@hinomi/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { auditQuery } from '@/lib/auth-api'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Panel } from './settings-section'

const ACTION_TEXT: Record<AuditAction, string> = {
  login: 'Signed in',
  login_failed: 'Sign in refused',
  logout: 'Signed out',
  passkey_added: 'Passkey added',
  passkey_removed: 'Passkey removed',
  session_revoked: 'Session ended',
  setup_code_used: 'Setup code used',
  auth_reset: 'Login reset from the container',
  change: 'Change',
}

function what(event: AuditEvent): string {
  if (event.action === 'change') return `${event.httpMethod ?? ''} ${event.path ?? ''}`.trim()
  return event.detail ? `${ACTION_TEXT[event.action]}: ${event.detail}` : ACTION_TEXT[event.action]
}

/**
 * Settings, Audit log: who signed in (and who was refused), passkey and session changes, and every
 * change made through the API, newest first.
 */
export function AuditSection() {
  const audit = useInfiniteQuery(auditQuery)
  if (audit.isPending) {
    return (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-56" />
        <Skeleton className="h-3.5 w-48" />
      </Panel>
    )
  }
  if (audit.isError) {
    return (
      <ErrorState
        title="The audit log did not load"
        error={audit.error}
        onRetry={() => void audit.refetch()}
      />
    )
  }
  const events = audit.data.pages.flatMap((page) => page.events)
  if (events.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-foreground-2">Nothing recorded yet.</p>
      </Panel>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Audit log" className="flex flex-col rounded-lg border border-border bg-card">
        {events.map((event) => (
          <li
            key={event.id}
            className="grid grid-cols-1 gap-x-4 gap-y-0.5 border-t border-border px-4 py-2.5 text-sm first:border-t-0 tab:grid-cols-[170px_minmax(0,1fr)_auto]"
          >
            <time dateTime={event.at} className="text-xs text-muted-foreground tab:text-sm">
              {formatDateTime(event.at)}
            </time>
            <span
              className={cn(
                'min-w-0 truncate',
                event.action === 'change' && 'font-mono text-[0.92em]',
                event.action === 'login_failed' && 'text-sev-critical',
              )}
            >
              {what(event)}
            </span>
            <span className="truncate text-xs text-muted-foreground tab:text-sm">
              {[event.actor ?? (event.action === 'change' ? 'no login' : null), event.ip]
                .filter(Boolean)
                .join(', ')}
            </span>
          </li>
        ))}
      </ol>
      {audit.hasNextPage ? (
        <Button
          variant="outline"
          className="self-start"
          disabled={audit.isFetchingNextPage}
          onClick={() => void audit.fetchNextPage()}
        >
          {audit.isFetchingNextPage ? (
            <IconLoader2 aria-hidden="true" className="animate-spin" />
          ) : null}
          Show older
        </Button>
      ) : null}
    </div>
  )
}
