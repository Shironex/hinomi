import type { FindingDetail } from '@hinomi/shared'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import {
  IconArrowLeft,
  IconCircleCheck,
  IconClockExclamation,
  IconClockPause,
  IconExternalLink,
  IconEyeOff,
  IconLock,
  IconPackage,
  IconServer2,
  IconShieldCheck,
  IconShieldOff,
  IconShieldSearch,
  IconWorld,
  type Icon,
} from '@tabler/icons-react'
import { DeferForm } from '@/components/findings/defer-form'
import { eventIcon, eventTone } from '@/components/findings/event-icon'
import { FindingStateText } from '@/components/findings/finding-state'
import { RankMarker } from '@/components/findings/rank-marker'
import { BlindSpotBadge, SeverityBadge } from '@/components/findings/severity-badge'
import { SEVERITY_ICON } from '@/lib/view-icons'
import { SourceBadge } from '@/components/findings/source-badge'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { LoadingState } from '@/components/states/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Feed, KeyValues, Panel, PanelBody, PanelHeader, Section } from '@/components/views/panel'
import { ApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import {
  BLIND_SPOT_INFO,
  blindSpotSubject,
  decisionLabel,
  displayDomain,
  eventSentence,
  factorFlags,
  findingTitle,
  formatDate,
  isDecided,
  SCOPE_LABEL,
  SEVERITY_LABEL,
  sourcesLabel,
  TIER_INFO,
  tierTitle,
} from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { isTypingTarget } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import {
  deferFinding,
  findingQuery,
  refreshAfterDecision,
  reopenFinding,
  type DeferKind,
} from '@/lib/view-api'

const route = getRouteApi('/finding/$id')

/** "network" from a CVSS vector's AV part. */
function attackVector(vector: string | null): string | null {
  const av = vector?.match(/AV:([NALP])/)?.[1]
  if (!av) return null
  return { N: 'network', A: 'adjacent network', L: 'local', P: 'physical' }[av] ?? null
}

function WhyCell({
  icon: IconCmp,
  label,
  value,
  sub,
  on,
}: {
  icon: Icon
  label: string
  value: React.ReactNode
  sub: React.ReactNode
  on: boolean | null
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-border px-3.5 py-3 max-tab:nth-[-n+2]:border-b max-tab:odd:border-r tab:not-last:border-r">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <IconCmp
          aria-hidden="true"
          className={cn('size-3.5', on ? 'text-sev-critical' : 'text-muted-foreground')}
          stroke={1.75}
        />
        {label}
      </span>
      <span className="text-sm font-medium">{value}</span>
      <span className="truncate text-xs text-muted-foreground">{sub}</span>
    </div>
  )
}

function WhyItRanks({ f }: { f: FindingDetail }) {
  const flags = factorFlags(f)
  const servers = [...new Set(f.deployments.map((d) => d.server).filter(Boolean))]
  const publicDeps = f.deployments.filter((d) => d.reach === 'public')
  const domains = publicDeps.flatMap((d) => d.domains)
  const top = f.tier === 'exposed' || f.tier === 'blind_spot'
  const blind = f.kind === 'blind_spot'
  const av = attackVector(f.advisory?.cvssVector ?? null)
  return (
    <Section
      title={
        blind
          ? 'Why this ranks like a critical'
          : top
            ? 'Why this ranks at the top'
            : 'Why it ranks here'
      }
      description={top ? undefined : tierTitle(f.tier)}
      actions={<RankMarker flags={flags} strong={top && !isDecided(f.state)} />}
    >
      <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card tab:grid-cols-4">
        {blind ? (
          <WhyCell
            icon={IconEyeOff}
            label="Coverage"
            value={f.blindSpotType ? BLIND_SPOT_INFO[f.blindSpotType].short : 'Unknown'}
            sub={`Since ${formatDate(f.firstSeenAt)}`}
            on
          />
        ) : (
          <WhyCell
            icon={SEVERITY_ICON[f.factors.severity]}
            label="Severity"
            value={
              <>
                {SEVERITY_LABEL[f.factors.severity]}
                {f.advisory?.cvssScore != null ? `, CVSS ${f.advisory.cvssScore.toFixed(1)}` : ''}
              </>
            }
            sub={
              f.unscored
                ? 'Unscored, ranked as moderate'
                : av
                  ? `Attack vector: ${av}`
                  : 'No CVSS vector published'
            }
            on={flags[0]}
          />
        )}
        {blind ? (
          <WhyCell
            icon={IconPackage}
            label="Severity and runtime"
            value="Unknown"
            sub="Nothing can be read here"
            on={null}
          />
        ) : (
          <WhyCell
            icon={IconPackage}
            label="Runtime"
            value={
              f.scope === 'runtime'
                ? 'In dependencies'
                : f.scope === 'dev'
                  ? 'Dev dependency'
                  : 'Scope unknown'
            }
            sub={f.dependency.manifestPaths[0] ?? 'No manifest reported'}
            on={flags[1]}
          />
        )}
        <WhyCell
          icon={IconServer2}
          label="Deployed"
          value={
            f.deployments.length
              ? `${f.deployments.length} ${f.stopped ? 'stopped' : 'running'} app${f.deployments.length === 1 ? '' : 's'}`
              : 'Not deployed'
          }
          sub={servers.join(', ') || 'No deployment runs this repo'}
          on={flags[2]}
        />
        <WhyCell
          icon={IconWorld}
          label="Public"
          value={
            domains[0]
              ? displayDomain(domains[0])
              : f.deployments.length
                ? 'Internal only'
                : 'No domain'
          }
          sub={
            domains.length
              ? `${domains.length} public domain${domains.length === 1 ? '' : 's'}`
              : 'No public domain'
          }
          on={flags[3]}
        />
      </div>
    </Section>
  )
}

function Banner({
  tone = 'neutral',
  icon: IconCmp,
  title,
  children,
}: {
  tone?: 'neutral' | 'warn' | 'ok'
  icon: Icon
  title: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'mb-5 flex items-start gap-3 rounded-lg border px-3.5 py-3 text-sm',
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

function StateBanner({
  f,
  onReopen,
  reopening,
  reopenError,
}: {
  f: FindingDetail
  onReopen: () => void
  reopening: boolean
  reopenError: string | null
}) {
  if (f.state === 'snoozed' || f.state === 'accepted') {
    const by = f.history.find((e) => e.type === f.state)
    return (
      <Banner
        icon={IconClockPause}
        title={`${decisionLabel(f)}${by ? `, decided ${formatRelative(by.at)}` : ''}`}
      >
        {f.stateReason ? <span className="text-foreground-2">{f.stateReason}</span> : null}
        <span className="text-xs text-muted-foreground">
          It stays in the ranking, drawn as decided, and returns to the top when the expiry passes.
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
        icon={f.kind === 'blind_spot' ? IconCircleCheck : IconShieldCheck}
        title={f.kind === 'blind_spot' ? 'Resolved' : 'Fixed'}
      >
        <span className="text-foreground-2">
          {f.kind === 'blind_spot' ? 'Coverage came back' : 'No source reports it anymore'}
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

function Actions({
  f,
  onDefer,
  open,
  className,
}: {
  f: FindingDetail
  onDefer: () => void
  open: boolean
  className?: string
}) {
  const canDefer = f.state !== 'fixed'
  return (
    <Panel className={cn('flex flex-col gap-2 p-4', className)}>
      {canDefer ? (
        <Button
          variant="outline"
          onClick={onDefer}
          aria-expanded={open}
          aria-controls="defer-panel"
        >
          <IconClockPause aria-hidden="true" />
          {isDecided(f.state) ? 'Change decision' : 'Snooze or accept risk'}
          <Kbd aria-hidden="true" className="ml-1">
            S
          </Kbd>
        </Button>
      ) : null}
      {f.advisory?.url ? (
        <Button asChild variant="ghost">
          <a href={f.advisory.url} target="_blank" rel="noreferrer noopener">
            <IconExternalLink aria-hidden="true" />
            Open advisory
          </a>
        </Button>
      ) : null}
      {f.kind === 'blind_spot' && f.repo ? (
        <Button asChild variant="ghost">
          <a
            href={`https://github.com/${f.repo.fullName}/settings/security_analysis`}
            target="_blank"
            rel="noreferrer noopener"
          >
            <IconExternalLink aria-hidden="true" />
            Repo security settings
          </a>
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">The fix agent arrives in phase 1.</p>
    </Panel>
  )
}

function Affected({ f }: { f: FindingDetail }) {
  return (
    <Section title="Affected deployments" description={f.deployments.length ? undefined : 'None'}>
      {f.deployments.length ? (
        <Panel className="flex flex-col px-4 py-1">
          {f.deployments.map((d) => (
            <Link
              key={d.id}
              to="/deployments/$id"
              params={{ id: String(d.id) }}
              className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-t border-border py-2.5 text-inherit no-underline first:border-t-0"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <b className="font-medium group-hover:underline">{d.name}</b>
                <small className="text-xs text-muted-foreground">
                  {[
                    d.domains.map(displayDomain).join(', ') || 'No domain',
                    d.server ? `on ${d.server}` : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </small>
              </span>
              {f.repo?.alertsEnabled === false ? (
                <Badge variant="high">
                  <IconEyeOff aria-hidden="true" />
                  Alerts off, via OSV
                </Badge>
              ) : d.reach === 'public' ? (
                <Badge variant="accent">
                  <IconWorld aria-hidden="true" />
                  Public
                </Badge>
              ) : (
                <Badge variant="outline">
                  <IconLock aria-hidden="true" />
                  Internal
                </Badge>
              )}
            </Link>
          ))}
        </Panel>
      ) : (
        <p className="text-sm text-muted-foreground">
          No deployment runs{' '}
          {f.repo ? <span className="font-mono">{f.repo.fullName}</span> : 'this'}, so it ranks
          last. Map the repo to a deployment if it does run somewhere.
        </p>
      )}
    </Section>
  )
}

function Advisory({ f }: { f: FindingDetail }) {
  const a = f.advisory
  if (!a) return null
  const ranges = f.versions.vulnerableRanges.length
    ? f.versions.vulnerableRanges
    : a.vulnerableRanges
  const path = [
    f.repo?.fullName ?? 'repo',
    ...f.dependency.manifestPaths.slice(0, 1),
    `${a.packageName}@${f.versions.installed ?? '?'}`,
  ]
  return (
    <Section title="Advisory">
      <div className="flex max-w-[68ch] flex-col gap-2.5 text-foreground-2">
        <p>{a.summary ?? 'The advisory has no summary.'}</p>
        {a.withdrawnAt ? (
          <p className="text-sev-high">Withdrawn {formatDate(a.withdrawnAt)}.</p>
        ) : null}
        <p>
          Vulnerable range{' '}
          {ranges.length
            ? ranges.map((r, i) => (
                <span key={r}>
                  {i > 0 ? ', ' : ''}
                  <code className="rounded-sm bg-muted px-1.5 py-px font-mono text-[0.88em] text-foreground">
                    {r}
                  </code>
                </span>
              ))
            : 'not published'}
          .{' '}
          {f.versions.firstPatched ? (
            <>
              First patched version{' '}
              <code className="rounded-sm bg-muted px-1.5 py-px font-mono text-[0.88em] text-foreground">
                {f.versions.firstPatched}
              </code>
              .
            </>
          ) : (
            'No patched version is published yet.'
          )}
        </p>
      </div>
      <pre
        aria-label="Dependency path"
        className="m-0 overflow-x-auto rounded-md border border-border bg-sidebar px-3 py-2.5 font-mono text-xs leading-[1.8] text-foreground-2"
      >
        {path.map((p, i) => (
          <span key={i} className="block">
            {i > 0 ? `${'  '.repeat(i - 1)}└ ` : ''}
            {i === path.length - 1 ? <b className="font-medium text-sev-critical">{p}</b> : p}
          </span>
        ))}
      </pre>
    </Section>
  )
}

function HowToClose({ f }: { f: FindingDetail }) {
  if (!f.blindSpotType) return null
  const steps = BLIND_SPOT_INFO[f.blindSpotType].fix
  return (
    <Section title="How to close it">
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {steps.map(([title, detail], i) => (
          <li key={title} className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-3">
            <span className="grid size-7 place-items-center rounded-full border-[1.5px] border-input font-mono text-[11px] text-muted-foreground">
              {i + 1}
            </span>
            <div className="pt-1">
              <div className="text-sm font-medium">
                {title === 'Map the repo it is built from' && f.deployments[0] ? (
                  <Link
                    to="/deployments/$id"
                    params={{ id: String(f.deployments[0].id) }}
                    className="text-accent-ink hover:underline"
                  >
                    {title}
                  </Link>
                ) : (
                  title
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}

function History({ f }: { f: FindingDetail }) {
  return (
    <Section title="Decisions and history">
      <Panel className="p-4">
        {f.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events recorded yet.</p>
        ) : (
          <Feed
            label="Decisions and history"
            items={f.history.map((e) => ({
              key: e.id,
              icon: eventIcon(e.type),
              tone: eventTone(e.type),
              body: (
                <>
                  {eventSentence(e)}
                  {e.reason ? (
                    <span className="block text-foreground-2">&ldquo;{e.reason}&rdquo;</span>
                  ) : null}
                </>
              ),
              time: (
                <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                  {formatRelative(e.at)}
                </time>
              ),
            }))}
          />
        )}
      </Panel>
    </Section>
  )
}

function Details({ f }: { f: FindingDetail }) {
  const a = f.advisory
  const items: { label: string; value: React.ReactNode; mono?: boolean }[] = []
  if (f.repo) items.push({ label: 'Repo', value: f.repo.fullName, mono: true })
  if (f.kind === 'advisory') {
    items.push({
      label: 'Manifest',
      value: f.dependency.manifestPaths.join(', ') || 'Unknown',
      mono: true,
    })
    items.push({ label: 'Scope', value: SCOPE_LABEL[f.dependency.scope] })
    items.push({ label: 'Source', value: sourcesLabel(f.sources) })
    if (a) items.push({ label: 'Ecosystem', value: a.ecosystem })
    if (a?.publishedAt) items.push({ label: 'Published', value: formatDate(a.publishedAt) })
  }
  items.push({ label: 'Tier', value: TIER_INFO[f.tier].name })
  items.push({ label: 'First seen', value: formatDate(f.firstSeenAt) })
  items.push({ label: 'Last seen', value: formatRelative(f.lastSeenAt) })
  return (
    <Panel>
      <PanelHeader title="Details" />
      <PanelBody>
        <KeyValues items={items} />
      </PanelBody>
    </Panel>
  )
}

function Head({ f }: { f: FindingDetail }) {
  const a = f.advisory
  const ids = a ? [a.ghsaId, ...a.cveIds].filter((x): x is string => Boolean(x)) : []
  if (f.kind === 'blind_spot') {
    return (
      <div className="mb-6 flex flex-col gap-2.5 border-b border-border pb-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <BlindSpotBadge />
          <Badge variant="outline">Ranked like a critical</Badge>
          <span className="font-mono">{blindSpotSubject(f)}</span>
          <span>Since {formatDate(f.firstSeenAt)}</span>
          <FindingStateText item={f} />
        </div>
        <h1 className="max-w-[60ch] text-lg">{findingTitle(f)}</h1>
        <p className="max-w-[68ch] text-foreground-2">
          {f.blindSpotType ? BLIND_SPOT_INFO[f.blindSpotType].explain : null}
        </p>
      </div>
    )
  }
  return (
    <div className="mb-6 flex flex-col gap-2.5 border-b border-border pb-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <SeverityBadge severity={f.factors.severity} />
        {a?.cvssScore != null ? (
          <Badge variant="outline" className="font-mono">
            CVSS {a.cvssScore.toFixed(1)}
          </Badge>
        ) : null}
        {ids.length ? (
          ids.map((id) => (
            <span key={id} className="font-mono">
              {id}
            </span>
          ))
        ) : (
          <span className="font-mono">{a?.advisoryKey}</span>
        )}
        {a ? <span>{a.ecosystem}</span> : null}
        <SourceBadge sources={f.sources} />
        <FindingStateText item={f} />
      </div>
      <h1 className="max-w-[60ch] text-lg">{findingTitle(f)}</h1>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
        <span>
          <span className="font-mono text-foreground">
            {a?.packageName}@{f.versions.installed ?? '?'}
          </span>{' '}
          {f.versions.firstPatched ? (
            <>
              → patched in <span className="font-mono text-success">{f.versions.firstPatched}</span>
            </>
          ) : (
            ', no patched release yet'
          )}
        </span>
        {a?.publishedAt ? <span>Published {formatRelative(a.publishedAt)}</span> : null}
        <span>First seen here {formatRelative(f.firstSeenAt)}</span>
      </div>
    </div>
  )
}

export function FindingDetailPage() {
  const { id: raw } = route.useParams()
  const id = Number(raw)
  const valid = Number.isInteger(id) && id > 0
  const queryClient = useQueryClient()
  const query = useQuery({ ...findingQuery(valid ? id : 0), enabled: valid })
  const [deferOpen, setDeferOpen] = useState(false)
  const [kind, setKind] = useState<DeferKind>('snooze')
  const formRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState('')

  const defer = useMutation({
    mutationFn: (v: { kind: DeferKind; reason: string; until: string }) =>
      deferFinding(id, v.kind, { reason: v.reason, until: v.until }),
    onSuccess: async (detail, v) => {
      setDeferOpen(false)
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
  const openDefer = () => {
    defer.reset()
    setDeferOpen(true)
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView?.({ block: 'nearest' })
      formRef.current?.querySelector<HTMLElement>('textarea')?.focus()
    })
  }

  // s opens the snooze form, like the design's keyboard map.
  const openRef = useRef(openDefer)
  useEffect(() => {
    openRef.current = openDefer
  })
  useEffect(() => {
    if (!canDefer) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 's' || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      openRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canDefer])

  const notFound = !valid || (query.error instanceof ApiError && query.error.status === 404)
  if (notFound) {
    return (
      <>
        <PageHeader
          title={
            <>
              Finding <span className="font-mono text-[0.92em]">{raw}</span>
            </>
          }
        />
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
          Findings appear after a scan. If a notification brought you here, run a scan and open the
          link again; resolved findings keep their history.
        </EmptyState>
      </>
    )
  }
  if (query.error) {
    return (
      <>
        <PageHeader title={`Finding ${raw}`} />
        <ErrorState
          title="This finding did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </>
    )
  }
  if (!query.data) return <LoadingState layout="detail" label="Loading finding" />

  const f = query.data
  return (
    <>
      <Head f={f} />
      <StateBanner
        f={f}
        onReopen={() => reopen.mutate()}
        reopening={reopen.isPending}
        reopenError={reopen.error ? describeError(reopen.error) : null}
      />
      <div className="grid items-start gap-7 desk:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Actions f={f} onDefer={openDefer} open={deferOpen} className="desk:hidden" />
          <WhyItRanks f={f} />
          {deferOpen ? (
            <div ref={formRef} id="defer-panel">
              <Panel>
                <PanelHeader title="Snooze or accept risk" icon={IconClockPause} />
                <PanelBody>
                  <DeferForm
                    kind={kind}
                    onKindChange={setKind}
                    pending={defer.isPending}
                    error={defer.error ? describeError(defer.error) : null}
                    onSubmit={(k, body) => defer.mutate({ kind: k, ...body })}
                    onCancel={() => setDeferOpen(false)}
                  />
                </PanelBody>
              </Panel>
            </div>
          ) : null}
          {f.kind === 'blind_spot' ? <HowToClose f={f} /> : null}
          <Affected f={f} />
          <Advisory f={f} />
          <History f={f} />
        </div>
        <div className="flex flex-col gap-4">
          <Actions f={f} onDefer={openDefer} open={deferOpen} className="max-desk:hidden" />
          <Details f={f} />
        </div>
      </div>
      <p role="status" className="sr-only">
        {notice}
      </p>
    </>
  )
}
