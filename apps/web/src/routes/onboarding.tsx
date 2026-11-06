import { useCallback, useRef, useState } from 'react'
import type { ScanRun, SourceDto } from '@hinomi/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IconArrowRight, IconCircleCheck, IconDatabase } from '@tabler/icons-react'
import { AccessCallout } from '@/components/access-callout'
import { OptionRow } from '@/components/form/field'
import { ChannelForm } from '@/components/notifications/channel-form'
import { FirstScan } from '@/components/onboarding/first-scan'
import { GithubTokenHelp } from '@/components/onboarding/github-token-help'
import { OnboardingStep, type StepState } from '@/components/onboarding/onboarding-step'
import { TowerArt } from '@/components/onboarding/tower-art'
import { SecretKeyCallout } from '@/components/sources/secret-key-callout'
import { SourceConnectForm, type ConnectableKind } from '@/components/sources/source-connect-form'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useOnboarding } from '@/hooks/use-onboarding'
import { useOsvSetting } from '@/hooks/use-osv-setting'
import { hostOf } from '@/lib/form'
import { channelsQuery, settingsKeys, sourcesQuery } from '@/lib/settings-api'

const STEP_COUNT = 4

export function OnboardingPage() {
  return (
    <div className="mx-auto mt-2 flex max-w-[760px] flex-col gap-6">
      <div className="grid items-center gap-6 tab:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <h1 className="text-xl leading-tight">
            Find what is exposed, not just what is vulnerable
          </h1>
          <p className="mt-2 max-w-[56ch] text-pretty text-foreground-2">
            Connect Coolify and GitHub. Hinomi joins your running apps with their Dependabot alerts
            and ranks them, so the few that are public and critical come first.
          </p>
        </div>
        <TowerArt />
      </div>
      <AccessCallout title="Put this behind Tailscale or Cloudflare Access first" />
      <Steps />
    </div>
  )
}

function firstConnected(sources: SourceDto[], kind: ConnectableKind): SourceDto | undefined {
  return sources.find((s) => s.kind === kind && s.hasToken)
}

function Steps() {
  const queryClient = useQueryClient()
  const sources = useQuery(sourcesQuery)
  const channels = useQuery(channelsQuery)
  const [open, setOpen] = useState<number | null>(null)
  const [connected, setConnected] = useState<Partial<Record<ConnectableKind, string>>>({})
  const onboarding = useOnboarding()
  const skippedAlerts = onboarding.state.alertsSkipped
  const [scanDone, setScanDone] = useState(false)
  const finishOnboarding = onboarding.update
  // The finished run is reported again on every refetch; tell the server once.
  const finishSent = useRef(onboarding.state.finished)
  const markScanDone = useCallback(
    (run: ScanRun) => {
      const ok = run.status !== 'failed'
      setScanDone(ok)
      if (ok && !finishSent.current) {
        finishSent.current = true
        finishOnboarding({ finished: true })
      }
    },
    [finishOnboarding],
  )
  const headers = useRef<(HTMLButtonElement | null)[]>([])

  if (sources.isPending || onboarding.isPending) return <StepsSkeleton />
  if (sources.isError) {
    return (
      <ErrorState
        title="Could not read the setup state"
        error={sources.error}
        onRetry={() => void sources.refetch()}
      />
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

  const goTo = (index: number) => {
    setOpen(index)
    // Move focus with the reader: the next step's header announces where they are.
    requestAnimationFrame(() => headers.current[index - 1]?.focus())
  }
  const toggle = (index: number) => setOpen(openStep === index ? 0 : index)
  const recheck = () => void queryClient.invalidateQueries({ queryKey: settingsKeys.sources })

  const continueButton = (to: number) => (
    <div>
      <Button onClick={() => goTo(to)}>
        Continue
        <IconArrowRight aria-hidden="true" />
      </Button>
    </div>
  )

  return (
    <ol
      aria-label="Setup steps"
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <OnboardingStep
        ref={(el) => {
          headers.current[0] = el
        }}
        index={1}
        title="Connect Coolify"
        sub={
          coolify
            ? `${hostOf(coolify.baseUrl ?? coolify.name)} connected`
            : 'Your deployments, domains and servers'
        }
        state={stateOf(1)}
        open={openStep === 1}
        onToggle={() => toggle(1)}
      >
        {coolify ? (
          <>
            <Connected
              message={
                connected.coolify ??
                `Hinomi reads deployments from ${coolify.baseUrl ?? coolify.name}.`
              }
            />
            {continueButton(2)}
          </>
        ) : !canStoreTokens ? (
          <SecretKeyCallout onRecheck={recheck} rechecking={sources.isFetching} />
        ) : (
          <SourceConnectForm
            kind="coolify"
            onConnected={({ test }) => {
              setConnected((c) => ({ ...c, coolify: test.message }))
              setOpen(1)
            }}
          />
        )}
      </OnboardingStep>

      <OnboardingStep
        ref={(el) => {
          headers.current[1] = el
        }}
        index={2}
        title="Connect GitHub"
        sub={github ? `${github.name} connected` : 'Repos and their Dependabot alerts'}
        state={stateOf(2)}
        open={openStep === 2}
        onToggle={() => toggle(2)}
      >
        {github ? (
          <>
            <Connected
              message={connected.github ?? 'Hinomi reads repos and their Dependabot alerts.'}
            />
            <OsvOption />
            {continueButton(3)}
          </>
        ) : !canStoreTokens ? (
          <SecretKeyCallout onRecheck={recheck} rechecking={sources.isFetching} />
        ) : (
          <>
            <GithubTokenHelp />
            <SourceConnectForm
              kind="github"
              onConnected={({ test }) => {
                setConnected((c) => ({ ...c, github: test.message }))
                setOpen(2)
              }}
            />
          </>
        )}
      </OnboardingStep>

      <OnboardingStep
        ref={(el) => {
          headers.current[2] = el
        }}
        index={3}
        title="Where should alerts go?"
        sub={
          alertsDone
            ? channelList.map((c) => c.name).join(', ')
            : 'Discord, a webhook or email. You can skip this.'
        }
        state={stateOf(3)}
        optional
        open={openStep === 3}
        onToggle={() => toggle(3)}
      >
        {alertsDone ? (
          <>
            <Connected message="New exposed findings post there. Add more channels in Settings." />
            {continueButton(4)}
          </>
        ) : (
          <>
            <p className="text-sm text-foreground-2">
              Only new exposed findings alert right away. Everything else waits for the daily
              digest.
            </p>
            <ChannelForm submitLabel="Save and continue" onDone={() => goTo(4)} />
            <div className="-mt-1">
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
        )}
      </OnboardingStep>

      <OnboardingStep
        ref={(el) => {
          headers.current[3] = el
        }}
        index={4}
        title="Run the first scan"
        sub="Reads and ranks. Nothing on your servers or repos changes."
        state={stateOf(4)}
        open={openStep === 4}
        onToggle={() => toggle(4)}
      >
        <FirstScan onFinished={markScanDone} />
      </OnboardingStep>
    </ol>
  )
}

function Connected({ message }: { message: string }) {
  return (
    <Callout variant="info" icon={IconCircleCheck} title="Connected">
      {message}
    </Callout>
  )
}

/** The OSV.dev lockfile scan switch, offered once GitHub can read lockfiles. */
function OsvOption() {
  const { settings, mutation, enabled: checked, setEnabled } = useOsvSetting()
  if (!settings.data) return null
  return (
    <div className="rounded-lg border border-border px-3.5 py-3">
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
    </div>
  )
}

function StepsSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-3.5 border-t border-border px-[18px] py-3.5 first:border-t-0"
        >
          <Skeleton className="size-7 rounded-full" />
          <span className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2.5 w-56" />
          </span>
        </div>
      ))}
      <p role="status" className="sr-only">
        Loading the setup steps
      </p>
    </div>
  )
}
