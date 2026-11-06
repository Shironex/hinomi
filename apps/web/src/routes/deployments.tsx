import { Link } from '@tanstack/react-router'
import { IconServer2 } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'

export function DeploymentsPage() {
  return (
    <>
      <PageHeader title="Deployments">
        Every running app with its domains, server and repo, and what is exposed on it.
      </PageHeader>
      <EmptyState
        icon={IconServer2}
        title="No deployments yet"
        actions={
          <Button asChild variant="outline">
            <Link to="/onboarding">Connect Coolify</Link>
          </Button>
        }
      >
        Hinomi reads applications, services and servers from Coolify with a read only token, then
        maps each one to its GitHub repo.
      </EmptyState>
    </>
  )
}
