import type { DeployRecord, DeploymentDetail } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import {
  IconArrowBackUp,
  IconCircleCheck,
  IconCircleX,
  IconGitCommit,
  IconLoader2,
  IconRocket,
  type Icon,
} from '@tabler/icons-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Feed, Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import { describeError } from '@/lib/errors'
import { formatRelative } from '@/lib/format'
import { deploysQuery } from '@/lib/view-api'

const STATUS: Record<string, { label: string; icon: Icon; tone: string }> = {
  finished: { label: 'Deployed', icon: IconCircleCheck, tone: 'text-success' },
  failed: { label: 'Failed', icon: IconCircleX, tone: 'text-sev-critical' },
  in_progress: { label: 'Deploying', icon: IconLoader2, tone: 'text-accent-ink' },
  queued: { label: 'Queued', icon: IconRocket, tone: 'text-muted-foreground' },
}

function statusOf(d: DeployRecord) {
  if (d.rollback) return { label: 'Rolled back', icon: IconArrowBackUp, tone: 'text-sev-high' }
  return (
    STATUS[d.status] ?? {
      label: d.status.replaceAll('-', ' ').replaceAll('_', ' '),
      icon: IconRocket,
      tone: 'text-muted-foreground',
    }
  )
}

/** Short sha linked to the commit on GitHub when the repo is known. */
function Commit({ sha, repo }: { sha: string; repo: string | undefined }) {
  const short = sha.slice(0, 7)
  if (!repo) return <code className="font-mono text-xs">{short}</code>
  return (
    <a
      href={`https://github.com/${repo}/commit/${encodeURIComponent(sha)}`}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-xs text-accent-ink hover:underline"
    >
      {short}
    </a>
  )
}

/** Recent deploys and their commits, read live from Coolify through the server. */
export function DeploysPanel({ d }: { d: DeploymentDetail }) {
  const query = useQuery({ ...deploysQuery(d.id), retry: false })
  const repo = d.repos[0]?.fullName

  let body: React.ReactNode
  if (query.error) {
    body = (
      <p role="alert" className="text-sm text-muted-foreground">
        Could not load deploys: {describeError(query.error)}
      </p>
    )
  } else if (!query.data) {
    body = (
      <div aria-hidden="true" className="flex flex-col gap-2.5">
        <Skeleton className="h-3.5 w-[80%]" />
        <Skeleton className="h-3.5 w-[60%]" />
        <Skeleton className="h-3.5 w-[70%]" />
      </div>
    )
  } else if (!query.data.available) {
    body = <p className="text-sm text-muted-foreground">{query.data.reason}</p>
  } else if (query.data.items.length === 0) {
    body = <p className="text-sm text-muted-foreground">Coolify has no deploys recorded yet.</p>
  } else {
    body = (
      <Feed
        label="Recent deploys"
        items={query.data.items.map((item) => {
          const status = statusOf(item)
          return {
            key: item.id,
            icon: status.icon,
            tone: status.tone,
            body: (
              <>
                <span className="flex flex-wrap items-center gap-x-1.5">
                  {status.label}
                  {item.commit ? (
                    <>
                      <IconGitCommit
                        aria-hidden="true"
                        className="size-3.5 text-muted-foreground"
                      />
                      <Commit sha={item.commit} repo={repo} />
                    </>
                  ) : null}
                  {item.webhook ? (
                    <span className="text-xs text-muted-foreground">on push</span>
                  ) : null}
                </span>
                {item.commitMessage ? (
                  <span className="block truncate text-foreground-2" title={item.commitMessage}>
                    {item.commitMessage.split('\n')[0]}
                  </span>
                ) : null}
              </>
            ),
            time: item.startedAt ? (
              <time dateTime={item.startedAt} title={new Date(item.startedAt).toLocaleString()}>
                {formatRelative(item.startedAt)}
              </time>
            ) : null,
          }
        })}
      />
    )
  }

  return (
    <Panel>
      <PanelHeader title="Recent deploys" icon={IconRocket} />
      <PanelBody>{body}</PanelBody>
    </Panel>
  )
}
