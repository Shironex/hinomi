import type * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconCheck, IconPlugConnected } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { healthQuery } from '@/lib/queries'

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings">
        Sources, alerts and scans for this instance. Stored in the container volume at{' '}
        <span className="font-mono text-[0.92em]">/data</span>.
      </PageHeader>
      <SettingsSection title="Instance" intro="The Hinomi server this page talks to.">
        <ServerHealth />
      </SettingsSection>
      <SettingsSection title="Sources" intro="Where deployments and advisories come from.">
        <EmptyState
          icon={IconPlugConnected}
          title="No sources connected"
          actions={
            <Button asChild variant="outline">
              <Link to="/onboarding">Set up</Link>
            </Button>
          }
        >
          Coolify for deployments, GitHub for alerts. OSV.dev needs no token.
        </EmptyState>
      </SettingsSection>
    </>
  )
}

function SettingsSection({
  title,
  intro,
  children,
}: {
  title: string
  intro: string
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-3.5 border-t border-border py-6 first-of-type:border-t-0 first-of-type:pt-0 desk:grid-cols-[minmax(0,260px)_minmax(0,1fr)] desk:gap-6">
      <div>
        <h2 className="text-md">{title}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{intro}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function ServerHealth() {
  const health = useQuery(healthQuery)

  if (health.isPending) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
        <Skeleton className="size-[30px] rounded-md" />
        <span className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-2.5 w-44" />
        </span>
        <p role="status" className="sr-only">
          Checking the server
        </p>
      </div>
    )
  }

  if (health.isError) {
    return (
      <ErrorState
        title="Server not reachable"
        error={health.error}
        onRetry={() => void health.refetch()}
      />
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-sm">
      <span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-muted text-foreground-2">
        <IconCheck aria-hidden="true" className="size-4" stroke={1.75} />
      </span>
      <span className="flex min-w-0 flex-col">
        <b className="font-medium">API</b>
        <small className="text-xs text-muted-foreground">
          <span className="font-mono">/api/health</span> answered
        </small>
      </span>
      <Badge variant="success" className="ml-auto">
        <IconCheck aria-hidden="true" />
        Healthy
      </Badge>
    </div>
  )
}
