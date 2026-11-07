import type * as React from 'react'
import { useCallback, useRef, useState } from 'react'
import type { ScanRun, SourceDto } from '@hinomi/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconArrowLeft, IconCircleCheck, IconDatabase, IconLock } from '@tabler/icons-react'
import { AccessCallout } from '@/components/access-callout'
import { OptionRow } from '@/components/form/field'
import { ChannelForm } from '@/components/notifications/channel-form'
import { FirstScan, type FirstScanState } from '@/components/onboarding/first-scan'
import { GithubTokenHelp } from '@/components/onboarding/github-token-help'
import {
  SetupStepList,
  type SetupStep,
  type StepState,
} from '@/components/onboarding/onboarding-step'
import { BrandMark } from '@/components/shell/brand-mark'
import { SecretKeyCallout } from '@/components/sources/secret-key-callout'
import { SourceConnectForm, type ConnectableKind } from '@/components/sources/source-connect-form'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useOnboarding } from '@/hooks/use-onboarding'
import { useOsvSetting } from '@/hooks/use-osv-setting'
import { hostOf } from '@/lib/form'
import { channelsQuery, settingsKeys, sourcesQuery } from '@/lib/settings-api'

const STEP_COUNT = 4

/** The steps pane copy before a step is done, from the design. */
const STEP_COPY = [
  { title: 'Connect Coolify', sub: 'Read only API token' },
  { title: 'Connect GitHub', sub: 'A token or the GitHub App' },
  { title: 'Notifications', sub: 'Discord, email or webhook' },
  { title: 'First scan', sub: 'Join apps with advisories' },
] as const

const SCAN_HEAD: Record<FirstScanState, { title: string; prose: string }> = {
  idle: {
    title: 'Run the first scan',
    prose:
      'Hinomi reads your deployments and repos, fetches their alerts and ranks them by exposure. Nothing on your servers or repos changes.',
  },
  running: {
    title: 'First scan is running',
    prose:
      'Hinomi is joining your running apps with their advisories. This takes a few minutes; you can leave this page.',
  },
  succeeded: {
    title: 'Hinomi is set up',
    prose: 'The exposure view ranks what the scan found. The next scan runs on its own.',
  },
  failed: {
    title: 'The first scan stopped',
    prose: 'Check the sources below, fix the connection and run it again.',
  },
}

function firstConnected(sources: SourceDto[], kind: ConnectableKind): SourceDto | undefined {
  return sources.find((s) => s.kind === kind && s.hasToken)
}

/**
 * First run, in the design's setup split: the four steps on the left, the open step on the
 * right. Progress lives on the server (sources, channels, the onboarding state), so a reload or
 * a second tab opens on the same step.
 */
export function OnboardingPage() {
  const queryClient = useQueryClient()
  const sources = useQuery(sourcesQuery)
  const channels = useQuery(channelsQuery)
  const [open, setOpen] = useState<number | null>(null)
  const [connected, setConnected] = useState<Partial<Record<ConnectableKind, string>>>({})
  const onboarding = useOnboarding()
  const skippedAlerts = onboarding.state.alertsSkipped
  const [scanDone, setScanDone] = useState(false)
  const [scanState, setScanState] = useState<FirstScanState>('idle')
  const finishOnboarding = onboarding.update
  // The finished run is reported again on every refetch; tell the server once.
  const finishSent = useRef(onboarding.state.finished)
  const markScanDone = useCallback(
    (run: ScanRun) => {
      const ok = run.status !== 'failed'
      setScanDone(ok)
      if (!ok || finishSent.current) return
      finishSent.current = true
      finishOnboarding({ finished: true })
    },
    [finishOnboarding],
  )
  const heading = useRef<HTMLHeadingElement>(null)

  if (sources.isPending || onboarding.isPending) {
    return (
      <SetupFrame steps={null} open={1} onOpen={() => {}} finished={false}>
        <StepSkeleton />
      </SetupFrame>
    )
  }
  if (sources.isError) {
    return (
      <SetupFrame steps={null} open={1} onOpen={() => {}} finished={onboarding.state.finished}>
        <StepHead index={null} title="Set up Hinomi" />
        <ErrorState
          title="Could not read the setup state"
          error={sources.error}
          onRetry={() => void sources.refetch()}
        />
      </SetupFrame>
    )
  }

  const { canStoreTokens } = sources.data
  const coolify = firstConnected(sources.data.sources, 'coolify')
  const github = firstConnected(sources.data.sources, 'github')
  const channelList = channels.data?.items ?? []
  const alertsDone = channelList.length > 0
  const maxStep = coolify ? (github ? STEP_COUNT : 2) : 1
  const nextOpen = !coolify ? 1 : !github ? 2 : alertsDone || skippedAlerts ? 4 : 3
  const openStep = open ?? nextOpen

  const done = [Boolean(coolify), Boolean(github), alertsDone, scanDone]
  const stateOf = (index: number): StepState =>
    done[index - 1] ? 'done' : index > maxStep ? 'locked' : index === nextOpen ? 'active' : 'todo'
  const subs = [
    coolify ? `${hostOf(coolify.baseUrl ?? coolify.name)} connected` : STEP_COPY[0].sub,
    github ? `${github.name} connected` : STEP_COPY[1].sub,
    alertsDone
      ? channelList.map((c) => c.name).join(', ')
      : skippedAlerts
        ? 'Skipped for now'
        : STEP_COPY[2].sub,
    scanDone ? 'Done' : STEP_COPY[3].sub,
  ]
  const steps: SetupStep[] = STEP_COPY.map((copy, i) => ({
    index: i + 1,
    title: copy.title,
    sub: subs[i] ?? copy.sub,
    state: stateOf(i + 1),
  }))

  const goTo = (index: number) => {
    setOpen(index)
    // Move focus with the reader: the step's heading announces where they are.
    requestAnimationFrame(() => heading.current?.focus())
  }
  const recheck = () => void queryClient.invalidateQueries({ queryKey: settingsKeys.sources })
  const secretKey = <SecretKeyCallout onRecheck={recheck} rechecking={sources.isFetching} />

  let head: React.ReactNode
  let body: React.ReactNode
  if (openStep === 1) {
    head = (
      <StepHead index={1} title="Connect Coolify" ref={heading}>
        Find what is exposed, not just what is vulnerable. Hinomi reads your deployments, domains
        and servers from Coolify with a read only API token.
      </StepHead>
    )
    body = (
      <>
        <AccessCallout title="Put this behind Tailscale or Cloudflare Access first" />
        {coolify ? (
          <Connected
            message={
              connected.coolify ??
              `Hinomi reads deployments from ${coolify.baseUrl ?? coolify.name}.`
            }
          />
        ) : !canStoreTokens ? (
          secretKey
        ) : (
          <StepBox>
            <SourceConnectForm
              kind="coolify"
              onConnected={({ test }) => {
                setConnected((c) => ({ ...c, coolify: test.message }))
                setOpen(1)
              }}
            />
          </StepBox>
        )}
      </>
    )
  } else if (openStep === 2) {
    head = (
      <StepHead index={2} title="Connect GitHub" ref={heading}>
        Hinomi reads your repos, their Dependabot alerts and lockfiles, with a personal access token
        or as a GitHub App. It only reads; fixes arrive as pull requests you merge.
      </StepHead>
    )
    body = github ? (
      <>
        <Connected
          message={connected.github ?? 'Hinomi reads repos and their Dependabot alerts.'}
        />
        <OsvOption />
      </>
    ) : !canStoreTokens ? (
      secretKey
    ) : (
      <>
        <GithubTokenHelp />
        <StepBox>
          <SourceConnectForm
            kind="github"
            onConnected={({ test }) => {
              setConnected((c) => ({ ...c, github: test.message }))
              setOpen(2)
            }}
          />
        </StepBox>
      </>
    )
  } else if (openStep === 3) {
    head = (
      <StepHead index={3} title="Where should alerts go?" optional ref={heading}>
        Only new exposed findings alert right away. Everything else waits for the daily digest.
      </StepHead>
    )
    body = alertsDone ? (
      <Connected message="New exposed findings post there. Add more channels in Settings." />
    ) : (
      <>
        <StepBox>
          <ChannelForm submitLabel="Save and continue" onDone={() => goTo(4)} />
        </StepBox>
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              onboarding.update({ alertsSkipped: true })
              goTo(4)
            }}
          >
            Skip for now
          </Button>
        </div>
      </>
    )
  } else {
    const copy = SCAN_HEAD[scanState]
    head = (
      <StepHead index={4} title={copy.title} ref={heading}>
        {copy.prose}
      </StepHead>
    )
    body = <FirstScan onFinished={markScanDone} onStateChange={setScanState} />
  }

  const stepDone = done[openStep - 1] ?? false
  const footer = (
    <div className="flex flex-wrap items-center gap-3">
      {openStep > 1 ? (
        <Button variant="outline" onClick={() => goTo(openStep - 1)}>
          Back
        </Button>
      ) : null}
      <span className="ml-auto text-sm text-muted-foreground">
        {openStep === STEP_COUNT
          ? 'Reads and ranks. Nothing on your servers or repos changes.'
          : 'You can change this later in Settings'}
      </span>
      {stepDone && openStep < STEP_COUNT ? (
        <Button onClick={() => goTo(openStep + 1)}>Continue</Button>
      ) : null}
    </div>
  )

  return (
    <SetupFrame steps={steps} open={openStep} onOpen={goTo} finished={onboarding.state.finished}>
      {head}
      {body}
      {footer}
    </SetupFrame>
  )
}

/** The setup split: steps pane (360 px from 761 px, a header row on the phone) and the step. */
function SetupFrame({
  steps,
  open,
  onOpen,
  finished,
  children,
}: {
  steps: readonly SetupStep[] | null
  open: number
  onOpen: (index: number) => void
  finished: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-1 flex-col tab:flex-row">
      <aside
        aria-label="Setup"
        className="flex shrink-0 flex-col gap-4 border-b border-border bg-sidebar px-4 pt-3 pb-4 tab:sticky tab:top-0 tab:h-svh tab:w-[300px] tab:gap-0 tab:border-r tab:border-b-0 tab:p-0 desk:w-[360px]"
      >
        <div className="flex items-center gap-2.5 tab:px-[18px] tab:pt-[18px] tab:pb-3">
          <BrandMark size={28} />
          <span className="text-md font-semibold">Hinomi setup</span>
          {finished ? (
            <Link
              to="/"
              className="ml-auto inline-flex items-center gap-1 rounded-sm text-sm text-accent-ink hover:underline"
            >
              <IconArrowLeft aria-hidden="true" className="size-4" stroke={1.75} />
              Back to Hinomi
            </Link>
          ) : null}
        </div>
        <div className="tab:px-[22px] tab:py-2.5">
          {steps ? (
            <SetupStepList steps={steps} open={open} onOpen={onOpen} />
          ) : (
            <StepListSkeleton />
          )}
        </div>
        <p className="mt-auto hidden items-center gap-2 border-t border-border px-[18px] py-3 text-xs text-foreground-2 tab:flex">
          <IconLock aria-hidden="true" className="size-[15px] shrink-0" stroke={1.75} />
          Hinomi only reads until you run a fix
        </p>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex max-w-[720px] flex-col gap-6 px-4 pt-6 pb-16 tab:px-8 tab:pt-14">
          {children}
        </div>
      </div>
    </div>
  )
}

const StepHead = ({
  index,
  title,
  optional,
  children,
  ref,
}: {
  index: number | null
  title: string
  optional?: boolean
  children?: React.ReactNode
  ref?: React.Ref<HTMLHeadingElement>
}) => (
  <div className="flex flex-col gap-2">
    {index === null ? null : (
      <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        Step {index} of {STEP_COUNT}
        {optional ? <Badge variant="outline">Optional</Badge> : null}
      </span>
    )}
    <h1 ref={ref} tabIndex={-1} className="text-xl outline-none">
      {title}
    </h1>
    {children ? (
      <p className="max-w-[70ch] text-base text-pretty text-foreground-2">{children}</p>
    ) : null}
  </div>
)

/** The design's .box around a step's form. */
function StepBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-[18px]">
      {children}
    </div>
  )
}

function Connected({ message }: { message: string }) {
  return (
    <Callout variant="ok" icon={IconCircleCheck} title="Connected">
      {message}
    </Callout>
  )
}

/** The OSV.dev lockfile scan switch, offered once GitHub can read lockfiles. */
function OsvOption() {
  const { settings, mutation, enabled: checked, setEnabled } = useOsvSetting()
  if (!settings.data) return null
  return (
    <StepBox>
      <OptionRow
        icon={<IconDatabase aria-hidden="true" stroke={1.75} />}
        title={<span id="osv-label">Also scan lockfiles with OSV.dev</span>}
        note={
          mutation.isError
            ? 'Could not save this. Try again.'
            : 'Covers repos with Dependabot alerts off. Only package names and versions are sent.'
        }
        control={
          <Switch
            aria-labelledby="osv-label"
            checked={checked}
            disabled={mutation.isPending}
            onCheckedChange={setEnabled}
          />
        }
      />
    </StepBox>
  )
}

function StepListSkeleton() {
  return (
    <div aria-hidden="true" className="flex gap-2 tab:flex-col tab:gap-5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="grid grid-cols-[30px_minmax(0,1fr)] items-center gap-3">
          <Skeleton className="size-[30px] rounded-full" />
          <span className="hidden flex-col gap-1.5 tab:flex">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-2.5 w-40" />
          </span>
        </div>
      ))}
    </div>
  )
}

function StepSkeleton() {
  return (
    <>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-3.5 w-full max-w-[480px]" />
      </div>
      <Skeleton aria-hidden="true" className="h-40 w-full rounded-lg" />
      <p role="status" className="sr-only">
        Loading the setup steps
      </p>
    </>
  )
}
