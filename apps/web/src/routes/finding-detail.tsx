import { getRouteApi, Link } from '@tanstack/react-router'
import { IconArrowLeft, IconShieldSearch } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { FindingPane } from '@/components/triage/finding-pane'
import { Button } from '@/components/ui/button'

const route = getRouteApi('/finding/$id')

function Missing({ raw }: { raw: string }) {
  return (
    <>
      <PageHeader
        title={
          <>
            Finding <span className="font-mono">{raw}</span>
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

/**
 * A finding on its own page, for links from notifications, deployments and fixes: the same
 * detail as the split views' focus view, with s and a for snooze and accept.
 */
export function FindingDetailPage() {
  const { id: raw } = route.useParams()
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) return <Missing raw={raw} />
  return (
    <div className="flex max-w-[1220px] flex-col gap-[26px]">
      <FindingPane key={id} id={id} layout="two" keys onMissing={<Missing raw={raw} />} />
    </div>
  )
}
