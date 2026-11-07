import type { FixRunDeployment, FixRunWarning } from '@hinomi/shared'
import { IconAlertTriangle } from '@tabler/icons-react'
import { Callout } from '@/components/ui/callout'
import { WARNING_LABEL } from '@/lib/fix-run-meta'
import { formatRelative } from '@/lib/format'

/** Warnings about a merged run (watch paths that skip the fix, no deploy seen), shown as they are. */
export function RunWarnings({
  warnings,
  deployments,
}: {
  warnings: readonly FixRunWarning[]
  deployments: readonly FixRunDeployment[]
}) {
  const appName = (id: number | null) =>
    id === null ? null : (deployments.find((d) => d.deploymentId === id)?.name ?? `app ${id}`)
  const only = warnings.length === 1 ? warnings[0] : undefined
  return (
    <Callout
      icon={IconAlertTriangle}
      variant="warn"
      title={only ? WARNING_LABEL[only.code] : `${warnings.length} warnings`}
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {warnings.map((w) => {
          const app = appName(w.deploymentId)
          return (
            <li key={`${w.code}:${w.deploymentId ?? 'run'}`}>
              {only && !app ? null : (
                <b className="font-semibold">
                  {only ? app : WARNING_LABEL[w.code]}
                  {app && !only ? ` on ${app}` : ''}:{' '}
                </b>
              )}
              {w.message}{' '}
              <span className="text-xs text-muted-foreground">{formatRelative(w.at)}</span>
            </li>
          )
        })}
      </ul>
    </Callout>
  )
}
