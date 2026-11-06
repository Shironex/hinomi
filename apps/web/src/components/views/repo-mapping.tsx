import type { DeploymentDetail } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import { IconChevronRight, IconGitBranch } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { formatDate, MAPPING_SETTINGS } from '@/lib/finding-meta'
import { Panel, PanelBody, PanelHeader } from './panel'

/**
 * How this deployment got its repo, with any overrides. Overrides are edited in one place,
 * Settings under Repo mapping, so this panel only reads them and links there.
 */
export function RepoMappingPanel({ d }: { d: DeploymentDetail }) {
  const auto = d.gitRepository
  return (
    <Panel>
      <PanelHeader title="Repo mapping" icon={IconGitBranch} />
      <PanelBody className="flex flex-col gap-4">
        <p className="text-sm text-foreground-2">
          {d.mapping === 'override'
            ? 'Mapped by hand. These repos replace the one Coolify reports.'
            : d.mapping === 'auto'
              ? `Matched from Coolify${auto ? `: ${auto}` : ''}. Add an override for a monorepo or a renamed repo.`
              : 'Nothing is mapped. Pick the repo this app is built from so Hinomi can read its alerts and lockfile.'}
        </p>
        {d.overrides.length > 0 ? (
          <ul aria-label="Repo overrides" className="m-0 flex list-none flex-col p-0">
            {d.overrides.map((o) => (
              <li
                key={o.repo.id}
                className="flex min-w-0 flex-col border-t border-border py-2 first:border-t-0 first:pt-0"
              >
                <span className="truncate font-mono text-xs">{o.repo.fullName}</span>
                <small className="text-xs text-muted-foreground">
                  {o.note ? `${o.note}, ` : ''}added {formatDate(o.createdAt)}
                </small>
              </li>
            ))}
          </ul>
        ) : null}
        <Button asChild variant={d.mapping === 'none' ? 'default' : 'outline'} size="sm">
          <Link {...MAPPING_SETTINGS} className="self-start">
            {d.mapping === 'none' ? 'Map a repo in Settings' : 'Edit mapping in Settings'}
            <IconChevronRight aria-hidden="true" />
          </Link>
        </Button>
      </PanelBody>
    </Panel>
  )
}
