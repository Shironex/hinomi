import type {
  ReleaseTierMode,
  RepoDetail,
  RepoRef,
  RepoRelease,
  RepoSourceSeen,
  SourceDto,
} from '@hinomi/shared'
import { REPOS, SOURCES, ago } from './dataset'
import { PLANS } from './fix-runs'

// Which GitHub source reads each fixture repo. The kestrel-co GitHub App (source 2) reads most;
// the mara-kestrel token (source 3) reads kestrel-cli, which the app is not installed on, and
// also sees storefront and auth. Auth is pinned to the token by hand; storefront follows the
// scan, which prefers the app because the token cannot read its Dependabot alerts. The repos
// that only have fix plans (./fix-runs) are read by the app too.

const APP = 2
const TOKEN = 3

function github(id: number): SourceDto {
  const source = SOURCES.find((s) => s.id === id && s.kind === 'github')
  if (!source) throw new Error(`No fixture GitHub source ${id}`)
  return source
}

function seen(id: number, alertsReadable: boolean): RepoSourceSeen {
  const { name, auth, enabled } = github(id)
  return { id, name, auth, enabled, alertsReadable, lastSeenAt: ago(0.25) }
}

interface Placement {
  current: number
  override: number | null
  seenBy: RepoSourceSeen[]
}

const PLACEMENTS: Partial<Record<number, Placement>> = {
  [REPOS.storefront.id]: {
    current: APP,
    override: null,
    seenBy: [seen(APP, true), seen(TOKEN, false)],
  },
  [REPOS.auth.id]: {
    current: TOKEN,
    override: TOKEN,
    seenBy: [seen(APP, true), seen(TOKEN, true)],
  },
  [REPOS.cli.id]: { current: TOKEN, override: null, seenBy: [seen(TOKEN, true)] },
}

/** Every fixture repo: the scanned ones and those that only have a fix plan. */
export const ALL_REPOS: RepoRef[] = [
  ...Object.values(REPOS),
  ...PLANS.map((p) => p.repo).filter((r) => !Object.values(REPOS).some((k) => k.id === r.id)),
]

// The latest release of the repos nothing deploys. kestrel-desk ships installers; kestrel-cli
// ships one archive per platform that the installer check does not read as an app.
interface LatestRelease {
  tag: string
  at: string
  installerAssets: string[]
  openFindings: number
  fixedOnDefaultBranch: number
}

const LATEST: Partial<Record<number, LatestRelease>> = {
  [REPOS.desk.id]: {
    tag: 'v2.3.0',
    at: ago(24 * 9),
    installerAssets: [
      'Kestrel-2.3.0-universal.dmg',
      'Kestrel-Setup-2.3.0.exe',
      'Kestrel-2.3.0.AppImage',
      'kestrel-desk_2.3.0_amd64.deb',
    ],
    openFindings: 2,
    fixedOnDefaultBranch: 1,
  },
  [REPOS.cli.id]: {
    tag: 'v0.8.2',
    at: ago(24 * 21),
    installerAssets: [],
    openFindings: 0,
    fixedOnDefaultBranch: 0,
  },
}

/** The mode each repo was set to by a PUT in this session; fixture mode keeps it in memory. */
const tierModes = new Map<number, ReleaseTierMode>()

/** PUT /api/repos/:id/release-tier. Null: no such repo. */
export function setReleaseTier(id: number, tier: ReleaseTierMode): RepoDetail | null {
  if (!ALL_REPOS.some((r) => r.id === id)) return null
  tierModes.set(id, tier)
  return repoDetailFor(id)
}

function releaseFor(id: number): RepoRelease {
  const tier = tierModes.get(id) ?? 'auto'
  const latest = LATEST[id]
  const base = {
    tier,
    latestTag: latest?.tag ?? null,
    latestAt: latest?.at ?? null,
    installers: latest ? latest.installerAssets.length > 0 : null,
    installerAssets: latest?.installerAssets ?? [],
    checkedAt: latest ? ago(3) : null,
    lockfileMissing: false,
  }
  if (!latest) {
    // A repo a deployment runs keeps its deploy tiers and is never asked for its release.
    return {
      ...base,
      status: 'deployed',
      openFindings: 0,
      fixedOnDefaultBranch: 0,
    }
  }
  const status =
    tier === 'off' ? 'turned_off' : tier === 'on' || base.installers ? 'released' : 'no_installers'
  const released = status === 'released'
  return {
    ...base,
    status,
    openFindings: released ? latest.openFindings : 0,
    fixedOnDefaultBranch: released ? latest.fixedOnDefaultBranch : 0,
  }
}

/** GET /api/repos/:id: the repo with the GitHub source that reads it. */
export function repoDetailFor(id: number): RepoDetail | null {
  const repo = ALL_REPOS.find((r) => r.id === id)
  if (!repo) return null
  const placement = PLACEMENTS[id] ?? { current: APP, override: null, seenBy: [seen(APP, true)] }
  const { name, auth, enabled } = github(placement.current)
  return {
    ...repo,
    source: {
      current: { id: placement.current, name, auth, enabled },
      mode: placement.override === null ? 'auto' : 'override',
      overrideId: placement.override,
      seenBy: placement.seenBy,
    },
    release: releaseFor(id),
    // The runtime panel (phase 2 slice 13) fills these in its own fixtures.
    runtimePins: [],
    supportLines: { available: false, runtimes: [] },
  }
}
