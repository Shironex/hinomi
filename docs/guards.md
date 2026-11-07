# Guards

A guard is a configuration or support check on a deployment or a repo: a root container, a mounted Docker socket, a runtime line near end of life. Each check writes at most one finding of kind `guard` per subject, with a level (`warn`, `fail`, or `unknown` when the source cannot give the signal). Guard findings live next to advisories and blind spots: same table, same states (snooze, accept, reopen), same history, same rank formula. The design is in [design/phase-2.md](design/phase-2.md) sections 2 to 5; the API is in [api.md](api.md) under "Guards and check overrides".

## Writing a check

A check is one file under `apps/server/src/scan/guards/` that exports a `Guard` (`scan/guards/types.ts`):

```ts
export interface Guard {
  check: GuardCheck // one of GUARD_CHECKS in packages/shared/src/guards.ts
  capabilities: Partial<Record<SourceKind, GuardCapability>> // 'full' | 'partial' | 'unknown'
  run(ctx: GuardContext): readonly GuardSubjectResult[] | Promise<readonly GuardSubjectResult[]>
}

export type GuardSubjectResult =
  | { subject: GuardSubject; level: null }
  | { subject: GuardSubject; level: 'pass'; evidence?: GuardEvidenceInput }
  | { subject: GuardSubject; level: GuardLevel; evidence: GuardEvidenceInput }

type GuardSubject = { deploymentId: number } | { repoId: number }
```

Register it by adding it to `GUARDS` in `scan/guards/registry.ts`. That is all: the scan runs it, the API lists it, the deployment panel shows it.

`GuardContext` holds what the scan already read: every deployment (`deployments`, with the facts its source reported), the repos scanned this run (`repos`), the deployment index (`index.byRepo`, manual mappings honoured), this scan's per repo results (`scans`, with the lockfiles OSV read) and `now`. A check that needs more (the support data index, runtime pins) adds a field to `GuardContext` and fills it where `runScan` builds the context.

Rules for `run`:

- Return a result for every subject you evaluated. Subjects you leave out are left alone.
- `pass` resolves an open finding (event `resolved`). Evidence on a pass is kept on the row, so the panel can say what the pass is based on.
- `warn` and `fail` need evidence of your check's shape (`guard-evidence.ts`); evidence for another check, or that fails its schema, drops the result with a warning.
- `unknown` is for a source that cannot give the signal. Never return `pass` for that: a manual list or an image only deployment must not look safe. Say why in `evidence.reason`.
- `null` means "could not run on this subject now" (a fetch failed, a rate limit): the row is left alone.
- Throwing is allowed: the scan logs it and leaves every finding of that check alone.
- A subject must be in the context (a deployment in `deployments`, a repo in `repos`); others are dropped with a warning.
- Two results for one subject: the worse level wins (`fail` over `warn` over `unknown` over `pass`).

Stopped deployments: run the check anyway (a stopped root container is still configured as root). The finding ranks low because nothing runs.

Tests: one test file per check, a pure function of fictional rows. `scan/guards/testing.ts` has `fakeGuard(check)` (a check whose results a test sets between scans) and `rootUserEvidence()`; `runScan(..., { guards: [myGuard] })` and `createTestApi({ guards: [myGuard] })` take a list instead of the registry.

## What the framework does

After the blind spots, in the ranking phase, `runGuards` runs every registered check, validates and deduplicates the results, then `applyGuards` writes them in one transaction. The dedupe key is `guard:{check}:deployment:{id}` or `guard:{check}:repo:{id}`: one row per check and subject, whose level and evidence update in place.

| Result on a subject | Effect | Event |
|---|---|---|
| new `warn`, `fail` or `unknown` | opens the finding | `opened` |
| same level | evidence and last seen updated | none |
| worse level (`unknown` < `warn` < `fail`) | level updated; a snoozed or accepted row reopens | `escalated`, reason `warn -> fail` |
| better level | level updated, state kept | `level_changed`, reason `fail -> warn` |
| a level on a fixed row | reopens | `reopened` |
| `pass` | resolves | `resolved` |
| `null`, left out, or the check threw | nothing | none |

## Rank and tier

`rank = reach * 10 + running * 5 + severity`, with no CVSS part. Reach is public 2, internal 1, nothing running 0; a repo subject takes the widest reach of the deployments that run it. Severity per check and level:

| Check | `fail` | `warn` |
|---|---|---|
| `docker_socket` | critical | (none) |
| `root_user` | high | moderate |
| `shared_network` | high | moderate |
| `runtime_support`, `framework_support` | high | moderate |
| `watch_paths_skip` | (none) | moderate |
| `runtime_pins_disagree` | (none) | low |
| `action_runtime` | moderate | low |

Guards sit in the reach tiers next to advisories: `exposed` (public, counts as high or critical), `public_low`, `internal`, `not_deployed`. `unknown` ranks like a coverage note, in the `coverage` tier. The advisory funnel never counts guards.

## Turning a check off

`POST /api/overrides { check, deploymentId | repoId, reason }` turns a check off for one deployment or one repo, with a reason. The check keeps running; its finding is stored as `accepted` with the override's reason and a `turned_off` event (actor user), so it stays visible under the accepted filter and its level and evidence stay current. It never notifies and never reopens on escalation. Deleting the override reopens it.

- A deployment is covered by an override on itself, or on any repo it runs.
- A repo is covered by an override on itself, or when every deployment that runs it has the check off.
- Blind spot types can be turned off the same way (`archived_deployed`, decision Q5).

## Notifications

- `fail` on a running deployment, opened or reopened: sent right away.
- An escalation to `fail`: sent right away, once.
- `warn`: the daily digest only.
- `unknown`, a better level, the same level again, a turned off check: never sent.

The item carries `kind: guard`, `guardCheck`, `guardLevel`, the check's title and its explanation for the level (see [notifications.md](notifications.md)).
