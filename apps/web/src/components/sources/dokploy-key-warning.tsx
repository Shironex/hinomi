import { IconAlertOctagon } from '@tabler/icons-react'
import { Callout } from '@/components/ui/callout'

/**
 * Dokploy has no read only API key: the key Hinomi reads with can also deploy, delete and read
 * every secret (docs/design/phase-2.md section 9.4). Shown wherever a Dokploy key is entered.
 */
export function DokployKeyWarning() {
  return (
    <Callout
      variant="danger"
      icon={IconAlertOctagon}
      title="A Dokploy API key has full access"
      role="note"
    >
      Dokploy has no read only key. The key you paste can deploy, stop and delete services and read
      their environment variables and database passwords. Hinomi only reads with it, drops every
      secret looking field from Dokploy&apos;s answers before keeping anything, and stores the key
      encrypted. Create a dedicated Dokploy user for Hinomi, limited to the projects it should see,
      and generate the key as that user.
    </Callout>
  )
}
