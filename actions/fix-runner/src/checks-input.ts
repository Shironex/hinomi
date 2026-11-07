import type { FixChecksMode } from '@hinomi/shared'
import { FixRunnerError } from './errors.js'

export interface ChecksSelection {
  mode: FixChecksMode
  /** Only these checks (canonical names), null for every check the project defines. */
  only: string[] | null
}

/**
 * The `checks` input: `auto` (or empty) takes the dispatch's mode, `install` and `full` force
 * one, and a comma list such as `lint,test` runs full mode with only those checks.
 */
export function selectChecks(input: string, dispatchMode: FixChecksMode): ChecksSelection {
  const value = input.trim()
  if (value === '' || value === 'auto') return { mode: dispatchMode, only: null }
  if (value === 'install' || value === 'full') return { mode: value, only: null }
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (names.length === 0 || names.some((name) => !/^[a-z][a-z0-9 :-]{0,40}$/.test(name))) {
    throw new FixRunnerError(`Invalid checks input ${JSON.stringify(input)}`)
  }
  return { mode: 'full', only: names }
}
