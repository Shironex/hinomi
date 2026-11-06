import {
  IconArchive,
  IconBrandGithub,
  IconDeviceDesktop,
  IconEyeOff,
  IconNetwork,
  IconRoute,
  IconStack2,
  IconUserShield,
  type Icon,
} from '@tabler/icons-react'
import { SetBox, SetRow, SubHeading } from '@/components/settings/settings-section'
import { SplitListHeader } from '@/components/split/split-parts'
import { SplitView } from '@/components/split/split-view'
import { DetailEmpty } from '@/components/states/detail-empty'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SPLIT_QUERY, useMediaQuery } from '@/hooks/use-media-query'

/** Phase 2 of the spec, where drift guards are planned. */
const ROADMAP_URL = 'https://github.com/Shironex/hinomi/blob/main/docs/spec.md#phase-2-guard-it'

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

/** Drift guards arrive in phase 2: the split shows what they will check and where to follow. */
export function DriftPage() {
  const wide = useMediaQuery(SPLIT_QUERY)
  const content = (
    <div className="flex flex-col gap-8">
      <DetailEmpty
        icon={IconRoute}
        title="Drift guards arrive in phase 2"
        actions={
          <Button asChild variant="outline">
            <a href={ROADMAP_URL} target="_blank" rel="noreferrer noopener">
              <IconBrandGithub aria-hidden="true" />
              Follow the roadmap
            </a>
          </Button>
        }
      >
        <p>
          They will warn when configuration quietly makes exposure worse: a repo archived but still
          deployed, a container running as root, or a public app next to internal databases.
        </p>
      </DetailEmpty>
      <section aria-labelledby="drift-planned" className="flex max-w-[720px] flex-col gap-3">
        <h2 id="drift-planned" className="text-md">
          What they will check
        </h2>
        <SetBox as="ul">
          {GUARDS.map((g) => (
            <SetRow
              key={g.title}
              as="li"
              icon={<g.icon stroke={1.75} />}
              title={g.title}
              sub={g.detail}
              aside={<Badge variant="outline">Planned</Badge>}
            />
          ))}
        </SetBox>
        <SubHeading title="Shipped apps" note="Phase 2" />
        <SetBox>
          <SetRow
            icon={<IconDeviceDesktop stroke={1.75} />}
            title="A second tier for apps in users' hands"
            sub="Desktop releases are not deployed, but every installed copy keeps its dependencies until users update. Hinomi will rank them by release age, under the exposed tier."
          />
        </SetBox>
      </section>
    </div>
  )
  return (
    <SplitView<never>
      items={[]}
      getKey={() => ''}
      getLabel={() => ''}
      listLabel="Drift guards"
      listHeader={<SplitListHeader title="Drift guards" />}
      renderRow={() => null}
      renderDetail={() => null}
      emptyList={
        wide ? (
          <p className="px-[18px] py-[18px] text-xs text-foreground-2">Phase 2</p>
        ) : (
          <div className="px-4 pt-8 pb-10 tab:px-7">{content}</div>
        )
      }
      emptyDetail={<div className="pt-14">{content}</div>}
    />
  )
}
