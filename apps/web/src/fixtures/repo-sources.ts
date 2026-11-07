import type { RepoDetail, RepoRef, RepoSourceSeen, SourceDto } from '@hinomi/shared'
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
    release: {
      tier: 'auto',
      status: 'deployed',
      latestTag: null,
      latestAt: null,
      installers: null,
      installerAssets: [],
      checkedAt: null,
      openFindings: 0,
      fixedOnDefaultBranch: 0,
      lockfileMissing: false,
    },
  }
}
