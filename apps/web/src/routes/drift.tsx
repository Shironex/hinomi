import {
  IconArchive,
  IconCalendarTime,
  IconDeviceDesktop,
  IconEyeOff,
  IconNetwork,
  IconStack2,
  IconUserShield,
  type Icon,
} from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Callout } from '@/components/ui/callout'

const GUARDS: { icon: Icon; title: string; detail: string }[] = [
  {
    icon: IconArchive,
    title: 'Repo archived but still deployed',
    detail: 'The repo no longer gets security updates, yet Coolify still runs it.',
  },
  {
    icon: IconUserShield,
    title: 'Container runs as root',
    detail: 'No USER in the Dockerfile and no user set in Coolify.',
  },
  {
    icon: IconNetwork,
    title: 'App on a shared network',
    detail: 'A public app shares a Docker network with internal databases.',
  },
  {
    icon: IconStack2,
    title: 'Framework behind its latest security patch',
    detail: 'The installed version is older than the newest patch release of its line.',
  },
  {
    icon: IconEyeOff,
    title: 'Watch paths skip Dockerfile changes',
    detail: 'A Dockerfile fix would never trigger a redeploy.',
  },
]

export function DriftPage() {
  return (
    <>
      <PageHeader
        title="Drift guards"
        actions={
          <Badge variant="outline">
            <IconCalendarTime aria-hidden="true" />
            Phase 2
          </Badge>
        }
      >
        Planned. Checks for configuration that quietly makes exposure worse.
      </PageHeader>
      <ul className="overflow-hidden rounded-lg border border-border bg-card">
        {GUARDS.map((g) => (
          <li
            key={g.title}
            className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3.5 border-t border-border p-4 first:border-t-0 tab:grid-cols-[36px_minmax(0,1fr)_auto]"
          >
            <span className="grid size-9 place-items-center rounded-md bg-muted text-foreground-2">
              <g.icon aria-hidden="true" className="size-4" stroke={1.75} />
            </span>
            <div className="min-w-0">
              <b className="font-medium">{g.title}</b>
              <p className="text-sm text-muted-foreground">{g.detail}</p>
            </div>
            <Badge variant="outline" className="col-start-2 justify-self-start tab:col-start-auto">
              Planned
            </Badge>
          </li>
        ))}
      </ul>
      <section className="mt-7 flex flex-col gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-md">Shipped apps</h2>
          <Badge variant="outline">Phase 2</Badge>
        </div>
        <Callout icon={IconDeviceDesktop} title="A second tier for apps in users' hands">
          Desktop releases are not deployed, but every installed copy keeps its dependencies until
          users update. Hinomi will rank them by release age, under the exposed tier.
        </Callout>
      </section>
    </>
  )
}
