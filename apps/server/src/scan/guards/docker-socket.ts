import {
  isDockerSocketPath,
  type DockerSocketEvidence,
  type FactMount,
  type SocketMount,
} from '@hinomi/shared'
import type { Guard, GuardSubjectResult } from './types.js'

// docker_socket (docs/design/phase-2.md section 4.2): is the Docker daemon socket, or a folder
// that holds it, mounted into the container? Read only mounts count: every API call still works.

function socketMounts(mounts: readonly FactMount[]): SocketMount[] {
  return mounts
    .filter((m) => m.type === 'bind' && m.source !== null && isDockerSocketPath(m.source))
    .map((m) => ({
      source: m.origin,
      hostPath: m.source ?? '',
      containerPath: m.target,
      readOnly: m.readOnly,
      service: m.service,
    }))
}

export const dockerSocketGuard: Guard = {
  check: 'docker_socket',
  capabilities: { coolify: 'partial' },
  run(ctx) {
    const results: GuardSubjectResult[] = []
    for (const deployment of ctx.deployments) {
      const subject = { deploymentId: deployment.id }
      const facts = deployment.facts
      const evidence = (over: Partial<DockerSocketEvidence>): DockerSocketEvidence => ({
        check: 'docker_socket',
        mounts: [],
        checked: facts?.mountsChecked ?? [],
        reason: null,
        ...over,
      })
      if (!facts) {
        results.push({
          subject,
          level: 'unknown',
          evidence: evidence({ reason: 'The source has not reported this deployment yet.' }),
        })
        continue
      }
      const found = socketMounts(facts.mounts)
      if (found.length > 0) {
        results.push({
          subject,
          level: 'fail',
          evidence: evidence({ mounts: found, reason: facts.gaps.mounts ?? null }),
        })
      } else if (facts.mountsChecked.length === 0) {
        // Nothing could be read: a pass would look safe.
        results.push({
          subject,
          level: 'unknown',
          evidence: evidence({
            reason: facts.gaps.mounts ?? 'The source did not report any mounts of this deployment.',
          }),
        })
      } else {
        // A gap that left some sources unread stays in the evidence next to the pass.
        results.push({
          subject,
          level: 'pass',
          evidence: evidence({ reason: facts.gaps.mounts ?? null }),
        })
      }
    }
    return results
  },
}
