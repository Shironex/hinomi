import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { IconArrowLeft, IconBrandGithub, IconGitBranchDeleted } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { ReleasePanel } from '@/components/repos/release-panel'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { LoadingState } from '@/components/states/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { repoQuery } from '@/lib/settings-api'

const route = getRouteApi('/repos/$id')

/** One repo: what Hinomi knows about it beyond its findings. Today the desktop release tier. */
export function RepoDetailPage() {
  const { id: raw } = route.useParams()
  const id = Number(raw)
  const valid = Number.isInteger(id) && id > 0
  const query = useQuery({ ...repoQuery(valid ? id : 0), enabled: valid })

  if (!valid || (query.error instanceof ApiError && query.error.status === 404)) {
    return (
      <>
        <PageHeader title={<span className="font-mono text-[0.92em]">{raw}</span>} />
        <EmptyState
          icon={IconGitBranchDeleted}
          title="This repo is not known yet"
          actions={
            <Button asChild variant="outline">
              <Link to="/alerts">
                <IconArrowLeft aria-hidden="true" />
                All alerts
              </Link>
            </Button>
          }
        >
          Repos appear after a GitHub source is connected and scanned.
        </EmptyState>
      </>
    )
  }
  if (query.error) {
    return (
      <>
        <PageHeader title={`Repo ${raw}`} />
        <ErrorState
          title="This repo did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </>
    )
  }
  if (!query.data) return <LoadingState layout="detail" label="Loading repo" />

  const repo = query.data
  return (
    <div className="flex max-w-[860px] flex-col">
      <PageHeader
        title={<span className="font-mono text-[0.92em]">{repo.fullName}</span>}
        actions={
          <>
            {repo.archived ? <Badge variant="outline">Archived</Badge> : null}
            <Button asChild variant="outline" size="sm">
              <a
                href={`https://github.com/${repo.fullName}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                <IconBrandGithub aria-hidden="true" />
                GitHub
                <span className="sr-only">(opens on GitHub)</span>
              </a>
            </Button>
          </>
        }
      >
        {repo.lastScannedAt
          ? `Last scanned ${formatRelative(repo.lastScannedAt)}.`
          : 'Not scanned yet.'}
      </PageHeader>
      <ReleasePanel repo={repo} />
    </div>
  )
}
