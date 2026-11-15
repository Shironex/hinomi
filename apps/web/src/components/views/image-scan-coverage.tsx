import type { DeploymentDetail } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { settingsQuery } from '@/lib/settings-api'

/**
 * The "Image scan" line of an image only deployment's coverage: what the image scan setting and
 * the stored scan result say, not a promise of a later phase.
 */
export function ImageScanCoverage({ d }: { d: DeploymentDetail }) {
  const settings = useQuery(settingsQuery)
  const mode = settings.data?.imageScan
  if (!mode) return <>{settings.isPending ? 'Checking' : 'Unknown'}</>
  if (mode === 'off') {
    return (
      <>
        Off,{' '}
        <Link
          to="/settings"
          hash="settings-scans"
          className="font-medium text-accent-ink hover:underline"
        >
          turn on in Settings
        </Link>
      </>
    )
  }
  return <>{d.imageSecurity ? 'Scanned' : 'Not available yet'}</>
}
