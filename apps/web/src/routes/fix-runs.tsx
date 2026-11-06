import { Link } from '@tanstack/react-router'
import { IconRadar2, IconRobot } from '@tabler/icons-react'
import { SplitListHeader } from '@/components/split/split-parts'
import { SplitView } from '@/components/split/split-view'
import { DetailEmpty } from '@/components/states/detail-empty'
import { Button } from '@/components/ui/button'
import { SPLIT_QUERY, useMediaQuery } from '@/hooks/use-media-query'

/** No fix runs exist before phase 1; the split shows what will land here and where to start. */
export function FixRunsPage() {
  const wide = useMediaQuery(SPLIT_QUERY)
  const empty = (
    <DetailEmpty
      icon={IconRobot}
      title="No fix runs yet"
      actions={
        <Button asChild>
          <Link to="/">
            <IconRadar2 aria-hidden="true" />
            Pick a finding to fix
          </Link>
        </Button>
      }
    >
      <p>
        When you run the fix agent on a finding, it opens a pull request, waits for checks and shows
        each run here until a rescan verifies the fix.
      </p>
      <p className="text-sm text-muted-foreground">
        Agents run one at a time, only get the GitHub permissions you grant, and never merge a fix
        on their own.
      </p>
    </DetailEmpty>
  )
  return (
    <SplitView<never>
      items={[]}
      getKey={() => ''}
      getLabel={() => ''}
      listLabel="Fix runs"
      listHeader={<SplitListHeader title="Fix runs" />}
      renderRow={() => null}
      renderDetail={() => null}
      emptyList={
        wide ? (
          <p className="px-[18px] py-[18px] text-xs text-foreground-2">Nothing here yet</p>
        ) : (
          <div className="px-4 pt-8 pb-10 tab:px-7">{empty}</div>
        )
      }
      emptyDetail={<div className="pt-14">{empty}</div>}
    />
  )
}
