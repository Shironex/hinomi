import { useQuery } from '@tanstack/react-query'
import { useScanStatus } from '@/hooks/use-shell-data'
import { accessLabel, useAccessStatus } from '@/hooks/use-access'
import { formatClock, formatRelative } from '@/lib/format'
import {
  channelsQuery,
  deploymentsQuery,
  githubWebhookQuery,
  webhookRunnerQuery,
  settingsQuery,
  sourcesQuery,
} from '@/lib/settings-api'
import { guardsQuery, overridesQuery } from '@/lib/guards-api'
import { versionQuery } from '@/lib/queries'
import { useTheme } from '@/lib/theme'
import { versionLabel } from '@/lib/version'
import { THEME_LABEL } from '@/components/shell/theme-meta'

export type SettingsSectionKey =
  | 'sources'
  | 'notifications'
  | 'scans'
  | 'checks'
  | 'mapping'
  | 'webhook'
  | 'runner'
  | 'access'
  | 'appearance'
  | 'about'

const KIND_WORD = { discord: 'Discord', webhook: 'webhook', email: 'email' } as const

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Discord and email", "Discord, webhook and email". */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/** "every 6 hours" from the scan interval in minutes. */
export function everyLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `Every ${plural(minutes / (24 * 60), 'day')}`
  if (minutes % 60 === 0) return `Every ${plural(minutes / 60, 'hour')}`
  return `Every ${plural(minutes, 'minute')}`
}

/**
 * The one line under each section in the settings list ("2 connected, OSV.dev on"), from the
 * same queries the sections use, so opening a section costs no extra call. Undefined while a
 * query loads or fails; the row then shows only its name.
 */
export function useSectionSummaries(): Partial<Record<SettingsSectionKey, string>> {
  const sources = useQuery(sourcesQuery)
  const settings = useQuery(settingsQuery)
  const channels = useQuery(channelsQuery)
  const deployments = useQuery(deploymentsQuery)
  const webhook = useQuery(githubWebhookQuery)
  const runner = useQuery(webhookRunnerQuery)
  const version = useQuery(versionQuery)
  const guards = useQuery(guardsQuery)
  const overrides = useQuery(overridesQuery)
  const scan = useScanStatus()
  const access = useAccessStatus()
  const theme = useTheme()

  const out: Partial<Record<SettingsSectionKey, string>> = {}

  if (sources.data) {
    const connected = sources.data.sources.filter((s) => s.hasToken && s.enabled).length
    const parts = [connected === 0 ? 'Nothing connected' : `${connected} connected`]
    if (settings.data) parts.push(`OSV.dev ${settings.data.osvEnabled ? 'on' : 'off'}`)
    if (!sources.data.canStoreTokens) parts.push('secret key missing')
    out.sources = parts.join(', ')
  }

  if (channels.data) {
    const on = channels.data.items.filter((c) => c.enabled)
    const kinds = [...new Set(on.map((c) => KIND_WORD[c.kind]))]
    out.notifications =
      channels.data.items.length === 0
        ? 'No channels yet'
        : on.length === 0
          ? 'All channels off'
          : `${joinWords(kinds).replace(/^./, (c) => c.toUpperCase())} on`
  }

  if (settings.data) {
    const every = everyLabel(settings.data.scanIntervalMinutes)
    out.scans =
      scan.state === 'idle' && scan.nextScanAt
        ? `${every}, next ${formatClock(scan.nextScanAt)}`
        : scan.state === 'unconfigured'
          ? `${every}, paused until a source is connected`
          : every
  }

  if (guards.data) {
    const off = overrides.data?.items.length
    out.checks = [
      plural(guards.data.items.length, 'check'),
      off === undefined ? null : off === 0 ? 'none turned off' : `${off} turned off`,
    ]
      .filter(Boolean)
      .join(', ')
  }

  if (deployments.data) {
    const apps = deployments.data.items.filter((d) => d.kind !== 'database')
    const matched = apps.filter((d) => d.mapping !== 'none').length
    out.mapping =
      apps.length === 0
        ? 'No deployments yet'
        : `${matched} of ${plural(apps.length, 'app')} matched`
  }

  if (webhook.data) {
    const w = webhook.data
    out.webhook = !w.canStoreSecret
      ? 'secret key missing'
      : w.enabled
        ? w.lastDeliveryAt
          ? `On, last delivery ${formatRelative(w.lastDeliveryAt)}`
          : 'On, no delivery yet'
        : w.secretSet
          ? 'Secret set, off'
          : 'Off'
  }

  if (runner.data) {
    const r = runner.data
    out.runner = !r.canStoreSecret
      ? 'secret key missing'
      : r.configured
        ? 'Configured'
        : r.url
          ? 'URL set, needs a secret'
          : 'Not configured'
  }

  if (access) out.access = accessLabel(access)
  out.appearance = `${THEME_LABEL[theme]} theme`

  if (version.data) {
    const { update } = version.data
    out.about = update
      ? `${versionLabel(version.data)}, v${update.version} available`
      : versionLabel(version.data)
  }

  return out
}
