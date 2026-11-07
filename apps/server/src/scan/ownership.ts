import type { RepoHealth } from '@hinomi/shared'
import type { RepoRow } from '../db/schema.js'
import { isGithubError } from '../sources/github/index.js'
import type { GithubScanSource, ScanSources } from './sources.js'

// Which GitHub source reads a repo. A scan asks every enabled GitHub source that may see the repo
// and picks its reader by one rule, so the answer does not depend on scan order or history:
//   1. a source picked by hand (repos.source_override_id), while it is enabled;
//   2. else the lowest id source that can read the repo and tell whether its Dependabot alerts
//      are on (a token without the alerts permission answers null);
//   3. else the lowest id source that can read the repo at all.
// When no source can read it, a reader that only failed for a passing reason (network, rate
// limit) stays, so a bad minute does not move the repo; otherwise the repo has no reader.

/** What asking one source about one repo said. */
export interface SourceProbe {
  sourceId: number
  /** True: it reads the repo. False: GitHub says it cannot see it. Null: the answer was an error. */
  sees: boolean | null
  /** The source could tell whether Dependabot alerts are on. Null unless it sees the repo. */
  alertsReadable: boolean | null
  /** The error when `sees` is null. */
  error?: string
}

export interface RepoOwnership {
  /** The source the scan reads the repo through, or null when none can. */
  source: GithubScanSource | null
  /** Health as the reader (or, when there is none, the most telling source) answered. */
  health: { status: 'ok'; value: RepoHealth } | { status: 'error'; error: string } | null
  probes: SourceProbe[]
}

/** `owner/name` lowercased, the key of the account repo lists. */
export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase()
}

/**
 * The sources worth asking about the repo, lowest id first. An override narrows it to that
 * source; a source whose account repo list was read this scan and leaves the repo out is skipped.
 */
function candidates(
  sources: ScanSources,
  repo: RepoRow,
  listed: ReadonlyMap<number, ReadonlySet<string>>,
): { ask: GithubScanSource[]; unseen: number[] } {
  const override = sources.github.find((g) => g.sourceId === repo.sourceOverrideId)
  if (override) return { ask: [override], unseen: [] }
  const key = repoKey(repo.owner, repo.name)
  const ask: GithubScanSource[] = []
  const unseen: number[] = []
  for (const github of sources.github) {
    const list = listed.get(github.sourceId)
    if (list && !list.has(key)) unseen.push(github.sourceId)
    else ask.push(github)
  }
  return { ask, unseen }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface Answer {
  source: GithubScanSource
  health: RepoOwnership['health'] & {}
  probe: SourceProbe
  /** The error passes (network, rate limit, server error): no reason to move the repo. */
  passing: boolean
}

async function ask(source: GithubScanSource, repo: RepoRow): Promise<Answer> {
  try {
    const value = await source.fetchRepoHealth(repo.owner, repo.name)
    return {
      source,
      health: { status: 'ok', value },
      probe: {
        sourceId: source.sourceId,
        sees: true,
        alertsReadable: value.alertsEnabled !== null,
      },
      passing: false,
    }
  } catch (error) {
    const gone = isGithubError(error, 'not_found')
    const lost = gone || isGithubError(error, 'permission') || isGithubError(error, 'auth')
    return {
      source,
      health: { status: 'error', error: errorText(error) },
      probe: {
        sourceId: source.sourceId,
        sees: gone ? false : null,
        alertsReadable: null,
        ...(!gone && { error: errorText(error) }),
      },
      passing: !lost,
    }
  }
}

/** Asks the GitHub sources about one repo and picks its reader. Never throws. */
export async function resolveOwnership(
  sources: ScanSources,
  repo: RepoRow,
  listed: ReadonlyMap<number, ReadonlySet<string>> = new Map(),
): Promise<RepoOwnership> {
  const { ask: toAsk, unseen } = candidates(sources, repo, listed)
  const answers: Answer[] = []
  // One source after another: each has its own rate limit, and repos already run in parallel.
  for (const source of toAsk) answers.push(await ask(source, repo))
  const probes = [
    ...answers.map((a) => a.probe),
    ...unseen.map((sourceId) => ({ sourceId, sees: false, alertsReadable: null })),
  ].sort((a, b) => a.sourceId - b.sourceId)

  const reads = answers.filter((a) => a.health.status === 'ok')
  const reader = reads.find((a) => a.probe.alertsReadable) ?? reads[0]
  if (reader) return { source: reader.source, health: reader.health, probes }

  const current = answers.find((a) => a.source.sourceId === repo.sourceId)
  if (current?.passing) return { source: current.source, health: current.health, probes }
  // No source reads the repo: the one most worth asking carries the failure on its row.
  const telling = current ?? answers[0]
  if (telling?.health.status === 'error') telling.probe.error ??= telling.health.error
  return { source: null, health: telling?.health ?? null, probes }
}
