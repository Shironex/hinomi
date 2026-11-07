import {
  BLIND_SPOT_TYPES,
  checkOverrideSchema,
  checkOverridesQuerySchema,
  checkOverridesResponseSchema,
  createCheckOverrideRequestSchema,
  GUARD_CHECKS,
  GUARD_COPY,
  guardEvidenceSchema,
  guardsResponseSchema,
  idParamSchema,
  updateCheckOverrideRequestSchema,
  type CheckOverride,
  type DeploymentGuard,
  type GuardCapability,
  type GuardCheck,
  type GuardLevel,
  type SourceKind,
} from '@hinomi/shared'
import { Hono } from 'hono'
import type { CheckOverrideRow, DeploymentRow } from '../../db/schema.js'
import type { Repositories } from '../../repository/index.js'
import {
  applyOverridesNow,
  countFindings,
  listRankedFindings,
  type Guard,
  type OverrideIndex,
  type RankedFinding,
} from '../../scan/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, readQuery, send } from '../http.js'
import { toCheckOverrideRef, toDeploymentRef, toRepoRef } from '../serialize.js'

const LEVEL_ORDER: Record<GuardLevel, number> = { unknown: 1, warn: 2, fail: 3 }

/** Capabilities of the registered guards for `check`, limited to the source kinds connected. */
function capabilitiesOf(
  check: GuardCheck,
  guards: readonly Guard[],
  connected: ReadonlySet<SourceKind>,
): Partial<Record<SourceKind, GuardCapability>> {
  const out: Partial<Record<SourceKind, GuardCapability>> = {}
  for (const guard of guards) {
    if (guard.check !== check) continue
    for (const kind of connected) {
      const capability = guard.capabilities[kind]
      if (capability) out[kind] = capability
    }
  }
  return out
}

function toCheckOverride(repositories: Repositories, row: CheckOverrideRow): CheckOverride {
  const deployment =
    row.deploymentId === null ? undefined : repositories.deployments.get(row.deploymentId)
  const repo = row.repoId === null ? undefined : repositories.repos.get(row.repoId)
  return {
    id: row.id,
    check: row.check,
    deployment: deployment ? toDeploymentRef(deployment) : null,
    repo: repo ? toRepoRef(repo) : null,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** GET /api/guards: the check registry with counts per level and active overrides. */
export function guardsRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories } = deps

  app.get('/', (c) => {
    const counts = countFindings(listRankedFindings(repositories), deps.now())
    const connected = new Set(
      repositories.sources
        .list()
        .filter((s) => s.enabled)
        .map((s) => s.kind),
    )
    const overrides = repositories.checkOverrides.list()
    return send(c, guardsResponseSchema, {
      items: GUARD_CHECKS.map((check) => {
        const copy = GUARD_COPY[check]
        return {
          check,
          title: copy.title,
          reads: copy.reads,
          levels: [...copy.levels],
          capabilities: capabilitiesOf(check, deps.guards, connected),
          counts: counts.guards.byCheck[check],
          overrides: overrides.filter((o) => o.check === check).length,
        }
      }),
    })
  })

  return app
}

/** /api/overrides: checks turned off with a reason, per deployment or per repo. */
export function overridesRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories } = deps

  function requireOverride(id: number): CheckOverrideRow {
    const row = repositories.checkOverrides.get(id)
    if (!row) throw notFound('Override')
    return row
  }

  app.get('/', (c) => {
    const query = readQuery(c, checkOverridesQuerySchema)
    const rows = repositories.checkOverrides.list({
      ...(query.check?.length && { checks: query.check }),
      ...(query.deployment?.length && { deploymentIds: query.deployment }),
      ...(query.repo?.length && { repoIds: query.repo }),
    })
    return send(c, checkOverridesResponseSchema, {
      items: rows.map((row) => toCheckOverride(repositories, row)),
    })
  })

  /** Turns a check off. Findings it covers move to accepted right away. */
  app.post('/', async (c) => {
    const body = await readJson(c, createCheckOverrideRequestSchema)
    let subject: { deploymentId: number } | { repoId: number }
    if (body.deploymentId !== undefined) {
      if (!repositories.deployments.get(body.deploymentId)) throw notFound('Deployment')
      subject = { deploymentId: body.deploymentId }
    } else if (body.repoId !== undefined) {
      if (!repositories.repos.get(body.repoId)) throw notFound('Repo')
      subject = { repoId: body.repoId }
    } else {
      throw new HttpError(400, 'bad_request', 'Give either deploymentId or repoId')
    }
    const row = repositories.db.transaction(() => {
      const created = repositories.checkOverrides.create(
        { check: body.check, subject, reason: body.reason },
        deps.now(),
      )
      if (created) applyOverridesNow(repositories, deps.now())
      return created
    })
    if (!row) {
      throw new HttpError(409, 'conflict', 'This check is already turned off for that subject')
    }
    return send(c, checkOverrideSchema, toCheckOverride(repositories, row), 201)
  })

  /** Changes the reason. Turned off findings take the new reason. */
  app.patch('/:id', async (c) => {
    const { id } = readParams(c, idParamSchema)
    requireOverride(id)
    const body = await readJson(c, updateCheckOverrideRequestSchema)
    const row = repositories.db.transaction(() => {
      const updated = repositories.checkOverrides.updateReason(id, body.reason, deps.now())
      applyOverridesNow(repositories, deps.now())
      return updated
    })
    if (!row) throw notFound('Override')
    return send(c, checkOverrideSchema, toCheckOverride(repositories, row))
  })

  /** Turns the check back on. Findings it turned off reopen when nothing else covers them. */
  app.delete('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    requireOverride(id)
    repositories.db.transaction(() => {
      repositories.checkOverrides.remove(id)
      applyOverridesNow(repositories, deps.now())
    })
    return c.body(null, 204)
  })

  return app
}

function worstOpen(findings: readonly RankedFinding[]): RankedFinding | undefined {
  return findings
    .filter((r) => r.state !== 'fixed' && r.guardLevel !== null)
    .sort((a, b) => LEVEL_ORDER[b.guardLevel!] - LEVEL_ORDER[a.guardLevel!])[0]
}

function evidenceOf(ranked: RankedFinding | undefined): DeploymentGuard['evidence'] {
  if (!ranked) return null
  const parsed = guardEvidenceSchema.safeParse(ranked.finding.evidence)
  return parsed.success ? parsed.data : null
}

/**
 * The deployment's guards panel: one entry per guard check (findings on the deployment or on a
 * repo it runs), then `archived_deployed` and any other blind spot type that is open on it or
 * turned off for it. A registered check with no open finding is a pass; a check no scan runs yet
 * is null.
 */
export function deploymentGuards(
  ranked: readonly RankedFinding[],
  deployment: DeploymentRow,
  repoIds: readonly number[],
  overrides: OverrideIndex,
  registered: ReadonlySet<GuardCheck>,
): DeploymentGuard[] {
  const subject = { deploymentId: deployment.id }
  const overrideRef = (check: Parameters<OverrideIndex['covering']>[0]) => {
    const covering = overrides.covering(check, subject)
    return covering ? toCheckOverrideRef(covering) : null
  }
  const onThis = (r: RankedFinding) =>
    r.finding.deploymentId === deployment.id ||
    (r.finding.deploymentId === null &&
      r.finding.repoId !== null &&
      repoIds.includes(r.finding.repoId))

  const guards = GUARD_CHECKS.map((check): DeploymentGuard => {
    const mine = ranked.filter((r) => r.kind === 'guard' && r.guardCheck === check && onThis(r))
    const open = worstOpen(mine)
    if (open) {
      return {
        check,
        result: open.guardLevel,
        evidence: evidenceOf(open),
        findingId: open.finding.id,
        override: overrideRef(check),
      }
    }
    const resolved = mine.find((r) => r.state === 'fixed')
    return {
      check,
      result: resolved || registered.has(check) ? 'pass' : null,
      evidence: evidenceOf(resolved),
      findingId: null,
      override: overrideRef(check),
    }
  })

  const blindSpots = BLIND_SPOT_TYPES.flatMap((type): DeploymentGuard[] => {
    const open = ranked.find(
      (r) =>
        r.kind === 'blind_spot' &&
        r.finding.blindSpotType === type &&
        r.state !== 'fixed' &&
        r.deployments.some((d) => d.id === deployment.id),
    )
    const override = overrideRef(type)
    const always = type === 'archived_deployed'
    if (!open && !override && !always) return []
    const result = open ? 'fail' : always && repoIds.length > 0 ? 'pass' : null
    return [{ check: type, result, evidence: null, findingId: open?.finding.id ?? null, override }]
  })

  return [...guards, ...blindSpots]
}
