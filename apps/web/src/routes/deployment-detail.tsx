import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { IconArrowLeft, IconServerOff } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { LoadingState } from '@/components/states/loading-state'
import { Button } from '@/components/ui/button'
import { DeploymentDetailView } from '@/components/views/deployment-detail-view'
import { ApiError } from '@/lib/api'
import { deploymentQuery } from '@/lib/view-api'

const route = getRouteApi('/deployments/$id')

/** A deployment on its own page, for links from outside the Deployments split view. */
export function DeploymentDetailPage() {
  const { id: raw } = route.useParams()
  const id = Number(raw)
  const valid = Number.isInteger(id) && id > 0
  const query = useQuery({ ...deploymentQuery(valid ? id : 0), enabled: valid })

  if (!valid || (query.error instanceof ApiError && query.error.status === 404)) {
    return (
      <>
        <PageHeader title={<span className="font-mono text-[0.92em]">{raw}</span>} />
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
  if (query.error) {
    return (
      <>
        <PageHeader title={`Deployment ${raw}`} />
        <ErrorState
          title="This deployment did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </>
    )
  }
  if (!query.data) return <LoadingState layout="detail" label="Loading deployment" />

  return <DeploymentDetailView d={query.data} layout="two" titleLevel={1} />
}
