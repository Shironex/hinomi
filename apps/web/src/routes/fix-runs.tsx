import { IconInfoCircle, IconRobot } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Callout } from '@/components/ui/callout'

export function FixRunsPage() {
  return (
    <>
      <PageHeader title="Fix runs">
        Dependency bump agents and where their pull requests are. Agents open PRs, people merge
        them.
      </PageHeader>
      <div className="flex flex-col gap-4">
        <EmptyState icon={IconRobot} title="No fix runs yet">
          Start a fix agent from any exposed finding. Its pull request, checks and deploy are
          tracked here until a rescan verifies the fix.
        </EmptyState>
        <Callout variant="info" icon={IconInfoCircle} title="Agents run one at a time by default">
          They only get the GitHub permissions you grant, and no fix is ever merged automatically.
        </Callout>
      </div>
    </>
  )
}
