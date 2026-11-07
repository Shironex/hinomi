import { useState } from 'react'
import {
  GUARD_CHECKS,
  type DeploymentDetail,
  type DeploymentGuard,
  type GuardCheck,
  type GuardResult,
} from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import { IconArchive, IconPower, IconShieldHalf } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/views/panel'
import { formatDate } from '@/lib/finding-meta'
import { checkTitle, evidenceSummary } from '@/lib/guard-meta'
import { GUARD_CHECK_ICON, GuardResultBadge } from './guard-badges'
import { TurnOffDialog, type TurnOffTarget } from './turn-off-dialog'

const ORDER: Record<GuardResult | 'none', number> = {
  fail: 0,
  warn: 1,
  unknown: 2,
  pass: 3,
  none: 4,
}

const isGuardCheck = (check: string): check is GuardCheck =>
  (GUARD_CHECKS as readonly string[]).includes(check)

function detailLine(g: DeploymentGuard): string {
  if (g.evidence) return evidenceSummary(g.evidence, g.result)
  if (g.result === null) return 'No scan has run this check here yet.'
  if (g.result === 'pass') return 'Nothing found.'
  return isGuardCheck(g.check) ? '' : 'Open on this deployment.'
}

/**
 * Every check's result on one deployment, pass and unknown included, worst first. A check that
 * reports something can be turned off here for the deployment (or its repo), with a reason.
 */
export function DeploymentGuardsPanel({ d }: { d: DeploymentDetail }) {
  const [target, setTarget] = useState<TurnOffTarget | null>(null)
  const [notice, setNotice] = useState('')
  if (d.guards.length === 0) return null
  const rows = [...d.guards].sort((a, b) => ORDER[a.result ?? 'none'] - ORDER[b.result ?? 'none'])
  const failing = rows.filter((g) => g.result === 'fail' && !g.override).length
  const warning = rows.filter((g) => g.result === 'warn' && !g.override).length
  const repo = d.repos.length === 1 ? d.repos[0]! : null

  const describe = [
    failing ? `${failing} failing` : null,
    warning ? `${warning} warning` : null,
  ].filter(Boolean)

  return (
    <Section
      title="Guards"
      titleId="dep-guards"
      description={describe.length ? describe.join(', ') : 'Nothing failing'}
    >
      <ul
        aria-labelledby="dep-guards"
        className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-border bg-card p-0"
      >
        {rows.map((g) => {
          const IconCmp = isGuardCheck(g.check) ? GUARD_CHECK_ICON[g.check] : IconArchive
          const title = checkTitle(g.check)
          const reports = g.result === 'fail' || g.result === 'warn' || g.result === 'unknown'
          const line = detailLine(g)
          return (
            <li
              key={g.check}
              className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-border px-4 py-3 text-sm first:border-t-0"
            >
              <IconCmp
                aria-hidden="true"
                className="mt-0.5 size-4 text-foreground-2"
                stroke={1.75}
              />
              <span className="min-w-0 font-medium">
                {g.findingId ? (
                  <Link
                    to="/finding/$id"
                    params={{ id: String(g.findingId) }}
                    className="text-foreground hover:underline"
                  >
                    {title}
                  </Link>
                ) : (
                  title
                )}
              </span>
              <GuardResultBadge result={g.result} />
              {line ? (
                <span className="col-start-2 col-end-4 text-xs break-words text-muted-foreground">
                  {line}
                </span>
              ) : null}
              {g.override ? (
                <span className="col-start-2 col-end-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="inline-flex items-center gap-1 font-medium text-foreground-2">
                    <IconPower aria-hidden="true" className="size-3.5" stroke={1.75} />
                    Turned off for the {g.override.scope}, {formatDate(g.override.createdAt)}:
                  </span>
                  <span className="text-foreground-2">{g.override.reason}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-haspopup="dialog"
                    aria-label={`Edit why ${title} is off`}
                    onClick={() =>
                      setTarget({
                        mode: 'edit',
                        check: g.check,
                        override: g.override!,
                        subject:
                          g.override!.scope === 'repo' ? (repo?.fullName ?? 'the repo') : d.name,
                      })
                    }
                  >
                    Edit
                  </Button>
                </span>
              ) : reports ? (
                <span className="col-start-2 col-end-4">
                  <Button
                    size="xs"
                    variant="outline"
                    aria-haspopup="dialog"
                    aria-label={`Turn off ${title} for this deployment`}
                    onClick={() =>
                      setTarget({
                        mode: 'create',
                        check: g.check,
                        deployment: { id: d.id, name: d.name },
                        repo: repo ? { id: repo.id, fullName: repo.fullName } : null,
                        scope: 'deployment',
                      })
                    }
                  >
                    <IconPower aria-hidden="true" />
                    Turn off
                  </Button>
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <IconShieldHalf aria-hidden="true" className="mt-px size-3.5 shrink-0" stroke={1.75} />
        Unknown means this source cannot give the signal, never a pass. A turned off check keeps
        running; its finding stays listed as accepted.
      </p>
      <TurnOffDialog
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
        onDone={setNotice}
      />
      <p role="status" className="sr-only">
        {notice}
      </p>
    </Section>
  )
}
