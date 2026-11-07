import { useState } from 'react'
import type { CheckOverride, GuardInfo, SourceKind } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconArchive, IconPower } from '@tabler/icons-react'
import { GUARD_CHECK_ICON } from '@/components/guards/guard-badges'
import { GuardLevelCounts } from '@/components/guards/guards-card'
import { TurnOffDialog, type TurnOffTarget } from '@/components/guards/turn-off-dialog'
import { ErrorState } from '@/components/states/error-state'
import { CodeText } from '@/components/triage/finding-sections'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate } from '@/lib/finding-meta'
import {
  CAPABILITY_LABEL,
  checkTitle,
  GUARD_LEVEL_LABEL,
  SOURCE_KIND_LABEL,
} from '@/lib/guard-meta'
import { guardsQuery, overridesQuery } from '@/lib/guards-api'
import { SetBox, SetRow, SubHeading } from './settings-section'

function capabilitiesText(info: GuardInfo): string {
  const entries = Object.entries(info.capabilities) as [SourceKind, keyof typeof CAPABILITY_LABEL][]
  if (!entries.length) return 'No scan runs this check yet'
  return entries
    .map(
      ([kind, capability]) =>
        `${SOURCE_KIND_LABEL[kind]}: ${CAPABILITY_LABEL[capability].toLowerCase()}`,
    )
    .join(', ')
}

function overrideSubject(o: CheckOverride): { scope: 'deployment' | 'repo'; name: string } {
  if (o.deployment) return { scope: 'deployment', name: o.deployment.name }
  return { scope: 'repo', name: o.repo?.fullName ?? 'a removed repo' }
}

function Rows({ count }: { count: number }) {
  return (
    <SetBox>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex flex-col gap-2 border-t border-border py-4 first:border-t-0"
        >
          <Skeleton className="h-4 w-[220px]" />
          <Skeleton className="h-3 w-[70%]" />
        </div>
      ))}
    </SetBox>
  )
}

/**
 * The Checks page of Settings: every guard check, what it reads and how much each connected
 * source can answer, then every check turned off, with who it covers and why. Overrides are
 * edited or removed here.
 */
export function ChecksSection() {
  const guards = useQuery(guardsQuery)
  const overrides = useQuery(overridesQuery)
  const [target, setTarget] = useState<TurnOffTarget | null>(null)
  const [notice, setNotice] = useState('')

  return (
    <>
      {guards.error ? (
        <ErrorState
          title="Checks did not load"
          error={guards.error}
          onRetry={() => void guards.refetch()}
        />
      ) : !guards.data ? (
        <>
          <Rows count={4} />
          <p role="status" className="sr-only">
            Loading checks
          </p>
        </>
      ) : (
        <SetBox as="ul" aria-label="Checks">
          {guards.data.items.map((info) => {
            const IconCmp = GUARD_CHECK_ICON[info.check]
            return (
              <SetRow
                key={info.check}
                as="li"
                icon={<IconCmp stroke={1.75} />}
                title={info.title}
                sub={<CodeText text={info.reads} />}
                stackAside
                aside={
                  <Link
                    to="/guards"
                    search={{ check: [info.check] }}
                    className="no-underline hover:underline"
                    aria-label={`${info.title} findings`}
                  >
                    <GuardLevelCounts counts={info.counts} />
                  </Link>
                }
              >
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Sources</dt>
                  <dd className="m-0 text-foreground-2">{capabilitiesText(info)}</dd>
                  <dt className="text-muted-foreground">Can report</dt>
                  <dd className="m-0 text-foreground-2">
                    {info.levels.map((l) => GUARD_LEVEL_LABEL[l].toLowerCase()).join(', ')}
                  </dd>
                  <dt className="text-muted-foreground">Turned off</dt>
                  <dd className="m-0 text-foreground-2">
                    {info.overrides === 0
                      ? 'Nowhere'
                      : `${info.overrides} deployment${info.overrides === 1 ? '' : 's'} or repo${info.overrides === 1 ? '' : 's'}`}
                  </dd>
                </dl>
              </SetRow>
            )
          })}
        </SetBox>
      )}

      <SubHeading
        title="Turned off"
        note={
          overrides.data
            ? `${overrides.data.items.length} override${overrides.data.items.length === 1 ? '' : 's'}`
            : undefined
        }
      />
      <p className="max-w-[70ch] text-sm text-foreground-2">
        A turned off check keeps running. Its finding stays listed under Risk accepted with the
        reason, and is never sent as a notification. Turn a check off from a finding or from a
        deployment's guards panel.
      </p>
      {overrides.error ? (
        <ErrorState
          title="Overrides did not load"
          error={overrides.error}
          onRetry={() => void overrides.refetch()}
        />
      ) : !overrides.data ? (
        <Rows count={2} />
      ) : overrides.data.items.length === 0 ? (
        <SetBox>
          <p className="py-4 text-sm text-muted-foreground">No check is turned off.</p>
        </SetBox>
      ) : (
        <SetBox as="ul" aria-label="Overrides">
          {overrides.data.items.map((o) => {
            const subject = overrideSubject(o)
            const title = checkTitle(o.check)
            const IconCmp =
              o.check in GUARD_CHECK_ICON
                ? GUARD_CHECK_ICON[o.check as keyof typeof GUARD_CHECK_ICON]
                : IconArchive
            return (
              <SetRow
                key={o.id}
                as="li"
                icon={<IconCmp stroke={1.75} />}
                title={title}
                sub={
                  <>
                    For the {subject.scope} <span className="font-mono">{subject.name}</span>, since{' '}
                    {formatDate(o.createdAt)}
                    {o.updatedAt !== o.createdAt
                      ? `, reason edited ${formatDate(o.updatedAt)}`
                      : ''}
                  </>
                }
                aside={
                  <Button
                    size="sm"
                    variant="outline"
                    aria-haspopup="dialog"
                    aria-label={`Edit ${title} for ${subject.name}`}
                    onClick={() =>
                      setTarget({
                        mode: 'edit',
                        check: o.check,
                        override: { id: o.id, scope: subject.scope, reason: o.reason },
                        subject: subject.name,
                      })
                    }
                  >
                    <IconPower aria-hidden="true" />
                    Edit
                  </Button>
                }
              >
                <p className="text-sm text-foreground-2">&ldquo;{o.reason}&rdquo;</p>
              </SetRow>
            )
          })}
        </SetBox>
      )}
      <TurnOffDialog
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
        onDone={setNotice}
      />
      <p role="status" className="sr-only">
        {notice}
      </p>
    </>
  )
}
