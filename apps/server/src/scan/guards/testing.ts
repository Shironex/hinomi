import type { GuardCheck, RootUserEvidence } from '@hinomi/shared'
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
