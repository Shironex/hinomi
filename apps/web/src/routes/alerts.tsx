import { Link } from '@tanstack/react-router'
import { IconListDetails, IconSearch } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

export function AlertsPage() {
  return (
    <>
      <PageHeader title="All alerts">
        Every open alert from GitHub and the OSV lockfile scan, ranked by exposure. Filters narrow
        the view, nothing is removed.
      </PageHeader>
      <div
        role="search"
        className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-card p-2.5"
      >
        <label htmlFor="alert-search" className="sr-only">
          Search alerts
        </label>
        <div className="relative flex min-w-0 flex-1 items-center">
          <IconSearch
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
            stroke={1.75}
          />
          <input
            id="alert-search"
            type="search"
            data-search-input
            placeholder="Package, advisory or repo"
            autoComplete="off"
            className="h-8 w-full min-w-0 rounded-full border border-input bg-card pr-9 pl-8 text-sm placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:outline-offset-[-1px]"
          />
          <Kbd aria-hidden="true" className="absolute right-2.5">
            /
          </Kbd>
        </div>
      </div>
      <EmptyState
        icon={IconListDetails}
        title="No alerts yet"
        actions={
          <Button asChild variant="outline">
            <Link to="/onboarding">Connect GitHub</Link>
          </Button>
        }
      >
        Alerts arrive from Dependabot and from OSV.dev lockfile scans once GitHub is connected.
        Repos that are not deployed are ranked last, never dropped.
      </EmptyState>
    </>
  )
}
