import type { DeploymentFacts } from '@hinomi/shared'

/** Path parts without empty and `.` parts. */
const partsOf = (path: string): string[] =>
  path.split('/').filter((part) => part !== '' && part !== '.')

/**
 * The repo relative path of the Dockerfile a deployment builds, from its facts: the base
 * directory joined with the Dockerfile location (Coolify: `/apps/api` and `/Dockerfile` give
 * `apps/api/Dockerfile`). Null when the deployment builds no Dockerfile from the repo (another
 * build pack, an inline Dockerfile, or facts that do not say).
 */
export function deployedDockerfilePath(facts: DeploymentFacts | null): string | null {
  const dockerfile = facts?.dockerfile
  if (!dockerfile || dockerfile.inline !== null) return null
  const parts = [
    ...partsOf(dockerfile.baseDirectory ?? ''),
    ...partsOf(dockerfile.location ?? 'Dockerfile'),
  ]
  // A `..` would leave the base directory; such a path names nothing the walk can find.
  if (parts.length === 0 || parts.includes('..')) return null
  return parts.join('/')
}

/**
 * The Dockerfiles the deployments of one repo build, for `productionDockerfiles`. Undefined when
 * no deployment has facts yet, so the readers fall back to the root `Dockerfile`; an empty set
 * when the facts say no deployment builds a Dockerfile from the repo.
 */
export function deployedDockerfiles(
  deployments: readonly { facts: DeploymentFacts | null }[],
): Set<string> | undefined {
  if (!deployments.some((d) => d.facts !== null)) return undefined
  const paths = new Set<string>()
  for (const deployment of deployments) {
    const path = deployedDockerfilePath(deployment.facts)
    if (path !== null) paths.add(path)
  }
  return paths
}
