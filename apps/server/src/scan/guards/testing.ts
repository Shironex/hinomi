import type { GuardCheck, RootUserEvidence } from '@hinomi/shared'
import type { RepoFileRead, RepoFileReader } from './repo-files.js'
import type { Guard, GuardContext, GuardSubjectResult } from './types.js'

// Test helpers: a fake check whose results the test sets between scans. Fictional data only.

/** Root user evidence as a Dockerfile check would write it. */
export function rootUserEvidence(over: Partial<RootUserEvidence> = {}): RootUserEvidence {
  return {
    check: 'root_user',
    source: 'dockerfile',
    user: null,
    path: 'apps/api/Dockerfile',
    line: 31,
    from: 'node:22-alpine',
    stage: null,
    commit: null,
    services: [],
    reason: null,
    ...over,
  }
}

/**
 * A check that returns whatever `results` holds when it runs (or throws `error` when set), and
 * records each context it was given.
 */
export function fakeGuard(check: GuardCheck = 'root_user') {
  const state: {
    results: GuardSubjectResult[]
    error: Error | null
    contexts: GuardContext[]
  } = { results: [], error: null, contexts: [] }
  const guard: Guard = {
    check,
    capabilities: { coolify: 'partial' },
    run(ctx) {
      state.contexts.push(ctx)
      if (state.error) throw state.error
      return state.results
    },
  }
  return { guard, state }
}

/** A repo file reader with no GitHub source behind it: every read says so. */
export function noRepoFiles(): RepoFileReader {
  return { read: () => Promise.resolve({ status: 'no_source' }) }
}

/**
 * A repo file reader over canned files, keyed `path@ref`; a file that is not listed is
 * missing. Records every read; a read at a ref in `failing` answers `error`.
 */
export function fakeRepoFiles(files: Record<string, string>, failing: readonly string[] = []) {
  const reads: { owner: string; name: string; path: string; ref: string }[] = []
  const reader: RepoFileReader = {
    read(repo, path, ref): Promise<RepoFileRead> {
      reads.push({ owner: repo.owner, name: repo.name, path, ref })
      if (failing.includes(ref)) return Promise.resolve({ status: 'error', reason: 'rate limited' })
      const text = files[`${path}@${ref}`]
      return Promise.resolve(text === undefined ? { status: 'missing' } : { status: 'ok', text })
    },
  }
  return { reader, reads }
}
