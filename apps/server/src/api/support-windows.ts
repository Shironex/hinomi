import type { OverviewWindow } from '@hinomi/shared'
import type { ApiDeps } from './deps.js'
import { runtimeOf } from './routes/repos.js'

/** How many lines the overview strip shows. */
export const OVERVIEW_WINDOWS = 5

/**
 * The runtime lines, over every repo, that end security support soonest. A line whose date has
 * passed comes first. Runtimes judged by releases behind the latest (Rust, Bun) carry no date
 * and never appear; neither does a line the support data does not know.
 */
export function overviewWindows(
  deps: Pick<ApiDeps, 'repositories' | 'support' | 'now'>,
): OverviewWindow[] {
  const windows: OverviewWindow[] = []
  for (const repo of deps.repositories.repos.list()) {
    for (const entry of runtimeOf(deps, repo).supportLines.runtimes) {
      const { support } = entry
      if (entry.rule !== 'support_window' || !support?.eolFrom || support.daysLeft === null) {
        continue
      }
      windows.push({
        repoId: repo.id,
        repoName: `${repo.owner}/${repo.name}`,
        runtime: entry.runtime,
        line: support.line,
        eolFrom: support.eolFrom,
        daysLeft: support.daysLeft,
        result: entry.result,
      })
    }
  }
  return windows
    .sort((a, b) => a.eolFrom.localeCompare(b.eolFrom) || a.repoName.localeCompare(b.repoName))
    .slice(0, OVERVIEW_WINDOWS)
}
