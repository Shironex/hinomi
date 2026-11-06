import { Link } from '@tanstack/react-router'
import { IconMapQuestion } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        icon={IconMapQuestion}
        title="There is nothing at this address"
        actions={
          <Button asChild variant="outline">
            <Link to="/">Go to exposure</Link>
          </Button>
        }
      >
        The link may be old, or the page moved. Press <kbd className="font-mono">?</kbd> to see the
        keyboard shortcuts for every view.
      </EmptyState>
    </>
  )
}
