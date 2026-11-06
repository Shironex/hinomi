import { getRouteApi, Link } from '@tanstack/react-router'
import { IconArrowLeft, IconServerOff } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'

const route = getRouteApi('/deployments/$id')

export function DeploymentDetailPage() {
  const { id } = route.useParams()
  return (
    <>
      <PageHeader title={<span className="font-mono text-[0.92em]">{id}</span>} />
      <EmptyState
        icon={IconServerOff}
        title="This deployment is not known yet"
        actions={
          <Button asChild variant="outline">
            <Link to="/deployments">
              <IconArrowLeft aria-hidden="true" />
              All deployments
            </Link>
          </Button>
        }
      >
        Deployments appear after Coolify is connected and scanned. Apps removed from Coolify drop
        out on the next scan.
      </EmptyState>
    </>
  )
}
