// Finds the steps that break the lockfile install. Called after the install with every step
// failed. It first checks the install passes with no step at all (else the repo itself is
// broken and no step is to blame), then splits the steps in halves and keeps every half that
// installs together with what was already kept, so a step that only fails in combination is
// found too. Each attempt is one cheap lockfile only install.

export interface Attempt {
  ok: boolean
  output: string
}

export interface BisectHooks {
  /** Restores the tree, applies these steps (in plan order) and runs the lockfile install. */
  attempt(stepIds: string[]): Promise<Attempt>
}

export interface BisectResult {
  /** Steps that install together, in plan order. */
  kept: string[]
  /** Steps that broke the install, with the first error line. */
  failed: Map<string, string>
  /** The install fails even with no step applied. */
  baselineBroken: boolean
  /** The output of the last attempt, which left the tree in its final state. */
  lastAttempt: Attempt
  attempts: number
}

/** The first line of install output that names an error, else the first line. */
export function firstErrorLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const line = lines.find((l) => /(^|[^A-Za-z])(ERR|error)/i.test(l)) ?? lines[0] ?? ''
  return line.slice(0, 300)
}

export async function bisectInstall(
  stepIds: string[],
  failure: Attempt,
  hooks: BisectHooks,
): Promise<BisectResult> {
  let attempts = 0
  const attempt = async (ids: string[]) => {
    attempts++
    return hooks.attempt(ids)
  }
  const inOrder = (ids: Set<string>) => stepIds.filter((id) => ids.has(id))

  const baseline = await attempt([])
  if (!baseline.ok) {
    const detail = `install fails without any step: ${firstErrorLine(baseline.output)}`
    return {
      kept: [],
      failed: new Map(stepIds.map((id) => [id, detail])),
      baselineBroken: true,
      lastAttempt: baseline,
      attempts,
    }
  }

  const kept = new Set<string>()
  const failed = new Map<string, string>()
  let last: Attempt = baseline
  let lastIds: string[] = []

  const search = async (candidates: string[], failing: Attempt): Promise<void> => {
    if (candidates.length === 1 && candidates[0]) {
      failed.set(candidates[0], firstErrorLine(failing.output))
      return
    }
    const mid = Math.ceil(candidates.length / 2)
    const left = candidates.slice(0, mid)
    const right = candidates.slice(mid)
    const leftIds = inOrder(new Set([...kept, ...left]))
    const leftResult = await attempt(leftIds)
    last = leftResult
    lastIds = leftIds
    if (!leftResult.ok) {
      await search(left, leftResult)
    } else {
      for (const id of left) kept.add(id)
      // kept plus right is now exactly the set known to fail, no need to try it again.
      await search(right, failing)
      return
    }
    const rightIds = inOrder(new Set([...kept, ...right]))
    const rightResult = await attempt(rightIds)
    last = rightResult
    lastIds = rightIds
    if (rightResult.ok) for (const id of right) kept.add(id)
    else await search(right, rightResult)
  }
  await search(stepIds, failure)

  const finalIds = inOrder(kept)
  if (!last.ok || lastIds.join('\n') !== finalIds.join('\n')) {
    last = await attempt(finalIds)
  }
  return { kept: finalIds, failed, baselineBroken: false, lastAttempt: last, attempts }
}
