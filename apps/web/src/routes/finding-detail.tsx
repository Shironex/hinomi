import { getRouteApi, Link } from '@tanstack/react-router'
import { IconArrowLeft, IconShieldSearch } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'

const route = getRouteApi('/finding/$id')

export function FindingDetailPage() {
  const { id } = route.useParams()
  return (
    <>
      <PageHeader
        title={
          <>
            Finding <span className="font-mono text-[0.92em]">{id}</span>
          </>
        }
      />
      <EmptyState
        icon={IconShieldSearch}
        title="Nothing recorded for this finding"
        actions={
          <Button asChild variant="outline">
            <Link to="/">
              <IconArrowLeft aria-hidden="true" />
              Back to exposure
            </Link>
          </Button>
        }
      >
        Findings appear after a scan. If a notification brought you here, run a scan and open the
        link again; resolved findings keep their history.
      </EmptyState>
    </>
  )
}
