import { FIX_RUN_NOTIFY_EVENTS, type FixRunNotifyEvent } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconCircleX,
  IconGitPullRequest,
  IconRobotOff,
  IconShieldCheck,
  IconShieldX,
  type Icon,
} from '@tabler/icons-react'
import { Switch } from '@/components/ui/switch'
import { describeError } from '@/lib/errors'
import { notifySettingsQuery, settingsKeys, updateNotifySettings } from '@/lib/settings-api'
import { SetBox, SetRow, SubHeading } from './settings-section'

const EVENTS: Record<FixRunNotifyEvent, { title: string; sub: string; icon: Icon }> = {
  prOpened: {
    title: 'Fix PR opened',
    sub: 'The fix pull request is open, with its draft state',
    icon: IconGitPullRequest,
  },
  checksFailing: {
    title: 'Checks failing',
    sub: 'The checks on the fix pull request failed',
    icon: IconCircleX,
  },
  verified: {
    title: 'Verified',
    sub: 'The rescan found every targeted finding gone',
    icon: IconShieldCheck,
  },
  notCleared: {
    title: 'Not cleared',
    sub: 'The rescan left some of the findings open',
    icon: IconShieldX,
  },
  failed: {
    title: 'Run failed',
    sub: 'The run failed, was lost or was cancelled',
    icon: IconRobotOff,
  },
  warnings: {
    title: 'Deploy warnings',
    sub: "A merged run's watch paths skip the fix, or no deploy of it showed up",
    icon: IconAlertTriangle,
  },
}

/** One switch per fix run event the enabled channels announce. Each one saves on its own. */
export function FixRunEventSettings() {
  const queryClient = useQueryClient()
  const settings = useQuery(notifySettingsQuery)
  const toggle = useMutation({
    mutationFn: ({ event, on }: { event: FixRunNotifyEvent; on: boolean }) =>
      updateNotifySettings({ fixRunEvents: { [event]: on } }),
    onSuccess: (data) => queryClient.setQueryData(settingsKeys.notifySettings, data),
  })
  // The delivery settings above show the loading and error states of the same query.
  if (!settings.data) return null
  const saved = settings.data.fixRunEvents
  return (
    <>
      <SubHeading title="Fix run events" note="Sent to every enabled channel" />
      <SetBox as="ul" aria-label="Fix run events">
        {FIX_RUN_NOTIFY_EVENTS.map((event) => {
          const info = EVENTS[event]
          const pending = toggle.isPending && toggle.variables.event === event
          const on = pending ? toggle.variables.on : saved[event]
          return (
            <SetRow
              key={event}
              as="li"
              icon={<info.icon stroke={1.75} />}
              title={info.title}
              sub={info.sub}
              aside={
                <Switch
                  aria-label={`Notify when: ${info.title}`}
                  checked={on}
                  disabled={toggle.isPending}
                  onCheckedChange={(next) => toggle.mutate({ event, on: next })}
                />
              }
            />
          )
        })}
      </SetBox>
      {toggle.error ? (
        <p role="alert" className="text-sm text-sev-critical">
          {describeError(toggle.error)}
        </p>
      ) : null}
    </>
  )
}
