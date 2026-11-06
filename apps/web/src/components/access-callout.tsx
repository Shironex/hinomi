import { IconLock } from '@tabler/icons-react'
import { Callout } from '@/components/ui/callout'

/** The honest note shown on onboarding and settings until Hinomi has a login. */
export function AccessCallout({ title = 'Hinomi has no login yet' }: { title?: string }) {
  return (
    <Callout variant="warn" icon={IconLock} title={title}>
      Anyone who can reach this address can read your findings and change these settings. Run Hinomi
      behind Tailscale or Cloudflare Access, and do not publish its port on a public interface.
    </Callout>
  )
}
