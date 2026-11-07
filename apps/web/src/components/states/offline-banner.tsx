import { IconWifiOff } from '@tabler/icons-react'
import { useOnline } from '@/hooks/use-online'
import { Callout } from '@/components/ui/callout'

/**
 * Shown while the browser is offline. Lists keep their last data; whatever cannot load says so
 * through ErrorState, and queries refetch by themselves when the connection returns.
 */
export function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <Callout
      role="status"
      variant="warn"
      icon={IconWifiOff}
      title="You are offline"
      className="mx-4 mt-3 tab:mx-8"
    >
      Hinomi needs its server for live data. This page will refresh when the connection is back.
    </Callout>
  )
}
