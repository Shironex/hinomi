import type { FindingDetail } from '@hinomi/shared'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconArrowLeft,
  IconCircleCheck,
  IconClockExclamation,
  IconClockPause,
  IconPower,
  IconShieldCheck,
  IconShieldOff,
  IconShieldSearch,
  type Icon,
} from '@tabler/icons-react'
import { DeferForm } from '@/components/findings/defer-form'
import { TurnOffDialog, type TurnOffTarget } from '@/components/guards/turn-off-dialog'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import type { DeferRequest } from '@/hooks/use-defer-requests'
import { TAB_QUERY, useMediaQuery } from '@/hooks/use-media-query'
import { ApiError } from '@/lib/api'
import type { DeferExpiry } from '@/lib/defer'
import { describeError } from '@/lib/errors'
import { decisionLabel, formatDate } from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { isRepoCheck } from '@/lib/guard-meta'
import { isTypingTarget } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import {
  deferFinding,
  findingQuery,
  refreshAfterDecision,
  reopenFinding,
  type DeferKind,
} from '@/lib/view-api'
import {
  AdvisorySection,
  AffectedApps,
  DetailsList,
  FindingHead,
  FixCard,
  GuardEvidenceSection,
  GuardExplanation,
  HistorySection,
  NotificationsSection,
  PaneSection,
  StillSees,
  WhyItRanks,
} from './finding-sections'

function Banner({
  tone = 'neutral',
  icon: IconCmp,
  title,
  children,
}: {
  tone?: 'neutral' | 'warn' | 'ok'
  icon: Icon
  title: string
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
        tone === 'neutral' && 'border-dashed border-input bg-sidebar',
        tone === 'warn' &&
          'border-[color-mix(in_oklch,var(--sev-high)_35%,transparent)] bg-sev-high-soft',
        tone === 'ok' && 'border-transparent bg-success-soft',
      )}
    >
      <IconCmp
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'warn' ? 'text-sev-high' : tone === 'ok' ? 'text-success' : 'text-foreground-2',
        )}
        stroke={1.75}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <b className="font-semibold">{title}</b>
        {children}
      </div>
    </div>
  )
}

/** Decisions, upstream dismissals, fixes and expiries, above the reasons. */
function StateBanner({
  f,
  onReopen,
  reopening,
  reopenError,
  onEditOverride,
}: {
  f: FindingDetail
  onReopen: () => void
  reopening: boolean
  reopenError: string | null
  onEditOverride: () => void
}) {
  const override = f.guard?.override
  if (override && f.state === 'accepted') {
    return (
      <Banner
        icon={IconPower}
        title={`Turned off for ${override.scope === 'repo' ? 'the whole repo' : 'this deployment'}, ${formatDate(override.createdAt)}`}
      >
        <span className="text-foreground-2">{override.reason}</span>
        <span className="text-xs text-muted-foreground">
          The check keeps running and this finding stays listed as accepted, with its level and
          evidence kept current. It is never sent as a notification.
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onEditOverride} aria-haspopup="dialog">
            Edit reason or turn back on
          </Button>
        </span>
      </Banner>
    )
  }
  if (f.state === 'snoozed' || f.state === 'accepted') {
    const by = f.history.find((e) => e.type === f.state)
    return (
      <Banner
        icon={IconClockPause}
        title={`${decisionLabel(f)}${by ? `, decided ${formatRelative(by.at)}` : ''}`}
      >
        {f.stateReason ? <span className="text-foreground-2">{f.stateReason}</span> : null}
        <span className="text-xs text-muted-foreground">
          {f.stateUntilNewAdvisory
            ? 'It stays in the ranking, drawn as decided, and returns to the top when a scan finds a new advisory for the same package.'
            : 'It stays in the ranking, drawn as decided, and returns to the top when the expiry passes.'}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onReopen} disabled={reopening}>
            {reopening ? 'Removing' : 'Remove decision'}
          </Button>
          {reopenError ? (
            <span role="alert" className="text-xs text-sev-critical">
              {reopenError}
            </span>
          ) : null}
        </span>
      </Banner>
    )
  }
  if (f.state === 'dismissed_upstream') {
    return (
      <Banner icon={IconShieldOff} title="Dismissed on GitHub">
        <span className="text-foreground-2">
          Someone dismissed the GitHub alert and no other source reports it. It is never counted as
          fixed. Snooze or accept it here to record a reason and an expiry.
        </span>
      </Banner>
    )
  }
  if (f.state === 'fixed') {
    return (
      <Banner
        tone="ok"
        icon={f.kind === 'advisory' ? IconShieldCheck : IconCircleCheck}
        title={f.kind === 'advisory' ? 'Fixed' : 'Resolved'}
      >
        <span className="text-foreground-2">
          {f.kind === 'advisory'
            ? 'No source reports it anymore'
            : f.kind === 'coverage_note'
              ? 'The deployment has a repo now, or is gone'
              : 'Coverage came back'}
          {f.fixedAt ? `, ${formatRelative(f.fixedAt)}` : ''}. The history stays below.
        </span>
      </Banner>
    )
  }
  const latest = f.history[0]
  if (
    f.state === 'open' &&
    latest &&
    (latest.type === 'snooze_expired' || latest.type === 'acceptance_expired')
  ) {
    const decision = f.history.find((e) => e.type === 'snoozed' || e.type === 'accepted')
    return (
      <Banner
        tone="warn"
        icon={IconClockExclamation}
        title={`${latest.type === 'snooze_expired' ? 'Snooze' : 'Accepted risk'} expired ${formatRelative(latest.at)}`}
      >
        <span className="text-foreground-2">
          {decision?.reason ? <>The reason was: &ldquo;{decision.reason}&rdquo; </> : null}
          It is back in the ranking and alerts again.
        </span>
      </Banner>
    )
  }
  return null
}

function PaneSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-[280px]" />
        <Skeleton className="h-7 w-[min(520px,90%)]" />
        <Skeleton className="h-4 w-[360px]" />
        <Skeleton className="mt-4 h-[120px] w-full rounded-lg" />
        <Skeleton className="h-[140px] w-full rounded-lg" />
      </div>
      <p role="status" className="sr-only">
        Loading finding
      </p>
    </div>
  )
}

/**
 * The detail of one finding, advisory or blind spot: why it ranks, the fix, where it runs, the
 * advisory and its history, with snooze, accept and reopen. Used by the split views' detail
 * pane and by the finding page. `layout="two"` (focus view, finding page) puts the apps and
 * the details in a side column.
 */
export function FindingPane({
  id,
  rank,
  layout = 'stack',
  deferRequest,
  keys = false,
  onMissing,
}: {
  id: number
  /** Position in a ranked list, shown in the "Why it ranks" heading. */
  rank?: number
  layout?: 'stack' | 'two'
  deferRequest?: DeferRequest | null
  /** Handle s and a here (the finding page); split views route them through their actions. */
  keys?: boolean
  /** Shown instead of the generic message when the finding does not exist. */
  onMissing?: ReactNode
}) {
  const queryClient = useQueryClient()
  const query = useQuery(findingQuery(id))
  const tabWide = useMediaQuery(TAB_QUERY)
  const [deferOpen, setDeferOpen] = useState<DeferKind | null>(null)
  const [notice, setNotice] = useState('')
  const [turnOff, setTurnOff] = useState<TurnOffTarget | null>(null)
  const formRef = useRef<HTMLDivElement>(null)

  const defer = useMutation({
    mutationFn: ({ kind: k, ...body }: { kind: DeferKind; reason: string } & DeferExpiry) =>
      deferFinding(id, k, body),
    onSuccess: async (detail, v) => {
      setDeferOpen(null)
      setNotice(
        v.kind === 'snooze'
          ? 'Snoozed. It stays listed with your reason.'
          : 'Risk accepted. It stays listed with your reason.',
      )
      await refreshAfterDecision(queryClient, detail)
    },
  })
  const reopen = useMutation({
    mutationFn: () => reopenFinding(id),
    onSuccess: async (detail) => {
      setNotice('Decision removed. The finding is open again.')
      await refreshAfterDecision(queryClient, detail)
    },
  })

  const canDefer = query.data ? query.data.state !== 'fixed' : false
  const openDefer = (kind: DeferKind) => {
    if (!canDefer) return
    defer.reset()
    setDeferOpen(kind)
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView?.({ block: 'nearest' })
      formRef.current?.querySelector<HTMLElement>('textarea')?.focus()
    })
  }
  const openRef = useRef(openDefer)
  useEffect(() => {
    openRef.current = openDefer
  })

  // s or a pressed on the list: open the form here once the finding has loaded.
  const pending = deferRequest && deferRequest.id === id ? deferRequest : null
  const handled = useRef(0)
  const loaded = query.data !== undefined
  useEffect(() => {
    if (!pending || pending.n === handled.current || !loaded) return
    handled.current = pending.n
    openRef.current(pending.kind)
  }, [pending, loaded])

  useEffect(() => {
    if (!keys || !canDefer) return
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 's' && event.key !== 'a') return
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      openRef.current(event.key === 's' ? 'snooze' : 'accept')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [keys, canDefer])

  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      onMissing ?? (
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
          It may have been removed by a rescan. Resolved findings keep their history.
        </EmptyState>
      )
    )
  }
  if (query.error) {
    return (
      <ErrorState
        title="This finding did not load"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (!query.data) return <PaneSkeleton />

  const f = query.data
  const two = layout === 'two'
  const guard = f.guard
  const openTurnOff = guard
    ? () => {
        const app = f.deployments[0]
        if (guard.override) {
          setTurnOff({
            mode: 'edit',
            check: guard.check,
            override: guard.override,
            subject:
              (guard.override.scope === 'repo' ? f.repo?.fullName : app?.name) ?? 'this subject',
          })
          return
        }
        setTurnOff({
          mode: 'create',
          check: guard.check,
          deployment: !isRepoCheck(guard.check) && app ? { id: app.id, name: app.name } : null,
          repo: f.repo ? { id: f.repo.id, fullName: f.repo.fullName } : null,
        })
      }
    : undefined
  const banner = (
    <StateBanner
      f={f}
      onReopen={() => reopen.mutate()}
      reopening={reopen.isPending}
      reopenError={reopen.error ? describeError(reopen.error) : null}
      onEditOverride={() => openTurnOff?.()}
    />
  )
  const form =
    deferOpen !== null ? (
      <div ref={formRef} id="defer-panel">
        <Panel>
          <PanelHeader title="Snooze or accept risk" icon={IconClockPause} />
          <PanelBody>
            <DeferForm
              kind={deferOpen}
              onKindChange={setDeferOpen}
              allowNewAdvisory={f.kind === 'advisory'}
              pending={defer.isPending}
              error={defer.error ? describeError(defer.error) : null}
              onSubmit={(k, body) => defer.mutate({ kind: k, ...body })}
              onCancel={() => setDeferOpen(null)}
            />
          </PanelBody>
        </Panel>
      </div>
    ) : null
  const head = (
    <FindingHead
      f={f}
      big={two}
      actions={{
        deferOpen,
        onDefer: (kind) => (deferOpen === kind ? setDeferOpen(null) : openDefer(kind)),
        onTurnOff: openTurnOff,
      }}
    />
  )
  const status = (
    <>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {guard ? (
        <TurnOffDialog
          target={turnOff}
          onOpenChange={(open) => !open && setTurnOff(null)}
          onDone={setNotice}
        />
      ) : null}
    </>
  )

  if (two) {
    return (
      <>
        {head}
        {banner}
        {form}
        <div className="grid items-start gap-8 desk:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-8">
            <WhyItRanks f={f} rank={rank} />
            <GuardExplanation f={f} />
            <GuardEvidenceSection f={f} />
            <FixCard f={f} />
            <StillSees f={f} />
            <AdvisorySection f={f} />
            <HistorySection f={f} />
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            <Panel className="p-5">
              <AffectedApps f={f} />
            </Panel>
            <Panel className="p-5">
              <h2 className="sr-only">Details</h2>
              <DetailsList f={f} />
            </Panel>
            <Panel className="p-5">
              <NotificationsSection f={f} />
            </Panel>
          </div>
        </div>
        {status}
      </>
    )
  }

  return (
    <>
      {head}
      {banner}
      {form}
      <WhyItRanks f={f} rank={rank} />
      <GuardExplanation f={f} />
      <GuardEvidenceSection f={f} />
      <FixCard f={f} compact={!tabWide} />
      {f.kind === 'blind_spot' ? <StillSees f={f} /> : null}
      <AffectedApps f={f} />
      {f.kind === 'coverage_note' ? <StillSees f={f} /> : null}
      <AdvisorySection f={f} />
      <HistorySection f={f} />
      <NotificationsSection f={f} />
      <PaneSection title="Details">
        <DetailsList f={f} className="max-w-[520px]" />
      </PaneSection>
      {status}
    </>
  )
}
