/**
 * The runner cannot go on: a bad input, a checkout that does not match the dispatch, or a
 * tool that is missing. The action fails with this message and writes no result file.
 */
export class FixRunnerError extends Error {
  override readonly name = 'FixRunnerError'
}
