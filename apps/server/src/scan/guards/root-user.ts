import {
  classifyContainerUser,
  hasNonrootTag,
  parseImageRef,
  type DeploymentFacts,
  type FactService,
  type GuardResult,
  type InlineDockerfileFact,
  type RootUserEvidence,
} from '@hinomi/shared'
import type { DeploymentRow } from '../../db/schema.js'
import { readInlineDockerfile } from '../../sources/coolify/index.js'
import { repoOfDeployment, worst } from './container-guard.js'
import type { Guard, GuardContext, GuardSubjectResult } from './types.js'

// root_user (docs/design/phase-2.md section 4.1, Q9, Q10): does the main process run as root?
// The first source that answers wins: the run options' --user, then compose `user:` (or the
// service image), then the Dockerfile (inline, else fetched from the repo at the deployed
// commit). A source that cannot say is `unknown` with the reason, never a pass.

interface Verdict {
  result: GuardResult
  evidence: RootUserEvidence
}

const NO_USER_SIGNAL = 'this build pack does not say which user the container runs as'

function evidence(over: Partial<RootUserEvidence>): RootUserEvidence {
  return {
    check: 'root_user',
    source: 'none',
    user: null,
    path: null,
    line: null,
    from: null,
    stage: null,
    commit: null,
    services: [],
    reason: null,
    ...over,
  }
}

/** A user value as the source wrote it: root, not root, or unreadable (a variable left in it). */
function userResult(value: string): GuardResult {
  if (value.includes('$')) return 'unknown'
  return classifyContainerUser(value) === 'root' ? 'fail' : 'pass'
}

const UNRESOLVED = (value: string) => `the user "${value}" uses a variable with no default value`

function runOptionsVerdict(user: string): Verdict {
  const result = userResult(user)
  return {
    result,
    evidence: evidence({
      source: 'run_options',
      user,
      reason: result === 'unknown' ? UNRESOLVED(user) : null,
    }),
  }
}

/** One compose service: its `user:`, else its image (a nonroot tag passes), else its build. */
function serviceVerdict(service: FactService): { result: GuardResult; reason: string | null } {
  if (service.user !== null) {
    const result = userResult(service.user)
    return { result, reason: result === 'unknown' ? UNRESOLVED(service.user) : null }
  }
  if (service.image !== null) {
    const ref = parseImageRef(service.image)
    if (ref === null)
      return {
        result: 'unknown',
        reason: `the image "${service.image}" has an unresolved variable`,
      }
    if (hasNonrootTag(ref))
      return { result: 'pass', reason: 'the image tag says it runs as a non root user' }
    return { result: 'warn', reason: null }
  }
  return {
    result: 'unknown',
    reason: 'the service is built from a Dockerfile, which is not read for compose builds',
  }
}

function composeVerdict(services: readonly FactService[]): Verdict {
  const entries = services.map((service) => ({ service, ...serviceVerdict(service) }))
  const top = worst(entries)
  return {
    result: top?.result ?? 'unknown',
    evidence: evidence({
      source: 'compose',
      user: top?.service.user ?? null,
      from: top?.service.image ?? null,
      reason: top?.reason ?? 'the compose file has no services',
      services: entries.map(({ service, result }) => ({
        name: service.name,
        user: service.user,
        image: service.image,
        result,
      })),
    }),
  }
}

/** A Dockerfile reading (inline or fetched) as a verdict. */
function dockerfileVerdict(
  reading: InlineDockerfileFact,
  where: { path: string | null; commit: string | null },
): Verdict {
  const base = {
    source: 'dockerfile' as const,
    user: reading.user,
    path: where.path,
    line: reading.line,
    from: reading.from,
    stage: reading.stage,
    commit: where.commit,
  }
  switch (reading.kind) {
    case 'root':
      return { result: 'fail', evidence: evidence(base) }
    case 'non_root':
      return { result: 'pass', evidence: evidence(base) }
    case 'unknown':
      return {
        result: 'unknown',
        evidence: evidence({ ...base, reason: UNRESOLVED(reading.user ?? '') }),
      }
    case 'none':
      return reading.baseNonroot
        ? {
            result: 'pass',
            evidence: evidence({
              ...base,
              reason: 'the base image tag says it runs as a non root user',
            }),
          }
        : {
            result: 'warn',
            evidence: evidence({
              ...base,
              reason:
                'no USER in the final stage, so it probably runs as the base image user (root)',
            }),
          }
  }
}

/** Dockerfile path inside the repo: base directory plus location, no `..`, no leading slash. */
function dockerfilePath(baseDirectory: string | null, location: string | null): string | null {
  const parts = `${baseDirectory ?? ''}/${location ?? 'Dockerfile'}`
    .split('/')
    .filter((p) => p && p !== '.')
  return parts.includes('..') ? null : parts.join('/')
}

async function dockerfileFromRepo(
  ctx: GuardContext,
  deployment: DeploymentRow,
  facts: DeploymentFacts,
): Promise<Verdict | null> {
  const df = facts.dockerfile
  if (!df) return null
  const unknown = (reason: string, over: Partial<RootUserEvidence> = {}): Verdict => ({
    result: 'unknown',
    evidence: evidence({ source: 'dockerfile', reason, ...over }),
  })
  const repo = repoOfDeployment(ctx, deployment)
  if (!repo) return unknown('the deployment has no repository to read the Dockerfile from')
  const ref = facts.commit ?? deployment.gitBranch
  if (!ref) return unknown('the deployed commit and branch are both unknown')
  const path = dockerfilePath(df.baseDirectory, df.location)
  if (!path) return unknown('the Dockerfile location is not a path inside the repository')

  const read = await ctx.repoFiles.read(repo, path, ref)
  const commit = facts.commit
  switch (read.status) {
    case 'ok':
      return dockerfileVerdict(readInlineDockerfile(read.text, df.target), { path, commit })
    case 'missing':
      return unknown(
        `${path} was not found in ${repo.owner}/${repo.name} at ${commit ? 'the deployed commit' : ref}`,
        { path, commit },
      )
    case 'no_source':
      return unknown('no GitHub source can read this repository, so its Dockerfile was not read', {
        path,
      })
    case 'error':
      return null
  }
}

async function verdictOf(ctx: GuardContext, deployment: DeploymentRow): Promise<Verdict | null> {
  const facts = deployment.facts
  if (!facts) {
    return {
      result: 'unknown',
      evidence: evidence({ reason: 'The source has not reported this deployment yet.' }),
    }
  }
  if (facts.user !== null) return runOptionsVerdict(facts.user)
  if (facts.services.length > 0) return composeVerdict(facts.services)
  if (facts.dockerfile?.inline) {
    return dockerfileVerdict(facts.dockerfile.inline, { path: null, commit: null })
  }
  if (facts.dockerfile && !facts.gaps.dockerfile) return dockerfileFromRepo(ctx, deployment, facts)

  // No signal. An image only deployment is still non root when its tag says so.
  const ref = facts.image === null ? null : parseImageRef(facts.image)
  if (ref && hasNonrootTag(ref)) {
    return {
      result: 'pass',
      evidence: evidence({
        from: facts.image,
        reason: 'the image tag says it runs as a non root user',
      }),
    }
  }
  return {
    result: 'unknown',
    evidence: evidence({
      from: facts.image,
      reason: facts.gaps.user ?? facts.gaps.dockerfile ?? NO_USER_SIGNAL,
    }),
  }
}

export const rootUserGuard: Guard = {
  check: 'root_user',
  capabilities: { coolify: 'partial' },
  async run(ctx) {
    const results: GuardSubjectResult[] = []
    for (const deployment of ctx.deployments) {
      // Managed databases are not built by the user: noise by default (section 4.1).
      if (deployment.kind === 'database') continue
      const subject = { deploymentId: deployment.id }
      const verdict = await verdictOf(ctx, deployment)
      if (verdict === null) results.push({ subject, level: null })
      else if (verdict.result === 'pass')
        results.push({ subject, level: 'pass', evidence: verdict.evidence })
      else results.push({ subject, level: verdict.result, evidence: verdict.evidence })
    }
    return results
  },
}
