import type {
  DeploymentFacts,
  NetworkBasis,
  NetworkPeer,
  SharedNetworkEvidence,
} from '@hinomi/shared'
import type { DeploymentRow } from '../../db/schema.js'
import type { Guard, GuardContext, GuardSubjectResult } from './types.js'

// shared_network (docs/design/phase-2.md section 4.3): can this container reach containers of
// an unrelated project over a shared Docker network? Pure over the deployment facts: resources
// group by the Coolify destination they are attached to, or by an external network they name,
// and the project of each comes from the facts.

/** A network the resources can share: its key groups them, the rest is for the evidence. */
interface NetworkGroup {
  key: string
  basis: NetworkBasis
  network: string | null
  destination: SharedNetworkEvidence['destination']
}

/** A deployment that has facts. */
interface Member {
  row: DeploymentRow
  facts: DeploymentFacts
}

const isMember = (row: DeploymentRow): row is DeploymentRow & { facts: DeploymentFacts } =>
  row.facts !== null

/** The networks one resource is on, as far as its facts say. Host mode is handled apart. */
function groupsOf({ row, facts }: Member): NetworkGroup[] {
  const groups: NetworkGroup[] = []
  const destination = facts.destination
  if (facts.attachedToDestination === true && destination && destination.id !== null) {
    groups.push({
      key: `destination:${row.sourceId}:${destination.server ?? ''}:${destination.typeName ?? ''}:${destination.id}`,
      basis: 'coolify_destination',
      network: null,
      destination: { server: destination.server, type: destination.typeName, id: destination.id },
    })
  }
  for (const network of facts.networks) {
    groups.push({
      key: `external:${row.sourceId}:${row.server ?? ''}:${network.name}`,
      basis: 'external_network',
      network: network.name,
      destination: null,
    })
  }
  return groups
}

const projectName = (facts: DeploymentFacts) => facts.project?.name ?? facts.project?.key ?? null

/** Why the network of a resource cannot be told, or null when its facts are complete enough. */
function networkGap(facts: DeploymentFacts): string | null {
  if (facts.project === null) return facts.gaps.project ?? 'the project of this resource is unknown'
  if (facts.attachedToDestination === null)
    return (
      facts.gaps.networks ?? 'it is not known whether this resource joins the destination network'
    )
  if (facts.attachedToDestination && (!facts.destination || facts.destination.id === null))
    return facts.gaps.destination ?? 'the destination of this resource is unknown'
  return null
}

function evidence(over: Partial<SharedNetworkEvidence>): SharedNetworkEvidence {
  return {
    check: 'shared_network',
    basis: null,
    network: null,
    destination: null,
    project: null,
    peers: [],
    reason: null,
    ...over,
  }
}

export function evaluateSharedNetwork(ctx: GuardContext): GuardSubjectResult[] {
  const members: Member[] = ctx.deployments
    .filter(isMember)
    .map((row) => ({ row, facts: row.facts }))
  // Members by network key, so each resource finds its peers without scanning the rest.
  const byKey = new Map<string, Member[]>()
  for (const member of members) {
    for (const group of groupsOf(member)) {
      const list = byKey.get(group.key) ?? []
      list.push(member)
      byKey.set(group.key, list)
    }
  }

  const results: GuardSubjectResult[] = []
  for (const row of ctx.deployments) {
    const subject = { deploymentId: row.id }
    if (!isMember(row)) {
      results.push({
        subject,
        level: 'unknown',
        evidence: evidence({
          reason: 'the source has not reported the network facts of this resource yet',
        }),
      })
      continue
    }
    const self: Member = { row, facts: row.facts }
    const facts = self.facts
    const project = projectName(facts)

    if (facts.hostNetwork) {
      results.push({
        subject,
        level: 'warn',
        evidence: evidence({
          basis: 'host_network',
          project,
          reason:
            'this resource uses the host network, so it shares the network of the server and every container published on it',
        }),
      })
      continue
    }

    if (facts.project === null) {
      results.push({
        subject,
        level: 'unknown',
        evidence: evidence({ reason: networkGap(facts) }),
      })
      continue
    }
    const ownProject = facts.project.key

    let found: { group: NetworkGroup; peers: NetworkPeer[] } | null = null
    let databasePeer = false
    for (const group of groupsOf(self)) {
      const peers: NetworkPeer[] = []
      for (const other of byKey.get(group.key) ?? []) {
        if (other.row.id === row.id) continue
        const otherProject = other.facts.project?.key
        // A peer of the same project, or of an unknown one, cannot be told apart from it.
        if (!otherProject || otherProject === ownProject) continue
        peers.push({
          deploymentId: other.row.id,
          name: other.row.name,
          project: projectName(other.facts),
          database: other.row.kind === 'database',
        })
      }
      if (peers.length === 0) continue
      found ??= { group, peers }
      if (peers.some((p) => p.database)) {
        databasePeer = true
        found = { group, peers }
        break
      }
    }

    if (found) {
      const { group, peers } = found
      results.push({
        subject,
        level: databasePeer ? 'fail' : 'warn',
        evidence: evidence({
          basis: group.basis,
          network: group.network,
          destination: group.destination,
          project,
          peers,
        }),
      })
      continue
    }

    const gap = networkGap(facts)
    if (gap) {
      results.push({ subject, level: 'unknown', evidence: evidence({ project, reason: gap }) })
      continue
    }
    results.push({ subject, level: 'pass', evidence: evidence({ project }) })
  }
  return results
}

export const sharedNetworkGuard: Guard = {
  check: 'shared_network',
  capabilities: { coolify: 'partial' },
  run: evaluateSharedNetwork,
}
