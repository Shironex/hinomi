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

A container check takes its `capabilities` from the deployment sources' declarations (`deploymentGuardCapabilities(check)`, see [sources.md](sources.md#what-each-source-can-tell)) instead of listing source kinds itself, so a new source shows up in `GET /api/guards` once it declares what it can answer. Register it by adding it to `GUARDS` in `scan/guards/registry.ts`. That is all: the scan runs it, the API lists it, the deployment panel shows it.

`GuardContext` holds what the scan already read: every deployment (`deployments`, with the facts its source reported), the repos scanned this run (`repos`), the deployment index (`index.byRepo`, manual mappings honoured), this scan's per repo results (`scans`, with the lockfiles OSV read and the runtime pins in `pins`), the endoflife.date lookups (`support`, null until a copy exists; a support check then returns nothing so its rows stay as they are) with the warning window (`supportWindowDays`) and the Rust and Bun "behind latest" thresholds (`behindReleases`), `repoFiles` and `now`. `repoFiles.read(repo, path, ref)` reads one file of a repo through the repo's own GitHub source (the one the scan used, else `repos.source_id`); a read at a full commit sha is kept in the `http_cache` table under `repo-file:{owner}/{name}@{sha}:{path}` (a missing file too), so an unchanged deploy costs no GitHub call, and a branch is read once per scan (`{ maxAgeMs }` keeps a branch or tag read in the cache for that long). `repoFiles.list(repo, dir, ref)` lists the files directly inside a folder and is never cached. A read can name another repo (`{ ...repo, owner, name }`): it goes through the scanned repo's source. It answers `ok`, `missing`, `no_source` (say `unknown`) or `error` (return `null`). A check that needs more adds a field to `GuardContext` and fills it where `runScan` builds the context.

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

## Registered checks

- `runtime_support`, `runtime_pins_disagree` and `action_runtime`: see [Runtime support](#runtime-support), [Runtime pins disagree](#runtime-pins-disagree) and [Action runtime](#action-runtime) below.
- `root_user` (`scan/guards/root-user.ts`): the first answer wins: the running user from Docker inspect (`Config.User`, empty means root; Docker host sources, `source: docker_inspect`), run options `--user`, compose `user:` per service (a service without it falls to its image: a `nonroot` tag passes, any other tag warns, a build is unknown), the inline Dockerfile, then the Dockerfile fetched from the repo at the deployed commit sha (else the branch). A final stage with no `USER` warns "probably root" unless the base image tag ends in `nonroot`. A build pack that gives no signal, an image only deployment, a missing file or an unresolved variable is `unknown` with the reason; a failed fetch leaves the row alone. Managed databases are skipped.
- `docker_socket` (`scan/guards/docker-socket.ts`): `fail` when a bind mount (Docker inspect `Mounts` and `HostConfig.Binds`, run options, compose, file or persistent storage) is the Docker socket or a folder holding it, read only too. `pass` records which sources were read and any gap (Coolify does not document the persistent storage `host_path`); `unknown` when no source was read.
- `shared_network` (`scan/guards/shared-network.ts`): resources of different projects on one network warn, `fail` when a peer is a database. Coolify resources group by the destination they are attached to and by external networks named in run options or compose (`basis: coolify_destination` or `external_network`); Docker host containers group by the networks inspect lists (`basis: docker_network`). Host networking warns with its own text (`host_network`).
- `watch_paths_skip` (`scan/guards/watch-paths-skip.ts`): applications whose watch paths skip their Dockerfile or lockfiles warn. A Docker host has no watch paths, so its applications say `unknown`.
- `archived_deployed`: see [Archived repo still deployed](#archived-repo-still-deployed) below.

Signal sources per check, by source kind, are in [sources.md](sources.md#what-each-source-can-tell); a Docker host answers `root_user`, `docker_socket` and `shared_network` in full from container inspect.

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
| `archived_deployed` | high | (none) |

Guards sit in the reach tiers next to advisories: `exposed` (public, counts as high or critical), `public_low`, `internal`, `not_deployed`. `unknown` ranks like a coverage note, in the `coverage` tier. The advisory funnel never counts guards.

## Turning a check off

`POST /api/overrides { check, deploymentId | repoId, reason }` turns a check off for one deployment or one repo, with a reason. The check keeps running; its finding is stored as `accepted` with the override's reason and a `turned_off` event (actor user), so it stays visible under the accepted filter and its level and evidence stay current. It never notifies and never reopens on escalation. Deleting the override reopens it.

- A deployment is covered by an override on itself, or on any repo it runs (`archived_deployed`: on every repo it runs, since each repo is judged on its own).
- A repo is covered by an override on itself, or when every deployment that runs it has the check off.
- Blind spot types can be turned off the same way (decision Q5). `archived_deployed` started as a blind spot and is a guard check now, with the same id, so its old overrides keep working.

## Notifications

- `fail` on a running deployment, opened or reopened: sent right away.
- An escalation to `fail`: sent right away, once.
- `warn`: the daily digest only.
- `unknown`, a better level, the same level again, a turned off check: never sent.

The item carries `kind: guard`, `guardCheck`, `guardLevel`, the check's title and its explanation for the level (see [notifications.md](notifications.md)).

## Framework support

`framework_support` (`scan/guards/framework-support.ts`) reads the lockfile dependencies the scan already stored and keeps the direct ones that ship with the app: dev dependencies and transitive packages are ignored (a scope the lockfile cannot tell, as in Cargo, still counts). Each package is turned into a purl (`pkg:npm/next`, `pkg:pypi/django`, `pkg:npm/@angular/core`) and joined to the endoflife.date products that publish it; there is no hand kept framework list. The release line is the longest line name that is a dotted prefix of the installed version (`6.1` for Django 6.1.3).

One finding per repo, with every match in `evidence.frameworks`; the level is the worst entry:

| Line state | Entry | Notes |
|---|---|---|
| end of support passed | `fail` | `warn` when the product has no security dates (see below) |
| ends within `supportWindowDays` (default 90) | `warn` | |
| supported, or only active support is over | `pass` | `isEoas` is shown, never raises a level |
| version matches no line | `unknown` | not in the support data yet |

Products whose end dates come from the release cycle (their end label is not a security support label, or they publish no such date) can warn but never fail, and the evidence `reason` says so. A repo whose lockfiles were not read, or a scan with no support data yet, leaves the finding as it is.

## Runtime support

`runtime_support` (`scan/guards/runtime-support.ts`) reads the runtime pins the scan stores per repo (`apps/server/src/pins/`). The scan reads them in the lockfile phase, at the same branch as the lockfiles (the deployed branch, else the default one), and treats the Dockerfiles the repo's deployments build (`facts.dockerfile`: base directory plus location) as production. A GitHub error keeps the pins stored for that branch and says so in `evidence.reason`; a repo whose pins were never read is left alone.

Per runtime, the pin that says what runs in production decides (precedence: the final stage of a deployed Dockerfile, then the version files, then the `engines` floor). CI pins, Dockerfile build stages and Cargo `rust-version` (a minimum, never the running toolchain) never decide it. One finding per repo; the level is the worst entry in `evidence.runtimes`.

| Runtime | Rule (`rule`) | `fail` | `warn` | `pass` |
|---|---|---|---|---|
| Node | `support_window`: end of security support from endoflife.date | the line ended | it ends within `supportWindowDays` (default 90) | supported, or only active support is over |
| Rust | `behind_latest` | never | the pin is more than `rustBehindReleases` (default 4) stable releases behind the latest | within that, or a channel (`stable`, `beta`, `nightly`, `rust:1`) |
| Bun | `behind_latest` | never | the pin is more than `bunBehindReleases` (default 4) minor releases behind the latest | within that, `latest`, or a major only pin (`bun@1`) |

The window and both allowances are set under Settings, Checks (or with `PATCH /api/settings`) and apply on the next scan.

A floating Node pin (`lts/*`, `node:lts`, `current`) passes and `resolvedTo` says which line it follows today. A pin Hinomi cannot read (`node:${NODE_VERSION}`, a digest) or a line the support data does not have yet is `unknown`. Rust and Bun use the "behind latest" rule because endoflife.date marks every Rust line but the newest as ended and publishes no end dates for Bun (Q12a); `releasesBehind` and `maxBehind` show the count.

While the entry is not passing, `fixHints` lists every file that pins the runtime to an older line, with the edit: `{ path, line, from, to }`, for example `apps/api/Dockerfile:1 node:18-alpine -> node:26-alpine`. CI steps and build stages are listed too; floating pins and minimums are not. The target is the newest Node LTS line that is not ending soon, or the latest Rust or Bun release, written with as many parts as the pin has.

No support data yet (a fresh install without network): the check returns nothing and its findings stay as they are.

## Runtime pins disagree

`runtime_pins_disagree` (`scan/guards/runtime-pins-disagree.ts`, warn only) fires when the pins of one runtime in a repo name more than one line. Node compares majors, Rust `major.minor`, Bun the `major.minor` of the version. Floating pins, unreadable pins and minimums never count. It needs no support data.

- Version files and Dockerfiles (deployed or not) must name the production line, or the line most of them name when nothing says what production runs.
- A Dockerfile build stage may differ when it is a pure build stage. A stage the final image is built on, or copies `node_modules` from (`COPY --from=deps /app/node_modules ...`), must match: native modules built on one line can break on another. A copy of a whole folder is not followed.
- CI may test several lines (a matrix, several jobs): it disagrees only when no CI pin uses the production line. A matrix `[22, 24]` with nothing else is fine.
- An `engines` range disagrees only when a pinned line does not fit it (`>=20 <23` with `.nvmrc` 24).

`evidence.runtimes[]` has the production line, every pin, the disagreeing ones, a one line `reason` ("Node pins disagree: production runs 26, CI tests on 22 only.") and `fixHints` that move each disagreeing pin to the production line.

## Action runtime

`action_runtime` (`scan/guards/action-runtime.ts`, `action-manifest.ts`) judges the Node line every GitHub Action runs on: the repo's own `action.yml` (or `action.yaml`) and each action its workflows use. It reads `.github/workflows/*.yml` at the ref the scan read the repo's pins at, lists every step `uses: owner/repo[/path]@ref` (local `./x` and `docker://` uses are skipped; so are refs that are expressions), then reads each action's `action.yml` through the repo's GitHub source.

- A sha ref is cached for good in `http_cache` (`repo-file:{owner}/{name}@{sha}:{path}`); a tag or branch ref for a day; a missing file is cached too. A failed read is not.
- `runs.using: node12`, `node16`, `node20`, `node24` give the Node line. `docker` and any other value give nothing. A composite action is followed one level: the actions its own steps use are judged and listed as `owner/inner@v1 (via owner/outer@v2)`; the ones those use are not read.
- Each Node line is judged like a Node pin (`windowStateOf`): the end of security support has passed `fail`, within `supportWindowDays` `warn`, otherwise `pass`; a line the support data does not have is `unknown`.
- One finding per repo, the worst entry; `evidence.actions` lists every action that declares a Node line, with the workflow file and line of its `uses:` (null for the repo's own action, `self`). An action with no `action.yml` (a private repo the source cannot read) is left out.
- A repo with no GitHub source to read it is `unknown`. A failed read (rate limit, network) leaves the row alone unless a worse level was already found, and the `reason` says so. No support data yet: the check returns nothing. At most 100 actions are read per repo and scan.

## Archived repo still deployed

`archived_deployed` (`scan/guards/archived-deployed.ts`) fails a deployment that runs code from a GitHub repo that is archived. It was a repo blind spot before; it is a guard check now so it can be judged per deployment, say `unknown` when GitHub cannot answer, and rank by the deployment's reach.

It reads the repo health the alerts phase already fetched (`archived` from `GET /repos/{owner}/{repo}`, through the repo's reader, see [github.md](github.md)), so it makes no GitHub call of its own and shares the alerts phase's rate limit handling. One finding per deployment; a deployment that runs several repos (a manual mapping) lists each in `evidence.repos` and takes the worst.

| What GitHub said about a repo | Entry |
|---|---|
| archived | `fail` |
| not archived (or unarchived since) | `pass` |
| renamed or moved: GitHub answers under another `owner/name` | judged like any other answer, `renamedTo` holds the new name (a change of letter case is not a rename) |
| every GitHub source asked answers 404 | `unknown`: deleted, moved to an account the token cannot read, or hosted elsewhere |
| a source refused the sign in or permission (`auth`, `permission`: the token or app lost access) | `unknown`, with that reason |
| GitHub is not connected | `unknown` |
| a passing error (rate limit, network, a server error) | nothing: the row is left alone, unless another repo of the deployment fails |

Renames are followed whether or not account repos are listed (`scan.includeAccountRepos`): a deployed repo that no source's list names is asked of every source directly (two calls per source and scan, `GET /repos/{owner}/{repo}` and its `/vulnerability-alerts`, only for such repos), so GitHub's redirect to the new name answers, and a deleted repo answers 404. A side effect with account repos listed: the list names the repo under its new name, so the old name (still mapped to the deployment) and the new name are two repo rows that read the same alerts, and an advisory can show up twice until the deployment's mapping names the new repo.

A repo override turns off that repo's entry only (`turnedOff: true`, not counted): a deployment that runs `harbor` (turned off) and `ledger` still fails when `ledger` is archived. The deployment is covered by repo overrides only when every repo it runs has one. An open `fail` that is not turned off makes the deployment not covered (`coverage.covered` false, `coverage.archivedRepo` true in `GET /api/deployments`).

A deployment that runs no mapped repo passes with a reason, so a finding left from an old mapping closes; `no_repo_mapping` and the `image_only` note cover the gap. Stopped deployments are checked too and rank low.

A snoozed or accepted row is reopened (event `escalated`) not only when the level gets worse but also when another repo of the deployment counts as archived at the same `fail` level: a snooze set for `harbor` does not hide that `ledger` is archived now. The event's reason names the new repos (`newly archived: kestrel-co/ledger`).

Upgrading: an open `archived_deployed` blind spot from an earlier version is never opened again. It hands over to the guard in two steps.

- Carry over, per deployment, in the scan its guard row opens: when every repo that makes the row `fail` or `unknown` (turned off ones left out) has an old row snoozed or accepted until a date, the guard row takes that state, with the earliest end and its reason (event `carried_over`, `fromFindingIds`), and its opening is not announced. When any such repo has no deferred old row (it was open, or there was none), the guard row stays open and is announced. A deployment that runs a snoozed `harbor` and an archived `ledger` is announced.
- Close: the old row resolves with `{ reason: 'moved_to_guard', check: 'archived_deployed' }` once the guard has an outcome (any level, or pass) for every deployment that runs the repo (the digest does not list it, and no fix is counted). Until then it stays open and the deployment panel shows it as `fail`, so a scan that could not read GitHub never turns it into a pass. A row whose repo nothing deploys any more resolves with `not_deployed` as before.

An override needs nothing: the id is the same. Known stuck case: when GitHub never gives an answer for some deployment of the repo (every scan ends in a passing error for it), the old row stays open for as long as that lasts; it is shown, not hidden, and closes on the first scan that decides every deployment.
