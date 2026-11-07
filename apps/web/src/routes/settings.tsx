import { useQuery } from '@tanstack/react-query'
import {
  IconBell,
  IconCheck,
  IconClock,
  IconLock,
  IconPalette,
  IconPlug,
  IconServer2,
  IconShieldCheck,
  IconSend,
  IconWebhook,
  type Icon,
} from '@tabler/icons-react'
import { AccessCallout } from '@/components/access-callout'
import { MappingSection } from '@/components/settings/mapping-section'
import { NotificationsSection } from '@/components/settings/notifications-section'
import { ScansSection } from '@/components/settings/scans-section'
import {
  useSectionSummaries,
  type SettingsSectionKey,
} from '@/components/settings/section-summaries'
import { SetBox, SettingsSection, SetRow } from '@/components/settings/settings-section'
import { WebhookRunnerSection } from '@/components/settings/webhook-runner-section'
import { WebhookSection } from '@/components/settings/webhook-section'
import { SourcesSection } from '@/components/settings/sources-section'
import { ThemeSwitch } from '@/components/shell/theme-switch'
import { SplitListHeader } from '@/components/split/split-parts'
import { SplitView } from '@/components/split/split-view'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { SPLIT_QUERY, useMediaQuery } from '@/hooks/use-media-query'
import { healthQuery } from '@/lib/queries'

interface SectionMeta {
  key: SettingsSectionKey
  label: string
  icon: Icon
}

/** The settings list, in the order of the design. `key` is what goes in `?sel=`. */
const SECTIONS: readonly SectionMeta[] = [
  { key: 'sources', label: 'Sources', icon: IconServer2 },
  { key: 'notifications', label: 'Notification channels', icon: IconBell },
  { key: 'scans', label: 'Scans', icon: IconClock },
  { key: 'mapping', label: 'Repo mapping', icon: IconPlug },
  { key: 'webhook', label: 'GitHub webhook', icon: IconWebhook },
  { key: 'runner', label: 'Webhook runner', icon: IconSend },
  { key: 'access', label: 'Access', icon: IconLock },
  { key: 'appearance', label: 'Appearance', icon: IconPalette },
]

/**
 * Settings in the split layout: the sections on the left with a one line summary each, the
 * selected section on the right. Below 1100 px it is the list, then a section as its own page.
 */
export function SettingsPage() {
  const health = useQuery(healthQuery)
  const summaries = useSectionSummaries()
  const wide = useMediaQuery(SPLIT_QUERY)

  // One clear error instead of a failed section each when the server is down. It sits in the
  // detail pane, and above the list on the phone, where the list is all there is.
  const down = health.isError ? (
    <ErrorState
      title="Server not reachable"
      error={health.error}
      onRetry={() => void health.refetch()}
    />
  ) : null

  return (
    <SplitView
      items={SECTIONS}
      getKey={(s) => s.key}
      getLabel={(s) => s.label}
      listLabel="Settings sections"
      listHeader={<SplitListHeader title="Settings">{wide ? null : down}</SplitListHeader>}
      renderRow={(s) => (
        <span className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1">
          <s.icon aria-hidden="true" className="size-[17px] text-foreground-2" stroke={1.75} />
          <span className="truncate font-semibold text-foreground">{s.label}</span>
          <span className="col-start-2 truncate text-xs text-muted-foreground">
            {summaries[s.key] ?? ' '}
          </span>
        </span>
      )}
      renderDetail={(s) =>
        down ?? <SectionDetail section={s.key} healthPending={health.isPending} />
      }
    />
  )
}

function SectionDetail({
  section,
  healthPending,
}: {
  section: SettingsSectionKey
  healthPending: boolean
}) {
  switch (section) {
    case 'sources':
      return (
        <SettingsSection
          id="settings-sources"
          title="Sources"
          note="Where Hinomi reads from"
          intro="Deployments come from Coolify, advisories from GitHub and OSV.dev. Tokens are stored encrypted and never shown again."
        >
          <SourcesSection />
        </SettingsSection>
      )
    case 'notifications':
      return (
        <SettingsSection
          id="settings-notifications"
          title="Notification channels"
          intro="Only new exposed findings alert right away. Everything else goes in the daily digest."
        >
          <NotificationsSection />
        </SettingsSection>
      )
    case 'scans':
      return (
        <SettingsSection
          id="settings-scans"
          title="Scans"
          intro="A scan reads Coolify and GitHub, then reranks. It never changes your servers or repos."
        >
          <ScansSection />
        </SettingsSection>
      )
    case 'mapping':
      return (
        <SettingsSection
          id="settings-mapping"
          title="Repo mapping"
          intro="Hinomi matches each app to its git source in Coolify. Override it when an app builds from another repo."
        >
          <MappingSection />
        </SettingsSection>
      )
    case 'webhook':
      return (
        <SettingsSection
          id="settings-webhook"
          title="GitHub webhook"
          note="Optional"
          intro="Lets GitHub tell Hinomi a fix run changed, so it polls that run at once. Polling stays the source of truth, so leaving this off loses nothing."
        >
          <WebhookSection />
        </SettingsSection>
      )
    case 'runner':
      return (
        <SettingsSection
          id="settings-runner"
          title="Webhook runner"
          note="Optional"
          intro="For fix plans that should run on your own CI or build box. Hinomi posts the plan, the external runner applies it, pushes the branch and reports back. Pick it per repo under Fix runs."
        >
          <WebhookRunnerSection />
        </SettingsSection>
      )
    case 'access':
      return (
        <SettingsSection
          id="settings-access"
          title="Access"
          note="Who can open this page, and the server it talks to"
        >
          <AccessCallout />
          <AccessFacts healthPending={healthPending} />
        </SettingsSection>
      )
    case 'appearance':
      return (
        <SettingsSection id="settings-appearance" title="Appearance" note="Saved in this browser">
          <SetBox>
            <SetRow
              icon={<IconPalette stroke={1.75} />}
              title="Theme"
              sub="System follows your device. t switches it from anywhere."
            >
              <ThemeSwitch className="w-full max-w-[300px]" />
            </SetRow>
          </SetBox>
        </SettingsSection>
      )
  }
}

/** The design's access rows: a pill, then what it means. */
function AccessFacts({ healthPending }: { healthPending: boolean }) {
  return (
    <SetBox className="gap-3 py-4">
      <div className="grid items-center gap-x-4 gap-y-1.5 tab:grid-cols-[120px_minmax(0,1fr)]">
        <Badge variant="success" className="justify-self-start">
          <IconShieldCheck aria-hidden="true" />
          Read only
        </Badge>
        <span className="text-sm text-foreground-2">
          Hinomi reads Coolify and GitHub. It never changes your servers or repos.
        </span>
      </div>
      <div className="grid items-center gap-x-4 gap-y-1.5 tab:grid-cols-[120px_minmax(0,1fr)]">
        {healthPending ? (
          <>
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-3.5 w-44" />
            <p role="status" className="sr-only">
              Checking the server
            </p>
          </>
        ) : (
          <>
            <Badge variant="success" className="justify-self-start">
              <IconCheck aria-hidden="true" />
              Healthy
            </Badge>
            <span className="text-sm text-foreground-2">
              The API answered at{' '}
              <span className="font-mono text-[max(13px,0.92em)]">/api/health</span>.
            </span>
          </>
        )}
      </div>
    </SetBox>
  )
}
