import type * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { IconCheck } from '@tabler/icons-react'
import { AccessCallout } from '@/components/access-callout'
import { PageHeader } from '@/components/page-header'
import { MappingSection } from '@/components/settings/mapping-section'
import { NotificationsSection } from '@/components/settings/notifications-section'
import { ScansSection } from '@/components/settings/scans-section'
import { Panel, SettingsSection } from '@/components/settings/settings-section'
import { SourcesSection } from '@/components/settings/sources-section'
import { ThemeSwitch } from '@/components/shell/theme-switch'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { healthQuery } from '@/lib/queries'

const SECTIONS = [
  { id: 'settings-access', label: 'Access' },
  { id: 'settings-appearance', label: 'Appearance' },
  { id: 'settings-sources', label: 'Sources' },
  { id: 'settings-notifications', label: 'Notifications' },
  { id: 'settings-scans', label: 'Scans' },
  { id: 'settings-mapping', label: 'Repo mapping' },
] as const

export function SettingsPage() {
  const health = useQuery(healthQuery)

  return (
    <>
      <PageHeader title="Settings">
        Sources, alerts and scans for this instance. Stored in the container volume at{' '}
        <span className="font-mono text-[0.92em]">/data</span>.
      </PageHeader>
      {health.isError ? (
        // One clear error instead of a failed panel per section when the server is down.
        <ErrorState
          title="Server not reachable"
          error={health.error}
          onRetry={() => void health.refetch()}
        />
      ) : (
        <div className="grid items-start gap-8 desk:grid-cols-[160px_minmax(0,1fr)]">
          <SectionNav />
          <div className="min-w-0">
            <SettingsSection
              id="settings-access"
              title="Access"
              intro="Who can open this page, and the server it talks to."
            >
              <AccessCallout />
              <ServerHealth pending={health.isPending} />
            </SettingsSection>
            <SettingsSection
              id="settings-appearance"
              title="Appearance"
              intro="Saved in this browser only."
            >
              <Panel className="flex-row flex-wrap items-center justify-between">
                <span className="flex flex-col">
                  <b className="font-medium">Theme</b>
                  <small className="text-xs text-muted-foreground">
                    System follows your device.
                  </small>
                </span>
                <ThemeSwitch className="w-full max-w-[260px]" />
              </Panel>
            </SettingsSection>
            {health.isPending ? null : (
              <>
                <SettingsSection
                  id="settings-sources"
                  title="Sources"
                  intro="Where deployments and advisories come from. Tokens are stored encrypted and never shown again."
                >
                  <SourcesSection />
                </SettingsSection>
                <SettingsSection
                  id="settings-notifications"
                  title="Notifications"
                  intro="Only new exposed findings alert right away. Everything else goes in the daily digest."
                >
                  <NotificationsSection />
                </SettingsSection>
                <SettingsSection
                  id="settings-scans"
                  title="Scans"
                  intro="A scan reads Coolify and GitHub, then reranks. It never changes your servers or repos."
                >
                  <ScansSection />
                </SettingsSection>
                <SettingsSection
                  id="settings-mapping"
                  title="Repo mapping"
                  intro="Hinomi matches each app to its git source in Coolify. Override it when an app builds from another repo."
                >
                  <MappingSection />
                </SettingsSection>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function SectionNav() {
  const jump = (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    event.preventDefault()
    const target = document.getElementById(id)
    if (!target) return
    target.scrollIntoView({ block: 'start' })
    document.getElementById(`${id}-title`)?.focus({ preventScroll: true })
  }
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-[76px] hidden flex-col gap-px desk:flex"
    >
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          onClick={(e) => jump(e, s.id)}
          className="rounded-md px-2.5 py-1.5 text-sm text-foreground-2 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {s.label}
        </a>
      ))}
    </nav>
  )
}

function ServerHealth({ pending }: { pending: boolean }) {
  if (pending) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
        <Skeleton className="size-[30px] rounded-md" />
        <span className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-2.5 w-44" />
        </span>
        <p role="status" className="sr-only">
          Checking the server
        </p>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-sm">
      <span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-muted text-foreground-2">
        <IconCheck aria-hidden="true" className="size-4" stroke={1.75} />
      </span>
      <span className="flex min-w-0 flex-col">
        <b className="font-medium">API</b>
        <small className="text-xs text-muted-foreground">
          <span className="font-mono">/api/health</span> answered
        </small>
      </span>
      <Badge variant="success" className="ml-auto">
        <IconCheck aria-hidden="true" />
        Healthy
      </Badge>
    </div>
  )
}
