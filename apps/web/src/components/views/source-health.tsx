import type { SourceHealth } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconCheck,
  IconDatabase,
  IconKey,
  IconServer2,
  type Icon,
} from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatRelative } from '@/lib/format'
import { Panel, PanelBody, PanelHeader } from './panel'

const KIND: Record<SourceHealth['kind'], { icon: Icon; label: string }> = {
  coolify: { icon: IconServer2, label: 'Coolify' },
  github: { icon: IconBrandGithub, label: 'GitHub alerts' },
  osv: { icon: IconDatabase, label: 'OSV.dev lockfile scan' },
}

function statusBadge(source: SourceHealth) {
  switch (source.status) {
    case 'ok':
      return (
        <Badge variant="success">
          <IconCheck aria-hidden="true" />
          Synced
        </Badge>
      )
    case 'error':
      return (
        <Badge variant="critical">
          <IconAlertTriangle aria-hidden="true" />
          Error
        </Badge>
      )
    case 'missing_token':
      return (
        <Badge variant="high">
          <IconKey aria-hidden="true" />
          No token
        </Badge>
      )
    case 'disabled':
      return <Badge variant="outline">Off</Badge>
    case 'never':
      return <Badge variant="outline">Not synced yet</Badge>
  }
}

function detail(source: SourceHealth): string {
  if (source.status === 'error') return source.lastError ?? 'The last sync failed'
  if (source.status === 'missing_token') return 'Add a token in settings to turn it on'
  if (source.status === 'disabled') return 'Switched off in settings'
  if (source.lastOkAt) return `Last synced ${formatRelative(source.lastOkAt)}`
  return 'Waits for the next scan'
}

/** Health of every connected source, so a silent source is never mistaken for a clean one. */
export function SourceHealthPanel({ sources }: { sources: readonly SourceHealth[] }) {
  return (
    <Panel>
      <PanelHeader title="Sources">
        <Button asChild variant="ghost" size="sm">
          <Link to="/settings">Manage</Link>
        </Button>
      </PanelHeader>
      <PanelBody>
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sources connected yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {sources.map((source) => {
              const kind = KIND[source.kind]
              return (
                <li
                  key={source.id}
                  className="flex items-center gap-2.5 border-t border-border py-2.5 text-sm first:border-t-0 first:pt-0 last:pb-0"
                >
                  <span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-muted text-foreground-2">
                    <kind.icon aria-hidden="true" className="size-4" stroke={1.75} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <b className="truncate font-medium">
                      {kind.label}
                      {source.name && source.name !== source.kind ? (
                        <span className="font-normal text-muted-foreground"> {source.name}</span>
                      ) : null}
                    </b>
                    <small
                      className={
                        source.status === 'error'
                          ? 'line-clamp-2 text-xs text-sev-critical'
                          : 'truncate text-xs text-muted-foreground'
                      }
                    >
                      {detail(source)}
                    </small>
                  </span>
                  <span className="ml-auto">{statusBadge(source)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </PanelBody>
    </Panel>
  )
}
