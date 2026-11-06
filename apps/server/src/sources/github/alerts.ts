import type {
  AdvisoryRecord,
  DependabotAlertsResult,
  DependencyScope,
  DismissedAlertRecord,
  Ecosystem,
  RepoAlertRecord,
  Severity,
} from '@hinomi/shared'
import type { z } from 'zod'
import type { GithubClient } from './client.js'
import { GithubError } from './errors.js'
import { graphqlAlertsSchema, parsePayload } from './schemas.js'

const PAGE_SIZE = 100
const MAX_PAGES = 100

function query(state: AlertState): string {
  return `
query DependabotAlerts($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    vulnerabilityAlerts(first: ${PAGE_SIZE}, after: $cursor, states: ${state}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        createdAt
        dismissedAt
        dismissReason
        dismissComment
        vulnerableManifestPath
        dependencyScope
        securityVulnerability {
          severity
          vulnerableVersionRange
          firstPatchedVersion { identifier }
          package { name ecosystem }
          advisory {
            ghsaId
            summary
            publishedAt
            identifiers { type value }
            cvss { score vectorString }
          }
        }
      }
    }
  }
}`
}

type AlertState = 'OPEN' | 'DISMISSED'

const ECOSYSTEMS: Record<string, Ecosystem> = {
  NPM: 'npm',
  PIP: 'pip',
  RUBYGEMS: 'rubygems',
  MAVEN: 'maven',
  NUGET: 'nuget',
  COMPOSER: 'composer',
  GO: 'go',
  RUST: 'rust',
  ACTIONS: 'actions',
  PUB: 'pub',
  SWIFT: 'swift',
  ERLANG: 'erlang',
}

const SEVERITIES: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'moderate',
  LOW: 'low',
}

export function mapEcosystem(value: string): Ecosystem {
  return ECOSYSTEMS[value.toUpperCase()] ?? 'other'
}

export function mapScope(value: string | null): DependencyScope | null {
  if (value === 'RUNTIME') return 'runtime'
  if (value === 'DEVELOPMENT') return 'dev'
  return null
}

function mapSeverity(value: string): Severity {
  const severity = SEVERITIES[value.toUpperCase()]
  if (!severity) throw new GithubError('parse', `Unknown advisory severity "${value}"`)
  return severity
}

/** GitHub reports 0 with no vector when an advisory has no CVSS score. */
function mapCvss(
  cvss: { score: number | null; vectorString: string | null } | null,
): number | null {
  if (cvss === null || cvss.score === null) return null
  if (cvss.score === 0 && !cvss.vectorString) return null
  return cvss.score
}

/** Open and dismissed Dependabot alerts of one repo, as advisories (deduplicated) and alert records. */
export async function fetchDependabotAlerts(
  client: GithubClient,
  owner: string,
  name: string,
): Promise<DependabotAlertsResult> {
  const advisories = new Map<string, AdvisoryRecord>()
  const alerts: RepoAlertRecord[] = []
  const dismissed: DismissedAlertRecord[] = []

  await forEachAlert(client, owner, name, 'OPEN', (node) => {
    alerts.push(recordOf(owner, name, node, advisories))
  })
  await forEachAlert(client, owner, name, 'DISMISSED', (node) => {
    const record = recordOf(owner, name, node, advisories)
    dismissed.push({
      ...record,
      dismissedAt: node.dismissedAt ?? record.createdAt,
      dismissReason: node.dismissReason ?? null,
      dismissComment: node.dismissComment ?? null,
    })
  })

  return { advisories: [...advisories.values()], alerts, dismissed }
}

type AlertNode = NonNullable<
  NonNullable<
    z.infer<typeof graphqlAlertsSchema>['repository']
  >['vulnerabilityAlerts']['nodes'][number]
>

async function forEachAlert(
  client: GithubClient,
  owner: string,
  name: string,
  state: AlertState,
  visit: (node: AlertNode) => void,
): Promise<void> {
  const text = query(state)
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await client.graphql(text, { owner, name, cursor })
    const data = parsePayload(graphqlAlertsSchema, raw, 'vulnerability alerts')
    if (data.repository === null) {
      throw new GithubError('not_found', `Repository ${owner}/${name} not found`)
    }
    const connection = data.repository.vulnerabilityAlerts
    for (const node of connection.nodes) {
      if (node !== null) visit(node)
    }
    if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) break
    cursor = connection.pageInfo.endCursor
  }
}

/** Registers the node's advisory (once per advisory and package) and returns its alert record. */
function recordOf(
  owner: string,
  name: string,
  node: AlertNode,
  advisories: Map<string, AdvisoryRecord>,
): RepoAlertRecord {
  const vuln = node.securityVulnerability
  const ecosystem = mapEcosystem(vuln.package.ecosystem)
  const ghsaId = vuln.advisory.ghsaId
  const key = `${ghsaId}|${ecosystem}|${vuln.package.name}`
  if (!advisories.has(key)) {
    advisories.set(key, {
      ghsaId,
      cveIds: vuln.advisory.identifiers.filter((id) => id.type === 'CVE').map((id) => id.value),
      package: vuln.package.name,
      ecosystem,
      severity: mapSeverity(vuln.severity),
      cvss: mapCvss(vuln.advisory.cvss),
      summary: vuln.advisory.summary,
      vulnerableRange: vuln.vulnerableVersionRange,
      firstPatched: vuln.firstPatchedVersion?.identifier ?? null,
      publishedAt: vuln.advisory.publishedAt,
    })
  }
  return {
    owner,
    repo: name,
    alertNumber: node.number,
    ghsaId,
    package: vuln.package.name,
    ecosystem,
    scope: mapScope(node.dependencyScope),
    manifestPath: node.vulnerableManifestPath,
    createdAt: node.createdAt,
    dismissedAt: node.dismissedAt,
  }
}
