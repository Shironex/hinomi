import { Link } from '@tanstack/react-router'
import { IconPlugConnected, IconRadar2 } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'

export function OverviewPage() {
  return (
    <>
      <PageHeader title="Exposure">
        Critical or high advisories in runtime code on apps with a public domain, ranked first.
        Everything else stays listed under{' '}
        <Link to="/alerts" className="text-accent-ink hover:underline">
          All alerts
        </Link>
        .
      </PageHeader>
      <EmptyState
        icon={IconRadar2}
        title="No scan yet"
        actions={
          <Button asChild>
            <Link to="/onboarding">
              <IconPlugConnected aria-hidden="true" />
              Connect sources
            </Link>
          </Button>
        }
      >
        Connect Coolify and GitHub and run the first scan. Hinomi joins your running apps with their
        advisories, so the few that are public and critical come first.
      </EmptyState>
    </>
  )
}
