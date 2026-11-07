import type { FixRunDeployment } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import { IconRocket } from '@tabler/icons-react'
import { StatusText } from '@/components/findings/finding-state'
import { Panel, PanelHeader } from '@/components/views/panel'
import { DEPLOY_STATUS_INFO } from '@/lib/fix-run-meta'
import { formatRelative } from '@/lib/format'

function deployLine(app: FixRunDeployment): string {
  if (app.deploy) {
    const what =
      app.deploy.relation === 'identical' ? 'Deployed the merge commit' : 'Deployed a later commit'
    const when = app.deploy.finishedAt ? `, finished ${formatRelative(app.deploy.finishedAt)}` : ''
    return `${what} ${app.deploy.commit.slice(0, 7)}${when}`
  }
  if (app.status === 'other_branch') {
    return `Deploys ${app.branch ?? 'another branch'}, not the branch the fix merged into, so Hinomi does not wait for it`
  }
  return 'No deploy of the merge commit or a later one yet'
}

/** The apps that deploy the run's repo and the deploy that shipped the fix on each. */
export function RunDeployments({ deployments }: { deployments: readonly FixRunDeployment[] }) {
  return (
    <Panel>
      <PanelHeader title="Deploys" icon={IconRocket} />
      <ul aria-label="Deploys of the fix" className="m-0 list-none p-0">
        {deployments.map((app) => {
          const status = DEPLOY_STATUS_INFO[app.status]
          return (
            <li
              key={app.deploymentId}
              className="flex flex-col gap-1 border-t border-border px-4 py-3 first:border-t-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="min-w-0">
                  <Link
                    to="/deployments/$id"
                    params={{ id: String(app.deploymentId) }}
                    className="font-semibold text-foreground hover:underline"
                  >
                    {app.name}
                  </Link>
                  {app.branch ? (
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {app.branch}
                    </span>
                  ) : null}
                </span>
                <StatusText icon={status.icon} tone={status.tone}>
                  {status.label}
                </StatusText>
              </div>
              <span className="text-sm text-foreground-2">{deployLine(app)}</span>
              <span className="text-xs text-muted-foreground">
                {app.checkedAt ? `Deploys read ${formatRelative(app.checkedAt)}` : 'Not read yet'}
              </span>
              {app.error ? (
                <span className="text-sm text-sev-critical">Last read failed: {app.error}</span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
