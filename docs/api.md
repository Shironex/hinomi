# JSON API

The SPA talks to the server through a small JSON API under `/api`. Every request and response is a zod schema in [`packages/shared/src/api.ts`](../packages/shared/src/api.ts): the server validates input against it and checks each response before sending it, and the SPA parses responses with the same schemas.

Hinomi has no login yet. Run it behind Tailscale or Cloudflare Access and never expose the port to the internet; the server logs a warning about this on every start, and `GET /api/access` tells the SPA whether the current request came through one (see [access.md](access.md)).

## Conventions

- Bodies are JSON (`content-type: application/json`), at most 64 KiB. Unknown body and query keys are rejected.
- Timestamps are ISO 8601 strings in UTC. Ids are positive integers (notification channels use UUIDs).
- List filters in query strings take comma separated values: `?tier=exposed,internal`.
- Tokens and webhook URLs are never returned or logged. Sources only report `hasToken`; channels show a masked URL.
- Every error has the same shape and an HTTP status:

```json
{ "error": { "code": "validation_failed", "message": "Invalid request body: reason: A reason is required" } }
```

| Code | Status | When |
|---|---|---|
| `validation_failed` | 400 | Input does not match the schema, or a rule (like a Coolify source without a URL) fails |
| `invalid_json` | 400 | The body is not JSON |
| `bad_request` | 400 | The action cannot run as asked (for example a stored token that cannot be decrypted) |
| `secret_key_missing` | 400 | A token was sent but `HINOMI_SECRET_KEY` is not set |
| `not_supported` | 400 | For example a connection test for OSV.dev |
| `not_found` | 404 | Unknown route or id |
| `conflict` | 409 | Duplicate source name, or a state change the finding does not allow |
| `unsupported_media_type` | 415 | A body that is not JSON |
| `payload_too_large` | 413 | Body over 64 KiB |
| `internal` | 500 | A server bug; details only in the server log |
| `unavailable` | 503 | The server is shutting down, so it starts no new scan |

## Endpoints

### Overview and shell

| Method and path | Returns |
|---|---|
| `GET /api/health` | `{ status: "ok" }` |
| `GET /api/access` | How this request reached Hinomi, one of the states below. Sent with `cache-control: no-store` |
| `GET /api/overview` | Advisory funnel (total, deployed, runtime, critical or high, public, exposed, needs action, dismissed upstream), distinct repos and apps behind each funnel step (`funnelReach`), blind spot counts, counts per tier and the same split by severity (`tierSeverity`), last scan, next scan time, health of every source (plus an `osv` row with a null id, from the OSV setting and the latest scan runs), the 20 latest finding events, `topFixes` (the 5 best fixes that have a patched version, see Fixes below) |
| `GET /api/shell/nav-counts` | Sidebar counts: `needsAction`, `deployments`, `alerts` (findings not fixed), `activeFixRuns` (null until fix runs exist) |
| `GET /api/shell/scan-status` | One of the states below |

Every access state has `address` (the client address it is based on, or null) and `forwarded` (true when a trusted proxy supplied that address). The schema is in [`packages/shared/src/access.ts`](../packages/shared/src/access.ts).

| Access state | Fields | When |
|---|---|---|
| `cloudflare_access` | `verified`, `unverifiedReason` (`not_configured`, `certs_unavailable` or null), `email` (from a verified token) | A `Cf-Access-Jwt-Assertion` token that verifies, or one that could not be checked. A token that fails the check is ignored |
| `tailscale` | `via` (`serve` or `address`), `login` (from `tailscale serve` or a trusted proxy, else null) | Tailscale identity headers from loopback or a trusted proxy, or a client in `100.64.0.0/10` or `fd7a:115c:a1e0::/48` |
| `public` | none beyond `address` | A public client address and nothing above |
| `unknown` | `reason` (`private_address`, `loopback` or `no_address`) | Hinomi cannot tell, for example behind a Docker bridge |

Scan status:

| State | Fields | When |
|---|---|---|
| `unconfigured` | none | No Coolify or GitHub source is connected |
| `queued` | `nextScanAt` (null when not planned) | Connected but never scanned: the first scan is about to start |
| `scanning` | `scanRunId`, `startedAt`, `phase`, `done`, `total`, `skipped` | A scan is running |
| `idle` | `lastScanAt`, `nextScanAt` | The latest scan finished |
| `failed` | `lastScanAt` (last good scan or null), `message` | The latest scan failed |

A scan moves through these phases in order. `done` and `total` count the units of the current phase; `skipped` lists the phases this scan leaves out.

| Phase | Does | Units |
|---|---|---|
| `deployments` | Reads every Coolify instance, and the account repo list when that setting is on. Skipped with neither | Coolify instances plus the repo list |
| `alerts` | Fetches GitHub repo health and Dependabot alerts per repo. Skipped without GitHub | Repos |
| `lockfiles` | Reads lockfiles and checks them against OSV.dev per repo. Skipped while OSV is off | Repos |
| `matching` | Joins advisories to deployments and saves the findings | Repos |
| `ranking` | Opens and resolves blind spots, builds the fix plan of every scanned repo and records the run | None (0 of 0) |

### Findings

`GET /api/findings` lists findings, most urgent first.

| Query | Meaning |
|---|---|
| `tier` | `blind_spot`, `exposed`, `internal`, `public_low`, `dev`, `not_deployed`, `coverage` |
| `state` | `open`, `fixing`, `fixed`, `snoozed`, `accepted`, `dismissed_upstream`. Without it every state except `fixed` |
| `severity` | Effective severity: `critical`, `high`, `moderate`, `low` (unscored advisories count as moderate) |
| `source` | `github`, `osv` |
| `sourceMatch` | `any` (default): reported by at least one listed source; `all`: by every listed source, so `source=github,osv&sourceMatch=all` means reported by both |
| `scope` | `runtime`, `dev`, `unknown` |
| `kind` | `advisory`, `blind_spot`, `coverage_note` |
| `repo`, `deployment` | Ids |
| `q` | Case-insensitive search over package, advisory ids, summary, repo, deployment and blind spot type |
| `group` | `none` (default), `tier`, `repo`, `advisory`: rows are ordered group by group and `groups` holds every group's size |
| `offset`, `limit` | Paging, `limit` 1 to 200 (default 50). `nextOffset` is null on the last page |

A coverage note (`kind: coverage_note`, `coverageNote: image_only`, tier `coverage`) is a deployment with no git source: a service from a template or an app deployed from a registry image. There is no repo to map, so it is not a blind spot; it ranks below every advisory, is never sent as a notification and stays until the phase 2 image scan covers it (a manual repo mapping clears it). A `no_repo_mapping` blind spot is only for a deployment built from git whose repo Hinomi cannot match; one that an earlier version opened on an image only deployment resolves on the next scan with `{ reason: "reclassified", as: "image_only" }` and a coverage note opens instead.

Each item has its rank, tier, the four factors (`severity`, `runtime`, `deployed`, `public`), `unscored`, `stopped`, state with reason and expiry (`stateUntilNewAdvisory` when it waits for a new advisory instead of a date), reporting sources, an advisory summary, the repo and the deployments it reaches.

| Method and path | Does |
|---|---|
| `GET /api/findings/:id` | Detail: full advisory with its description, versions (installed, first patched, vulnerable ranges), dependency scope, manifests and path, deployments, `sameFixClears`, history newest first, notifications sent |
| `POST /api/findings/:id/snooze` | `{ reason, until }` or `{ reason, untilNewAdvisory: true }`. A reason and exactly one expiry; `until` in the future. Returns the detail |
| `POST /api/findings/:id/accept` | Same body, accepts the risk until the date or the next advisory |
| `POST /api/findings/:id/reopen` | `{ reason? }`, cancels a snooze or acceptance |
| `POST /api/findings/bulk` | `{ action: "snooze" \| "accept", ids, reason, until \| untilNewAdvisory }` or `{ action: "reopen", ids, reason? }`, 1 to 200 ids. Each finding is changed on its own: `{ results: [{ id, ok: true, state } \| { id, ok: false, error: { code, message } }], ok, failed }` |

A transition the current state does not allow (snoozing a fixed finding, reopening an open one) answers 409; in a bulk call that finding gets the same code in its result.

**Until a new advisory.** `untilNewAdvisory` keeps the snooze or acceptance in force (`stateUntil` is null) until a scan opens a finding for a different advisory on the same repo and package. The finding then reopens with a `snooze_expired` or `acceptance_expired` event whose data says `reason: "new_advisory"`. Only advisory findings can use it.

**Dependency path.** `dependency.path` is the chain of package names from a direct dependency down to the vulnerable package, taken from the lockfiles Hinomi parses for OSV (pnpm, npm v2 and v3, yarn, bun, Cargo; not npm v1). Chains longer than 12 links keep the first ten, `...` and the package. `pathSource` says what is known: `lockfile` (the path), `manifest` (only `manifestPaths`) or `package` (neither).

**Notifications.** `notifications` lists the immediate messages (or first scan and large batch summaries) that announced the finding, one per channel (the latest announcement), with the channel name and kind (null when the channel was removed) and when it went out. Daily digests are not recorded per finding.

### Fixes

`GET /api/fixes` groups open advisory findings by the version bump that fixes them, so "upgrade `kestrel-http` to 2.1.0" shows once with everything it clears instead of as five rows.

| Query | Meaning |
|---|---|
| `repo`, `deployment` | Repo ids, app (deployment) ids. They narrow the findings before grouping, so a repo filter gives the targets that repo needs |
| `offset`, `limit` | Paging, `limit` 1 to 100 (default 25). `nextOffset` is null on the last page |

Returns `{ items, total, offset, limit, nextOffset }`. Each item is a fix:

| Field | Meaning |
|---|---|
| `key` | `ecosystem:package:target`, `none` instead of the target without a patch |
| `ecosystem`, `packageName`, `target` | The bump. `target` is null for the findings of the package that have no patched version yet |
| `mixedTargets` | Repos need different versions. `target` is then the highest, which clears every repo; each repo's own version is in `repos` |
| `findings` | `total`, `byTier` (every display tier) and `bySeverity` of what the bump clears |
| `findingIds` | The findings, most urgent first |
| `bestTier` | The most urgent tier among them |
| `exposedCritical` | At least one finding is critical, shipped at runtime and on an app reachable from the internet (tier `exposed`) |
| `repos` | `{ repo, target, findings, plan, planTarget }` per repo, most findings first. `target` is the highest first patched version among that repo's findings of the package; `plan` links the repo's latest fix plan (see Fix plans below), null before one exists; `planTarget` is the version that plan's steps for the package upgrade to, with its target check (`{ to, status, minimum, avoids, stillAffected }`, see below), null when the plan has no step for the package or did not check it |
| `apps` | Deployments the findings reach |

How findings are grouped:

- A fix is an ecosystem, a package and a target. The target is the highest first patched version among the grouped advisories, compared as semver (`1.10.0` is above `1.4.0`), so one upgrade clears all of them. Versions that are not semver compare as plain text.
- Only findings in the `open` state with a package version to bump are grouped. Snoozed, accepted, fixing, fixed and dismissed upstream findings, advisories already patched in the lockfile, blind spots and image only coverage notes are left out, and they never raise a target.
- Advisories with no patched version form a separate fix of the same package with a null target. It is listed like any other fix but is left out of `topFixes`, which only holds bumps you can make.
- Fixes are sorted by exposure: `exposedCritical` first, then the number of exposed findings, then the number of findings, then the top severity.
- Not deployed and dev only findings are included (`byTier` says so): a repo with no deployment still has a bump to make.

`GET /api/findings/:id` has `sameFixClears`: the number of open findings the same fix clears, itself included, across repos. It is 0 when the finding is not part of a fix (not open, patched in the lockfile, a blind spot or a coverage note). It also has `plan`: the link to the latest fix plan of the finding's repo, or null.

### Fix plans

Every scan builds one upgrade plan per scanned repo at the end of the ranking phase, so a whole repo can be fixed in one branch and one pull request instead of one bump at a time. Plans are stored per scan (the latest 20 per repo are kept), so a later plan can say how the previous one turned out.

| Method and path | Returns |
|---|---|
| `GET /api/repos/:id/plan` | The repo's latest plan. `?scan=<scan run id>` returns the plan that scan built. 404 when the repo is unknown or has no such plan |
| `GET /api/plans` | `{ items }`: the latest plan of every repo as `{ repo, repoId, scanRunId, createdAt, summary }`, most findings cleared first |

The plan is a versioned contract (`fixPlanSchema` in `packages/shared/src/api.ts`, `version: 1`); a runner that applies plans must refuse a version it does not know. Fields:

| Field | Meaning |
|---|---|
| `version`, `repo`, `scanRunId`, `createdAt` | Contract version, the repo, the scan that built it and when |
| `projects` | One per lockfile Hinomi read: `lockfile`, `root` (its folder, `.` at the repo root), `packageManager` (`npm`, `pnpm`, `yarn`, `bun`, `cargo`, `unknown`, from the lockfile name) and `workspaces` (repo relative folders of the manifests in it; for Cargo the workspace crate names, since Cargo.lock records no folders) |
| `steps` | What to change, in `order` |
| `unfixed` | Packages no step can fix yet |
| `summary` | `findings` (`total`, `cleared`, `clearedSafely`, `unfixed`, `clearedByTier`, `unfixedByTier`), `steps` (`safe`, `risky`), `unfixed` (entries) |
| `previous` | How the previous plan of the repo turned out by this scan: `{ scanRunId, findings, cleared, stillOpen }` over the findings its steps covered, null for the first plan |

How a plan is built:

- It covers the same findings as `GET /api/fixes` (open advisories with a version to bump), for this repo only. Each finding is placed in the lockfiles that hold its installed version, from the lockfiles OSV read in the same scan. Without that data (OSV off or failed) the finding's manifest path and dependency path decide.
- One step per package, project and relationship (direct or transitive). `to` clears all of its findings: at least the highest first patched version among them; `from` lists the installed versions.
- Target check (npm family and Cargo steps): `to` is the lowest version at or above that minimum, in the same semver line (a patch or minor away, never a new major), that no known advisory affects. Known means an advisory Hinomi stores for the package (from GitHub or OSV, for any repo) or one OSV reports for that exact version: each candidate that stored data does not already rule out is sent to OSV's `querybatch`, batched across every repo of the scan, asked once per version and paced by the scan's OSV client. Candidates are the minimum and the versions advisories name as fixes (first patched versions, the upper bounds of vulnerable ranges, OSV `fixed` events), up to 4 rounds of questions. The step's `targetCheck` records `status` (`clean`; `affected` when every known version in the line is affected, so `to` stays the minimum and `stillAffected` names the advisories, with a `note`; `unchecked` when OSV could not answer, with a `note`, or is off, where only stored advisories count), `minimum`, `avoids` (advisories a lower candidate has and `to` does not) and `stillAffected`. The PR body lists the same under Target versions.
- Limits of the target check: the server reads no package registry, so a clean release that no advisory names as a fix is not a candidate (the runner still checks the registry and the release age gate before it applies a step), and an advisory neither stored nor indexed by OSV is unknown. Other ecosystems and versions that are not semver are not checked and keep the minimum without a `targetCheck`.
- Order: safe bumps of direct dependencies first, then safe fixes of transitive ones, then risky steps; within each, the most urgent tier and the most findings first.
- `apply` says how to make the change without judgement: `manifest_bump` (set the version in each listed `package.json`, keeping the range prefix, then install; Cargo lists no manifests and names the crates in `workspaces`), `override` (set `key` to `value` under `field` of the project's root `package.json`: `pnpm.overrides` for pnpm, `overrides` for npm and bun, `resolutions` for yarn), `lockfile_update` (`cargo update -p <name>@<from> --precise <to>`) or `manual`. A transitive package is fixed with an override in npm family projects and with `cargo update` in Cargo projects; a direct one by bumping the manifests that list it (or `cargo update` when the Cargo bump is not major).
- A step is `risky` with `riskReasons` and a `note` for the PR body when: the bump is a semver major (`semver_major`: a change of the first non zero part, so 0.3 to 0.4 counts, read the changelog), the override would also move other installed versions of the package (`pins_other_versions`), the versions are not semver (`unknown_version`), Hinomi could not tell direct from transitive (`unknown_relationship`) or no lockfile it reads lists the package (`unknown_package_manager`, `apply` is `manual`).
- `unfixed` holds advisories with no patched version (`blocker: "no_patch"`). `too_new` (and `availableAt`) is reserved for the 7 day release age gate: OSV and GitHub do not say when a version was published, so every step has `releasedAt: null` and `releaseAge: "unknown"` until Hinomi reads release dates from the registries.
- A repo with nothing to fix still gets a plan with no steps, so the next scan can compare.

### Fix runner and fix runs

The fix runner applies a repo's latest plan. Where it runs is the repo's runner `kind`: `github_actions` (default) dispatches the caller workflow `.github/workflows/hinomi-fix.yml` in the repo's own Actions, which calls the reusable workflow `Shironex/hinomi/.github/workflows/fix.yml` pinned by commit SHA; `webhook` posts the plan to an external runner (see [Webhook runner](#webhook-runner) below and [runners.md](runners.md)); `local` applies it on the Hinomi host ([runners.md](runners.md#the-local-runner)). It is off for every repo until turned on. Setup and permissions are in [docs/github.md](github.md#fix-runner). Schemas: `packages/shared/src/runner-setup.ts`, `runner-webhook.ts` and `fix-runs.ts`.

| Method and path | Does |
|---|---|
| `GET /api/repos/:id/runner` | Settings plus a live status (see below). Reads GitHub, never writes |
| `PATCH /api/repos/:id/runner` | `{ enabled?, workflow?, majorsAgent?, kind? }`. `kind` is `github_actions`, `webhook` or `local`; `local` is a 409 while this host does not offer the local runner (`HINOMI_LOCAL_RUNNER=1`, git on the PATH, Linux or macOS), and `webhook` may be chosen before the webhook runner is set up (the status says what is missing). `majorsAgent` is `off` (default) or `claude-code` (the optional majors agent, [docs/github.md](github.md#the-optional-majors-agent)). `workflow` is a file name under `.github/workflows` ending in `.yml` or `.yaml`; `null` goes back to `hinomi-fix.yml`. Answers with the same status |
| `POST /api/repos/:id/runner/setup-pr` | Opens the PR that adds the caller workflow, or moves its pin to the latest release (see below). No body |
| `POST /api/repos/:id/fix-runs` | Dispatches the repo's latest plan. Body `{ confirmReopen? }`. 201 `{ run, encoding, omittedStepIds, majorsRun }`; `majorsRun` is the majors run dispatched beside `run`, else null (see below) |
| `GET /api/repos/:id/fix-runs` | `{ items }`, newest first. `?kind=fix\|majors`, `?limit=` 1 to 100 (default 50) |
| `GET /api/fix-runs/:id` | One run, plus `tracking`: `{ lastPolledAt, nextPollAt, lastError, pausedUntil }` from the tracker, null when it has not looked at the run since the server started or no longer follows it; `deployments`, `warnings`, `afterMerge` and `verification` (see below) |

The runner status:

| Field | Meaning |
|---|---|
| `settings` | `{ enabled, workflow, majorsAgent, kind }` |
| `ready` | GitHub Actions: on, the credential may dispatch, and the caller workflow calls Hinomi with every input. Webhook: on, the repo can be read and the webhook runner is set up |
| `github` | `{ fullName, defaultBranch, visibility, checksMode }` as GitHub reports the repo now, null when it could not be read. `checksMode` is `full` on public repos and `install` on private ones |
| `permissions` | `{ auth, ok, canOpenSetupPr, items, message }`. `auth` is `github_app`, `fine_grained_token` or `classic_token`. Each item is `{ name, label, purpose, required, status }` with `status` `granted`, `missing` or `unverified` (a fine grained token's write access cannot be read without writing, so a working read leaves it unverified) |
| `setupPr` | `{ available, reason }`: whether the setup PR button can work. `reason` always says why, also when it is available but unverified (a fine grained token's Workflows write cannot be read in advance, so Hinomi tries and explains a refusal) |
| `caller` | `{ state, path, ref, present, pinnedSha, latestSha, outdated, missingInputs, message, template }`. `present`: the file exists on the default branch. `pinnedSha`: the SHA it pins, null when unpinned or absent. `outdated`: pinned to a SHA other than `latestSha`. `state`: `missing`, `invalid` (not YAML), `not_hinomi`, `unpinned` (a tag or branch), `pinned` (a SHA, no release SHA known yet), `current`, `outdated`, `unknown` (could not be read). `template` is the caller workflow to paste; it hands `ANTHROPIC_API_KEY` to the reusable workflow when `majorsAgent` is on, and carries the same lines commented out otherwise. `passesAgentSecret`: the file passes that secret (`secrets: inherit` counts); absent when the file could not be read |
| `latestRun` | The newest fix run, or null |
| `closedUnmerged` | `{ runId, pr: { number, url }, closedAt }` when the last fix PR was closed without merging, else null |
| `message` | What to do next, or `Ready to dispatch.` (with a warning when the majors agent is on and the caller passes no secret), or `Ready to dispatch to the webhook runner.` |
| `runners` | `{ webhook: { configured, message }, local: { available, message, warning } }`: whether the webhook runner and the local runner can take a dispatch, for every repo. `local.warning` is the risk warning to show next to the kind |

The setup PR, `POST /api/repos/:id/runner/setup-pr` (`apps/server/src/runner/setup-pr.ts`):

1. Renders the caller for the repo's workflow file name, pinned to the latest release SHA (read from GitHub as for `caller.latestSha`), with the `secrets:` block when the majors agent is on (the PR body then says to add the repository secret).
2. Reads the file on the default branch. If it is already exactly that text, answers `already_set_up` and opens nothing.
3. Creates the branch `hinomi/setup-fix-runner` from the default branch head (or reuses it), puts the file on it, and opens a PR (`ci(hinomi): add the hinomi fix runner`, or `update the pin of the hinomi fix runner` when the file already exists). An open PR from an earlier call is reused and its text refreshed, so the call is safe to repeat.
4. Answers `{ outcome, pr, path, sha, version }`: 201 with `outcome: "created"`, or 200 with `updated` (existing PR, now current) or `already_set_up` (`pr` is null).

Refused: 404 unknown repo; 409 when no release SHA is known yet (an instance that cannot reach api.github.com and has none built in), or when the credential is known not to write workflow files (classic token without `workflow`, App without Workflows: write), or GitHub refused the write; 503 when GitHub could not be asked. The message says what to grant.

How a dispatch goes:

1. Refused without a run: 404 for an unknown repo or no plan, 409 when the runner is off, the repo's runner kind is not set up (no webhook runner URL or secret, the local runner not offered), no GitHub source is connected or the plan has no safe step the runner can apply, 503 when GitHub could not be asked about the repo.
2. When the last fix PR (or, with the majors agent on, the last majors PR) was closed unmerged and the body has no `confirmReopen: true`, the answer is 409 `{ error, previous: { runId, pr: { number, url }, closedAt } }`, so the UI can ask before a fresh PR is opened.
3. Hinomi reads the repo's spelling, default branch and visibility from GitHub, projects the plan into the dispatch (public: `checks: full`, no links back to Hinomi; private: `checks: install`, links allowed), and encodes it (`json` when it fits in 60,000 characters, else `gzip-base64`, else trimmed by priority; trimmed step ids come back in `omittedStepIds`).
4. The run is stored as `pending`, then Hinomi calls `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` with `{ ref: <default branch>, inputs: { run_id, plan, encoding }, return_run_details: true }`. `run_id` is the run's `correlationId`, also in the workflow's run name.
5. Accepted: the run moves to `dispatched` with `github.runId` from the response (null on a GitHub that answers 204 without details). Refused: the run moves to `failed` and `stateReason` says what to fix (404 no caller workflow on the default branch, 403 no Actions write, 422 inputs the caller does not declare). Either way the answer is 201 with the run. A dispatch is never retried after a 5xx or a network error, since GitHub may have acted on it.
6. Webhook kind: steps 3 and 4 are the same, then Hinomi posts the encoded plan to the webhook runner instead of calling GitHub (see [Webhook runner](#webhook-runner)). A 2xx answer is `dispatched` (with `github: null`), anything else `failed` with the reason. Majors runs are posted the same way with `kind: "majors"`.
   Local kind: steps 3 and 4 are the same, then the run is `dispatched` at once and the local runner applies it in the background ([runners.md](runners.md#the-local-runner)); its outcome moves the run as a webhook callback would. A second dispatch while a local run is in progress is a 409. Majors runs are never dispatched to the local runner.
7. Majors: with `majorsAgent` on and major upgrades in the plan (risky because of a semver major, with a lockfile), a second run of kind `majors` is dispatched the same way right after, with only those upgrades and the agent on; it comes back as `majorsRun`. A plan with no safe step but major upgrades gets the majors run alone, as `run` (and `majorsRun` null). A majors dispatch refused before a run was created is left out. The majors run has its own branch `hinomi/majors`, artifact `hinomi-majors-<correlationId>` and PR, always a draft, with the marker `<!-- hinomi:majors repo=<id> ... -->`. A majors run whose agent left no patch ends `failed` with the agent's reason. Its verification targets the major upgrades whose lockfile the agent changed.

How the fix PR is opened (mode A, Hinomi opens it with its own credential):

1. Once the run's result artifact was read, the tracker calls `publishFixPr(run, result, headSha)` (`apps/server/src/runner/publisher.ts`). The run records `branch_pushed` with `headSha`.
2. Hinomi lists the open PRs of the branch (`GET /repos/{owner}/{repo}/pulls?state=open&head=<owner>:hinomi/fix-plan&base=<default branch>`) and picks the one the run tracks, else the one with the hidden `<!-- hinomi:fix repo=<id> ... -->` marker, else the first.
3. An open PR gets the rendered title and body (`PATCH /pulls/{n}`, only when they differ) and the draft state (GraphQL `markPullRequestReadyForReview` or `convertPullRequestToDraft`, since REST cannot change it). Without one, Hinomi opens it (`POST /pulls`, `draft` when a check, the install or a step failed). The run records `pr_opened` and `pr_draft_changed`, so `pr` on the run carries `{ number, url, draft }`.
4. Labels: `dependencies` and `security` are added (`POST /issues/{n}/labels`) only when the repo has them (`GET /labels/{name}`). Hinomi never creates labels.
5. Links: the body links to `<public base URL>/fix-runs?sel=<run id>` only on private repos with a public base URL set (`PATCH /api/notifications/settings`). Public repos never show the instance's address.
6. A PR closed without merging is never reopened. When Hinomi had recorded that close before the run was dispatched (so the dispatch asked, see above), a fresh PR opens with "Replaces #n" in its body. Otherwise the run takes that PR on and ends `closed_unmerged`, and the next dispatch asks.
7. Publishing the same result again writes nothing. A 403, 404 or 422 from GitHub fails a run that has no PR yet, with `stateReason` saying what to fix (Pull requests: write missing, the branch was not pushed, no commits ahead of the default branch); a run that already has its PR keeps its state. A network error, rate limit or 5xx leaves the run as it is for another try; writes are never repeated. A refused label or draft change is a warning, not a failure.

How a fix run is tracked (`apps/server/src/runner/tracker.ts`, cadences in `tracking.ts`):

1. A timer ticks the tracker at least every 20 s. Each tick polls the runs that are due, oldest due first, at most 40 GitHub requests per tick and 600 per rolling hour. Below 500 requests left in GitHub's window (`x-ratelimit-remaining`), or on a rate limit answer (`retry-after`, `x-ratelimit-reset`), polling pauses until the window resets.
2. Cadence: dispatched, queued and running every 20 s for the first 5 minutes after the dispatch, then every minute; `pr_open` and `checks_pending` every 2 minutes; settled checks every 10 minutes, every hour after 3 days; runs that ended `failed`, `cancelled` or `closed_unmerged` every 30 minutes for 7 days, so a re-run of the workflow (a higher `run_attempt`) or a reopened PR brings the run back even without the [webhook](github-webhook.md), which only polls the runs it names sooner; merged runs every 2 minutes for the first hour, then every 15 minutes (see below).
3. Reads are conditional: the last ETag of the workflow run, the PR and the checks is stored on the run and sent as `If-None-Match`; a 304 changes nothing and does not count against GitHub's limit. An ETag is stored only once its answer was fully handled.
4. A run without a GitHub run id (a 204 dispatch, or a dispatch that failed in transit) is matched by its run name `hinomi fix <correlationId>` among the caller workflow's `workflow_dispatch` runs created since a minute before the dispatch (`GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs`), then linked. Without a match after 15 minutes it is `lost`.
5. Webhook and local runs are never polled on GitHub before their branch is pushed: they wait for the callback or the local process, and one without a result 2 hours after the dispatch is `lost`. From `branch_pushed` on they are tracked like any run.
6. The workflow run (`GET /actions/runs/{id}`): queued, waiting, requested or pending is `run_queued`, in progress is `run_started`. A run still going 40 minutes after it started, or still queued 6 hours after the dispatch, or deleted, is `lost`.
7. Once it completed, Hinomi reads the result before recording the end: the artifact `hinomi-fix-<correlationId>` (`GET /actions/runs/{id}/artifacts`, then `GET /actions/artifacts/{id}/zip`, which redirects to blob storage fetched without the credential), at most 4 MiB, unzipped in memory, `hinomi-result.json` validated against `fixResultV1Schema` and stored as `result`. A success without the artifact is asked again for 5 minutes, then `failed`; a malformed or foreign result is `failed` with the reason. `failure`, `timed_out` and anything else end `failed`, `cancelled` ends `cancelled` (the result is kept when there is one). A success with an empty patch is `nothing_to_do`; otherwise Hinomi reads the head of `hinomi/fix-plan` (`GET /branches/{branch}`), records `branch_pushed` and opens or updates the PR (see below). A transient publish failure is retried after 30 s, doubling up to 15 minutes, and the run fails after 10 tries.
8. The PR (`GET /pulls/{n}`): merged is `merged` with the merge commit, closed is `closed_unmerged`, a draft change is recorded. Checks come from the check runs and the combined status of the PR head (`GET /commits/{sha}/check-runs` and `/status`): any failure is `checks_failing`, anything unfinished `checks_pending`, else `checks_passing`, and nothing reported at all `checks_none` (pending for the first 10 minutes after the PR opened). The check results inside the result artifact are shown, never used for this.
9. Deployments (merged runs): the Coolify applications built from git that deploy the repo (its repo mapping, overrides included) are read live (`GET /api/v1/deployments/applications/{uuid}`, the 20 newest). An app on another branch than the repo's default branch is `other_branch` and not waited for. For the others, finished deploys (not rollbacks) that ended after the merge are compared with the merge commit, oldest first, at most 5 per app and poll: the merge commit itself is `identical` without a request, any other commit goes through `GET /repos/{owner}/{repo}/compare/{mergeSha}...{commit}?per_page=1` (answers cached in memory), and `identical` or `ahead` links the deploy. The first linked app records `deployment_seen` (`deployed`); the other apps get one more hour, then the rescan runs with what shipped. A Coolify read that fails is kept as the app's `error` and tried again. With no deploy of the merge after 3 days the run gets a `deploy_not_seen` warning, stays `merged` and is no longer polled (an app without automatic deploys needs a deploy by hand).
10. Watch paths: when an app has Coolify watch paths and none of the files the fix changed (`result.patch.files`) would trigger it (patterns in order, `**` crosses folders, `*` and `?` do not, `!` negates, the last match wins, as Coolify reads them), the run gets a `watch_paths_skip` warning for that app: the deploy may not happen automatically.
11. Verification: once deployed (or right after the merge when no app deploys the repo, or at once for `nothing_to_do`), Hinomi rescans the repo alone (GitHub alerts and lockfiles of that repo, written to its findings like a full scan; no scan run is recorded, no plan built, blind spots wait for the next full scan). The rescan never runs beside a full scan: while one runs, the tracker asks again after 2 minutes. The plan's targeted findings are those of the safe steps the runner applied or found already fixed (every safe step without a result). Fixed or gone is cleared; open, snoozed, accepted and dismissed upstream are still open; findings of the repo the rescan opened or reopened are `new`. All cleared is `verified`, else `not_cleared` with `stateReason` `<n> findings still open`. A rescan that errors on a source or cannot read a lockfile does not count: it is tried again after 5, 10, 20 and 40 minutes, then the verification waits for the next full scan. Any full scan that started after the run became ready, and read the repo without errors, verifies a waiting run the same way.

The run detail adds:

| Field | Meaning |
|---|---|
| `deployments` | One entry per app after the merge: `{ deploymentId, name, branch, status, deploy, checkedAt, error }`. `status` is `waiting`, `deployed` or `other_branch`; `deploy` is `{ id, commit, relation, finishedAt }` with `relation` `identical` or `ahead`. Empty before the merge or when no app deploys the repo |
| `afterMerge` | What follows the merge, from the repo's deployment mappings with the tracker's own rule (git apps on the default branch, or the links once recorded): `{ expects: "deploy", apps }` or `{ expects: "rescan_after_merge" }` when no app deploys the default branch. Present on every run |
| `warnings` | `{ code, deploymentId, message, at }` with `code` `watch_paths_skip` or `deploy_not_seen` |
| `verification` | Null until the run waits for a rescan, then `{ after, status, scan, targeted, cleared, stillOpen, new, attempts, lastError, nextAttemptAt }`. `after` is `deploy`, `merge` (no app deploys the repo) or `empty_diff`; `status` is `pending`, `retrying`, `scheduled_scan` or `done`; `scan` is `{ kind: "repo" \| "full", scanRunId, at }`; the id lists are finding ids |

### Deployments and repo mapping

| Method and path | Does |
|---|---|
| `GET /api/deployments` | Every deployment joined with its source, repos, mapping (`auto`, `override`, `none`), coverage (alerts state, open blind spots, covered, `imageOnly`), open advisory findings by severity, `exposed` (exposed advisories on it) and `openBlindSpots` |
| `GET /api/deployments/:id` | The same plus watch paths, manual overrides and the open findings that reach it |
| `GET /api/deployments/:id/deploys?limit=` | Recent deploys read live from Coolify (`limit` 1 to 50, default 10): `{ available, reason, items: [{ id, status, commit, commitMessage, startedAt, finishedAt, webhook, rollback }] }`. Applications only; for services, databases or a source that cannot answer, `available` is false and `reason` says why |
| `GET /api/deployments/:id/overrides` | Manual repo mappings |
| `POST /api/deployments/:id/overrides` | `{ repo: "owner/name", note? }`. Overrides replace the automatic repo; blind spots follow on the next scan |
| `DELETE /api/deployments/:id/overrides/:repoId` | Removes one |
| `GET /api/repos` | Every known repo |
| `GET /api/repos/:id` | The repo with `source: { current, mode, overrideId, seenBy }`: the GitHub source that reads and fixes it (`{ id, name, auth, enabled }`, null when none can), how it was chosen (`override`: picked by hand, `auto`: the scan's rule, `fallback`: not placed yet and only one GitHub source is connected, `none`), the source picked by hand (also while switched off) and every GitHub source that saw it on the last scan (`alertsReadable`, `lastSeenAt`), lowest id first. See [design/github-sources.md](design/github-sources.md) |
| `PATCH /api/repos/:id` | `{ sourceId }` picks the repo's GitHub source by hand (404 when it is not a GitHub source, 409 when it is switched off or has no credential); `{ sourceId: null }` goes back to the scan's choice. Answers like `GET` |

### Sources

| Method and path | Does |
|---|---|
| `GET /api/sources` | `{ sources, canStoreTokens }`. Each source has `auth` (`token` or `github_app`), `appId` and `installationId` (null for tokens), `hasToken` (the token or the app's private key is stored), `repoCount` (GitHub: the repos it reads, a source picked by hand included) and `deploymentCount` (Coolify: the deployments it reports) |
| `GET /api/sources/:id` | One source |
| `POST /api/sources` | `{ kind, name, baseUrl?, token?, enabled? }`. Coolify needs a URL and a token, GitHub a token (URL only for Enterprise), OSV neither. A GitHub App instead sends `auth: "github_app"`, `appId`, `installationId` and `privateKey` (PEM) |
| `PATCH /api/sources/:id` | Any of `name`, `baseUrl`, `token` (replaces the stored one), `enabled`; for a GitHub App `appId`, `installationId`, `privateKey`. Changing `auth` also needs the new token or private key |
| `DELETE /api/sources/:id` | Removes it and its deployments. The repos a GitHub source read move to another GitHub source that saw them, or are left with no reader; findings and fix runs stay. Switching a source off (`enabled: false`) moves its repos the same way |
| `POST /api/sources/test` | `{ kind, baseUrl?, token }` or `{ kind: "github", auth: "github_app", baseUrl?, appId, installationId, privateKey }`: tests credentials before saving them |
| `POST /api/sources/:id/test` | Tests a saved source with its stored token or private key |

A test answers `{ ok: true, message, version?, login?, scopes?, account?, repositorySelection?, repoCount?, missingPermissions? }` or `{ ok: false, code, message }`. A GitHub App test fails with code `permission` when a required permission is missing. See [github.md](github.md) for setting up the app.

### Settings and scans

| Method and path | Does |
|---|---|
| `GET /api/settings` | `{ scanIntervalMinutes, osvEnabled, includeAccountRepos }` |
| `PATCH /api/settings` | Any of them. The interval is 15 minutes to 7 days (default 360) and replans the next scan |
| `GET /api/scans?limit=` | Scan runs, newest first |
| `GET /api/scans/:id` | One run with per source results |
| `POST /api/scans` | Starts a scan: 202 `{ started: true, run }`, or 200 `{ started: false, run }` with the scan already running |

### GitHub webhook

Optional, off by default; see [github-webhook.md](github-webhook.md) for the setup and how to expose only the receiver.

| Method and path | Does |
|---|---|
| `GET /api/settings/github-webhook` | `{ enabled, secretSet, secretCreatedAt, canStoreSecret, includePush, path, dedicatedPort, events, lastDeliveryAt, lastDeliveryEvent, lastErrorAt, lastError }`. `events` lists the events to tick in GitHub for the current settings; `dedicatedPort` is `HINOMI_WEBHOOK_PORT` or null; `lastError` covers rejected requests and failed deliveries since the server started. The secret is never returned |
| `PATCH /api/settings/github-webhook` | Any of `enabled`, `includePush`. Turning it on before a secret exists is a 409 |
| `POST /api/settings/github-webhook/secret` | Makes a new random secret and replaces the old one: 201 `{ secret, settings }`. The only time the secret is shown. Without `HINOMI_SECRET_KEY` it is a 400 `secret_key_missing` |
| `POST /api/github/webhook` | The receiver GitHub posts to (also the only route on `HINOMI_WEBHOOK_PORT`). Not under the 64 KiB API body limit: it reads at most 1 MiB of raw body itself. 404 while off, 401 with an empty body for a missing or wrong `X-Hub-Signature-256`, 413 over the cap, 400 without `X-GitHub-Event` or `X-GitHub-Delivery`, 415 unless JSON, 200 `{ status: "duplicate" }` for a delivery id seen in the last 24 hours, else 202 `{ status: "accepted" \| "ignored" }` |

A delivery only makes the fix runs it names due for a poll at once (by workflow run id, run name, PR number, head commit or branch); the poll, inside the usual request budget and rate limit pauses, is what moves them.

### Webhook runner

Optional: repos with the runner kind `webhook` post their plans to an external runner, which applies them, pushes the fix branch and reports back. The setup, the payloads and the signature are in [runners.md](runners.md).

| Method and path | Does |
|---|---|
| `GET /api/settings/webhook-runner` | `{ configured, url, allowPrivate, callbackUrl, secretSet, secretCreatedAt, canStoreSecret, callbackPath, dedicatedPort, lastCallbackAt, lastErrorAt, lastError, message }`. `configured`: a URL that passes the address rules and a readable secret. The secret is never returned |
| `PATCH /api/settings/webhook-runner` | Any of `url`, `allowPrivate`, `callbackUrl` (`null` clears a URL). The URL must be https with no user or password, and a literal address must be public, unless `allowPrivate` is on (then plain http and private addresses pass): 422 otherwise, also when turning `allowPrivate` off with a private URL stored |
| `POST /api/settings/webhook-runner/secret` | Makes a new random secret and replaces the old one: 201 `{ secret, settings }`. The only time the secret is shown. Without `HINOMI_SECRET_KEY` it is a 400 `secret_key_missing` |
| `POST /api/runner/callback` | Where the external runner reports back (also served on `HINOMI_WEBHOOK_PORT`). Not under the 64 KiB API body limit: it reads at most 1 MiB itself. 404 while no secret can be read, 401 with an empty body for a missing, wrong or stale (more than 5 minutes off) `X-Hinomi-Signature`, 413 over the cap, 400 without `X-Hinomi-Delivery` or for invalid JSON, 415 unless JSON, 422 for a malformed body or result, 200 `{ status: "duplicate" }` for a delivery id seen in the last 24 hours, 404 for a run id no webhook run has, 409 when the run cannot take the report (it ended, or the branch head differs), 503 when GitHub could not be asked about the branch, else 200 `{ status: "applied" \| "unchanged", state }` |

### Onboarding

| Method and path | Does |
|---|---|
| `GET /api/onboarding` | `{ finished, alertsSkipped }` |
| `PATCH /api/onboarding` | Any of them. The SPA sets `alertsSkipped` when the alerts step is skipped and `finished` when the first scan ends without failing |

Both live on the server, so every tab and browser sees the same setup progress. `/` sends people to `/onboarding` while nothing is connected or `finished` is false. When `finished` was never set, it counts as true once any scan has succeeded or partly succeeded, so an install from before this setting does not go back to setup.

### Notifications

| Method and path | Does |
|---|---|
| `GET /api/notifications/channels` | Channels with masked URLs. An email channel has `url: "host:port"` and `email: { host, port, security, user, from, to, passwordSet }`; the password is never returned |
| `POST /api/notifications/channels` | `{ kind: "discord" \| "webhook", name, url, enabled?, minSeverity? }`, or `{ kind: "email", name, email: { host, port, security: "tls" \| "starttls" \| "none", user?, password?, from, to: string[] }, enabled?, minSeverity? }` |
| `PATCH /api/notifications/channels/:id` | Any of `name`, `url` (discord and webhook), `email` (a partial of the SMTP settings; an omitted `password` stays, an empty one removes it), `enabled`, `minSeverity` |
| `DELETE /api/notifications/channels/:id` | Removes it |
| `POST /api/notifications/channels/:id/test` | Sends a test message: `{ ok, error? }` |
| `GET /api/notifications/settings` | `{ publicBaseUrl, digestHour, fixRunEvents }`; `fixRunEvents` is `{ prOpened, checksFailing, verified, notCleared, failed, warnings }`, all booleans, all `true` until switched off |
| `PATCH /api/notifications/settings` | `publicBaseUrl` (empty clears it), `digestHour` (0 to 23, server local time) and `fixRunEvents` (any of the six switches; the ones left out keep their value, an unknown name or an empty object is a 400) |

See [notifications.md](notifications.md) for what is sent and when.

## Scheduler

One scan at a time, in the server process. Scans run every `scanIntervalMinutes` after the previous one started, right away on boot when one is overdue, and right away once GitHub is connected (or, with only Coolify, once setup is finished). Scheduled scans are skipped while nothing is connected, and while only Coolify is connected and setup is not finished: such a scan would report every repo as having no lockfile. A manual scan always runs. A scan run left `running` by a crash is marked failed on boot. On SIGTERM or SIGINT the server starts no new scan (`POST /api/scans` answers 503), waits up to `HINOMI_SHUTDOWN_TIMEOUT_SECONDS` (25 by default) for the running one, then closes storage; a scan still running after that is marked interrupted first. A second signal exits at once. After each scan the notifier gets the summary; a failing listener is logged and never stops the scheduler.
