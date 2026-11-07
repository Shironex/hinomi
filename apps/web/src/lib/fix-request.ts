/**
 * The "Fix with Hinomi" request: any button or the f key asks for the dispatch dialog, and the
 * one dialog the shell mounts answers. Kept outside React so list actions can call it too.
 */
export interface FixRequestRepo {
  id: number
  fullName: string
  /** Findings of the fix or finding that sit in this repo, when the caller knows. */
  findings?: number
}

export interface FixRequest {
  /** Repos to choose from, most findings first. One repo skips the choice. */
  repos: readonly FixRequestRepo[]
  /** The finding the request came from, to say whether the plan covers it. */
  findingId?: number
  /** Bumped on every request, so asking twice reopens a closed dialog. */
  n: number
}

/** Why a Fix with Hinomi button is off when no repo has a plan yet. */
export const NO_PLAN_NOTE = 'No fix plan yet. The next scan builds one per repo.'

let current: FixRequest | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function requestFix(request: Omit<FixRequest, 'n'>) {
  if (request.repos.length === 0) return
  current = { ...request, n: (current?.n ?? 0) + 1 }
  emit()
}

export function closeFix() {
  if (current === null) return
  current = null
  emit()
}

export function subscribeFix(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFixRequest(): FixRequest | null {
  return current
}
