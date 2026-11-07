# GitHub Actions fix runner: design

Status: accepted, being built. Covers #62 (this runner) and #63 (tracking fix runs), on top of the fix plans of #61; #64 (fix runs view) and #65 (webhook and local runners) build on it. The decisions taken are in section 14 and the answers found while building #61 in section 15; where they differ from the options in section 11, sections 14 and 15 win. The dispatch and result contract lives in `packages/shared/src/runner.ts`, `runner-payload.ts` and `runner-pr.ts`.

## 0. Summary

- **Delivery:** a reusable workflow `Shironex/hinomi/.github/workflows/fix.yml` that calls a bundled JavaScript action in the same repo (`Shironex/hinomi/actions/fix-runner`). Each target repo gets one tiny caller workflow `.github/workflows/hinomi-fix.yml` with `workflow_dispatch` inputs, pinned to the reusable workflow by commit SHA.
- **Dispatch:** `POST /repos/{owner}/{repo}/actions/workflows/hinomi-fix.yml/dispatches` with `return_run_details: true`. The plan travels as one JSON string input (gzip plus base64 when large). GitHub now answers `200` with `workflow_run_id`, so #63 knows the run id at once.
- **Two jobs, split by trust:** `apply` (read only token, no secrets) edits manifests, installs, runs checks and uploads a patch plus `hinomi-result.json`. `publish` (contents: write only) verifies the patch touches only allowed dependency files and force pushes branch `hinomi/fix-plan`. Dependency install scripts and the repo's tests never see a write token.
- **PR:** decided mode A: **Hinomi opens or updates the PR itself** from the pushed branch with its own credential. A PR opened that way triggers the repo's CI normally, it needs no secret in the target repo and no repo setting change, and Hinomi gets the PR number directly. Fallback mode: the workflow opens the PR with `GITHUB_TOKEN`, and GitHub then creates the CI runs in an approval required state (one click by a human).
- **Never merges.** One PR per repo, a draft when checks fail, idempotent by branch name and a hidden marker in the body.
- **Off by default**, enabled per repo. The connection test grows a separate "runner permissions" check, so read only users are not affected.

## 1. Delivery: reusable workflow vs composite action vs action repo

| Option | Caller size | Can set job permissions, concurrency, multiple jobs | Testable logic | Notes |
|---|---|---|---|---|
| Reusable workflow (`on: workflow_call`) | about 20 lines | yes, it owns whole jobs, so it can split `apply` (read) and `publish` (write) | only if the logic sits in an action it calls | Callers in private or public repos can call a workflow in a **public** repo; billing goes to the caller |
| Composite action | about 60 lines in every repo (checkout, setup node, pnpm, the action, push, PR) | no, it runs inside the caller's job, so one token for everything | shell steps, hard to test | Every repo copies the job layout, so a security fix means touching every repo |
| JavaScript action in its own repo (`Shironex/hinomi-fix-action`) | same as composite | no | yes (TypeScript, unit tests) | Separate release train from Hinomi, schema drift risk |

**Recommendation: reusable workflow plus a JavaScript action in the Hinomi monorepo.**

- The reusable workflow owns orchestration: two jobs with different permissions, concurrency, timeouts, toolchain setup, artifacts.
- The action (`actions/fix-runner/`, TypeScript bundled to `dist/index.js`, `runs.using: node24`) owns logic: plan validation with the **same zod schema** from `packages/shared`, manifest edits, release age checks, check detection, result file. GitHub's own guidance prefers an action over inline scripts for untrusted input ([script injections](https://docs.github.com/en/actions/reference/security/secure-use#writing-workflows)).
- Living in the monorepo keeps the schema, the server and the runner on one version and one release tag.

Facts that shape this ([reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#reusable-workflows)):

- A public repo's reusable workflow is callable from private and public callers. Hinomi is public, so that works.
- Hosted runner billing is always the caller's, so public target repos stay free and private ones use their own minutes.
- The `github` context is the caller's; the called workflow gets `GITHUB_TOKEN`, and its permissions can only be **downgraded**, never raised, from what the calling job grants.
- If the calling job sets no `permissions`, the called workflow gets the repo's default token permissions, so the caller must set them explicitly.
- Concurrency gotcha: never use the same `concurrency.group` in caller and called workflow with `cancel-in-progress`, because `github.workflow` is the caller's name in both.
- No redirects: renaming the Hinomi repo breaks every caller.
- Re-running a failed job reuses the reusable workflow from the first attempt's commit, so pinning by SHA is consistent anyway.

**Pinning the action from the reusable workflow.** `fix.yml` takes the action with `uses: $/actions/fix-runner`, GitHub's self repository reference, which resolves to the repo and commit of the workflow file it appears in, even when a workflow in another repo calls it. Callers pin `fix.yml@<sha> # v0.2.0` and that one pin fixes the action too; no release commit has to rewrite an action SHA. Hinomi learns the SHA to suggest at run time (section 16). Turn on immutable releases on the Hinomi repo, so the tag cannot move under people who pin by tag.

### What the user adds once per repo

One file, `.github/workflows/hinomi-fix.yml` (sketch in section 9), and nothing else in the recommended mode: no secrets and no settings. It must be on the default branch, because `workflow_dispatch` only triggers workflows that exist there ([events: workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)).

### Hinomi opening the setup PR itself

Optional, behind a button "Add the runner to this repo":

1. `GET /repos/{o}/{r}/contents/.github/workflows/hinomi-fix.yml` to see whether it exists and whether the pin is current.
2. Create branch `hinomi/setup-fix-runner` from the default branch (`POST /git/refs`), `PUT /contents/.github/workflows/hinomi-fix.yml`, then open a PR "ci(hinomi): add the hinomi fix runner".
3. Writing a file under `.github/workflows` needs the **Workflows** permission (write) for an App or fine grained token ([permissions for Workflows](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28#repository-permissions-for-workflows)), or the `workflow` scope on a classic token. That is a powerful permission (it can change any workflow), so the default is a copy paste panel with the YAML and the pinned SHA. The button shows only when the probe sees Workflows write, and the docs suggest granting it temporarily.

## 2. Dispatch transport

| Transport | Limits | Branch | Permission | Run id back |
|---|---|---|---|---|
| `workflow_dispatch` | at most 25 top level inputs, at most 65,535 characters for the whole `inputs` payload ([events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch), [REST](https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event)) | any `ref`, but the workflow file must exist on the default branch | FG/App **Actions: write**; classic `repo` | yes: `return_run_details: true` returns `200 {workflow_run_id, run_url, html_url}` (API 2022-11-28; on 2026-03-10 the 200 with details is the only response) |
| `repository_dispatch` | `client_payload` at most 10 top level properties, under 64 KB in total; `event_type` at most 100 characters ([REST](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#create-a-repository-dispatch-event--parameters)) | default branch only | FG/App **Contents: write** (much broader) | no |
| Workflow fetches the plan from Hinomi | none | n/a | n/a | n/a, **not possible**: Hinomi is self hosted and usually sits on a private network with no public ingress |

**Pick `workflow_dispatch`.** It returns the run id, needs the narrow Actions write permission instead of Contents write, has typed inputs and a "Run workflow" button for manual reruns, and has the same size budget.

**Size budget.** One input `plan` carries the JSON. The plan is lean on purpose (steps and ids, no advisory text; Hinomi renders the PR body itself, see section 5). A typical repo plan with 30 steps is around 6 to 10 KB. The server encodes it with `encoding: json` when the serialized inputs stay under 60,000 characters (headroom for the other inputs), else gzip plus base64 (`encoding: gzip-base64`, typically a 4x to 6x reduction). If it is still too large, the plan is split by priority: the highest tier steps go in, the rest are marked `deferred: payload size` in the run, never silently dropped.

Note: the Hinomi client pins `X-GitHub-Api-Version: 2022-11-28`, which supports `return_run_details`. No version bump is needed.

## 3. Auth and permissions

### 3.1 The GITHUB_TOKEN limitation and the options

Current behaviour ([GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs)):

- Events caused by `GITHUB_TOKEN` do not start workflow runs, so a push from the fix job does not run `on: push` CI.
- Exception (newer behaviour): when a workflow **creates or updates a pull request** with `GITHUB_TOKEN`, the `pull_request` `opened`/`synchronize`/`reopened` runs are created in an **approval required** state. A user with write access clicks "Approve workflows to run" in the merge box. Other activity types (`labeled`, `edited`) start nothing.
- For a workflow to create PRs at all, the repo setting "Allow GitHub Actions to create and approve pull requests" must be on. It is **off by default** for new personal repos and inherited from org settings for org repos ([repo Actions settings](https://github.com/github/docs/blob/main/content/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository.md)).
- GitHub's own note: to run CI without approval, create the PR with a GitHub App installation token or a PAT.

Options:

| | A. Hinomi opens the PR (recommended) | B. Workflow opens the PR with GITHUB_TOKEN | C. App or PAT secret in the target repo | D. Workflow dispatches CI itself |
|---|---|---|---|---|
| CI on the fix PR | runs normally (PR opened by a PAT user or App) | runs after one "Approve workflows to run" click | runs normally | only if CI has `workflow_dispatch`; checks land on the commit, so required check names may not match |
| Secrets in target repo | none | none | private key or PAT in every repo, readable by anyone with write | none |
| Repo setting change | none | "Allow GitHub Actions to create PRs" on | none | setting on |
| Extra Hinomi permission | Pull requests: write | none | none | none |
| PR author | the PAT owner, or `<app>[bot]` | `github-actions[bot]` | the App bot | `github-actions[bot]` |
| Hinomi knows the PR number | at once | by polling `GET /pulls?head=` | by polling | by polling |
| Works when Hinomi is down | the branch waits; the PR opens on the next poll | yes | yes | yes |

**Recommendation: A by default, B as a per repo fallback** ("workflow opens the PR") for people who do not want to give Hinomi any PR write. C is rejected: long lived write credentials copied into every repo is the worst trade. With a PAT the PR author is the user themselves, so in repos with required reviews the user cannot approve their own fix PR. Using a GitHub App avoids this (the author is the bot), and the docs say so.

### 3.2 Permission matrix: Hinomi's own credential

Today Hinomi is read only (docs/github.md: "It never writes anything"). The runner adds writes, so the probe reports them separately and the runner stays off until they pass.

| Capability | Classic PAT | Fine grained PAT | GitHub App installation |
|---|---|---|---|
| Already needed (scan) | `repo`, `security_events` | Dependabot alerts R, Metadata R, Contents R, Administration R (optional) | dependabot_alerts R, contents R, metadata R, administration R (optional) |
| Dispatch the workflow | `repo` | **Actions: write** | **actions: write** |
| Read runs, jobs, artifacts | `repo` | Actions (covered by write) | actions |
| Open or update the PR, set labels (mode A) | `repo` | **Pull requests: write** (labels on PRs: Issues: write, or skip labels) | **pull_requests: write** (issues: write for labels) |
| Read check runs and statuses (#63) | `repo` | **Checks: read**, **Commit statuses: read** | checks: read, statuses: read |
| Setup PR (optional, one time) | `repo` + **`workflow`** | **Contents: write** + **Workflows: write** | contents: write + workflows: write |
| Never needed | `admin:*`, `delete_repo` | Administration write, Secrets | administration write, secrets |

A classic PAT cannot be narrowed: `repo` already grants everything except workflow files. Docs should steer runner users to a fine grained token or the App. The App permission change also needs the installation owner to accept it (docs/github.md already says so). `REQUIRED_APP_PERMISSIONS` stays scan only; add a separate `RUNNER_APP_PERMISSIONS = ['actions', 'pull_requests', 'checks', 'statuses']` that is checked only when the runner is on.

### 3.3 Permission matrix: the workflow's GITHUB_TOKEN

| Job | Mode A (Hinomi opens PR) | Mode B (workflow opens PR) |
|---|---|---|
| caller job (ceiling) | `contents: write` | `contents: write`, `pull-requests: write` |
| `apply` | `contents: read` | `contents: read` |
| `publish` | `contents: write` | `contents: write`, `pull-requests: write` |
| `majors` (agent, optional) | `contents: read` plus the agent's own secret | same |

`GITHUB_TOKEN` cannot write `.github/workflows/*` (no Workflows permission), so the fix can never alter workflows even by accident. The publish job also refuses such paths.

## 4. Applying a plan mechanically

### 4.1 Pipeline inside the `apply` job (all in the action)

1. **Validate** the plan (section 7). Refuse `schema` versions the action does not know. Refuse a plan whose `repo.fullName` differs from `github.repository`.
2. **Re-detect** the package manager from the checkout (lockfile plus `packageManager` field) and compare with the plan. On a mismatch, stop and report; never guess.
3. **Reconcile with the live tree.** The default branch may have moved since the scan: for each step, read the currently resolved version from the lockfile. If it already satisfies `to`, mark the step `already-fixed`. If `from` no longer matches, re-evaluate: still vulnerable means apply, otherwise skip with a reason.
4. **Release age pre-check.** Read the repo's gate (pnpm `minimumReleaseAge` in `pnpm-workspace.yaml`, minutes, default 1440 in current pnpm docs ([pnpm](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/dependency-resolution.md)); bun `install.minimumReleaseAge` in `bunfig.toml`, seconds ([bun](https://github.com/oven-sh/bun/blob/main/docs/runtime/bunfig.mdx)); npm `min-release-age` in `.npmrc`, days ([npm config](https://docs.npmjs.com/cli/v11/using-npm/config)); yarn berry `npmMinimalAgeGate` in `.yarnrc.yml`, a duration such as `1w` or bare minutes, default one day since 4.15.0, with `npmPreapprovedPackages` as its exclusions ([yarnrc](https://yarnpkg.com/configuration/yarnrc#npmMinimalAgeGate)); yarn classic has none; cargo `registry.min-publish-age` or `registry.global-min-publish-age` in `.cargo/config.toml`, which stable cargo does not enforce yet (`-Zmin-publish-age` is nightly only), so the runner applies it itself and otherwise uses Hinomi's floor; crates.io publish times come from `https://crates.io/api/v1/crates/<name>/<version>` (`created_at`), one request per second with a User-Agent naming the project). Query the registry publish time of `to`. If it is younger than the gate, skip the step with `too-new: eligible on <date>`. **Never add the package to an exclusion list** and never lower the gate. If npm's version predates `min-release-age` support but `.npmrc` sets it, pass `--before=<now minus gate>` so the gate is honoured anyway (a known npm 10 gap).
5. **Edit manifests** (JSON or YAML edits that keep formatting, not `pkg add`, which rewrites ranges):
   - Direct bump: in the manifest named by the step (workspace aware), replace the specifier and keep its style (`^1.2.3` becomes `^1.4.0`, an exact pin stays exact). Skip `workspace:`, `catalog:` (edit the catalog entry instead), `npm:` aliases, git and file specifiers, and report them as `manual`.
   - Transitive fix: an override scoped to the vulnerable range, so unrelated majors are untouched.
6. **One install, lockfile mode**, then a full install for checks (table below). If the install fails, bisect by applying steps in halves with lockfile only installs (cheap), mark the offenders `skipped: install failed (<first error line>)`, and continue with the rest.
7. **Run checks** (4.3), record results.
8. **Emit** `git diff --binary` as `fix.patch`, plus `hinomi-result.json` (schema in section 10), as one artifact with `retention-days: 7`.

### 4.2 Per package manager

| PM | Direct bump | Transitive fix | Lockfile update | Install for checks |
|---|---|---|---|---|
| pnpm 9 | edit specifier | `pnpm.overrides` in root `package.json` (or `pnpm-workspace.yaml`, see section 15): `"pkg@<vulnRange>": "<to>"` | `pnpm install --lockfile-only` | `pnpm install --frozen-lockfile` |
| pnpm 10/11 | edit specifier (or the `catalog:` entry) | `overrides` in `pnpm-workspace.yaml` when that file exists, else `pnpm.overrides` in root `package.json` (section 15); on pnpm 11 a convergence override `"pkg@": "<to>"` when every edge's range admits `to` ([overrides](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/dependency-resolution.md)) | `pnpm install --lockfile-only` | `pnpm install --frozen-lockfile` |
| npm | edit specifier | `overrides` in root `package.json` (`{"parent": {"pkg": "<to>"}}` or `"pkg": "<to>"`) | `npm install --package-lock-only` | `npm ci` |
| yarn berry (3+) | edit specifier | `resolutions` in root `package.json` (`"pkg": "<to>"`; an existing entry for the package, such as `"pkg@npm:<range>"`, is updated in place) | `yarn install --mode=update-lockfile --no-immutable` (resolves and fetches, skips the link and build steps) | `yarn install --immutable` |
| yarn classic | edit specifier | `resolutions` (`"pkg": "<to>"`, an existing `"**/pkg"` updated in place) | `yarn install --ignore-scripts --non-interactive` (no lockfile only mode exists) | `yarn install --frozen-lockfile` |
| bun | edit specifier | `overrides` in root `package.json` (top level only; an existing entry in `overrides` or `resolutions`, which bun also reads, is updated in place) | `bun install --lockfile-only --ignore-scripts` (keeps a `bun.lockb` binary, read through `bun pm ls --all`) | `bun install --frozen-lockfile` |
| cargo | in range: `cargo update -p name@from --precise to`; out of range: edit `Cargo.toml` (or `[workspace.dependencies]`), then `cargo update --workspace` and `cargo update -p name@<major> --precise to`, so the new requirement is pinned to the checked `to` and not the newest release | in range: `cargo update -p name@from --precise to`; otherwise cannot override, so it goes to `risky` or `unfixed` | (same commands) | `cargo fetch --locked` |

Toolchain setup in the reusable workflow: `actions/setup-node` with `node-version-file` when present (else LTS), `pnpm/action-setup` (reads `packageManager`), `oven-sh/setup-bun`, `dtolnay/rust-toolchain` or `rust-toolchain.toml`, all pinned by SHA. Do not rely on Corepack: it is no longer bundled with current Node majors.

Existing overrides: if the repo already has an override for the package, update it in place and never stack a second one. Overrides Hinomi adds are recorded in the PR body, so a later plan can remove them once the parent bumps. That is a #61 follow up ("stale override").

### 4.3 Checks

Detection order from root `package.json` scripts (and the workspace runner if `turbo.json` exists, using the same script names): `lint`, `typecheck` (also `type-check`, `check-types`), `test` (with `CI=true`), `build`. `format:check` is skipped by default, because lockfiles and manifests are usually prettier ignored. Cargo: `cargo check --locked --all-targets`, `cargo test --locked`. The caller may override with an input `checks: "lint,typecheck,test"`, and the dispatch's `options.checks` is `full` (install, then the checks) or `install` (install only). Hinomi sends `full` for public repos and `install` for private ones (decision 2).

Each check gets a per check timeout and its last 60 lines are kept (secrets are masked by the runner already; also strip anything matching token patterns).

**When checks fail:** the change is still committed and the PR is opened **as a draft** with a "Checks failed" section (which check, its command, the log tail, a run link). Nothing is dropped silently. Optional bisect mode (decision D3) spends extra minutes to find which step breaks a check and moves it to a "held back" list.

## 5. PR shape

- **Branch:** `hinomi/fix-plan` (one per repo, so re-dispatch reuses it). The publish job does `git push --force-with-lease=hinomi/fix-plan:<previous sha or empty>` of a single commit on top of the current default branch head. Commit author `hinomi-fix <41898282+github-actions[bot]@users.noreply.github.com>`, message `fix(deps): apply hinomi fix plan <planId>`.
- **Title:** `fix(deps): clear <n> findings in <p> packages (<x> exposed)`, counted over the applied steps, the exposed part only when there are exposed findings. Conventional, lowercase, no dashes.
- **Body** (Hinomi renders it in mode A; the action renders the same template in mode B, so it lives in `packages/shared`):
  1. One line summary and, on private repos only, the link to the fix run in Hinomi (decision 13). The dispatch carries `options.linksAllowed`, and the renderer leaves every link to the Hinomi instance out when it is false, so a public repo never shows the instance's hostname.
  2. **Findings cleared by tier:** a table of the finding tiers (exposed, deployed internal, deployed public moderate or low, dev, not deployed) over the applied steps, then their advisory ids. GitHub links GHSA ids by itself.
  3. **Steps:** one table of every safe step (order, package, from, to, change type, project, result): applied, skipped with the reason (already fixed, no longer vulnerable, too new with the eligible date, manual specifier, not in the lockfile), failed (install or manifest edit), or not sent (a safe step the runner cannot apply, such as one without a lockfile).
  4. **Risky upgrades** (never applied in the fix PR, always listed): package, from, to and the plan's note or risk reasons.
  5. **Unfixed:** advisories without a patched version.
  6. **Checks:** a table of install and each check with command, result and duration; in install mode one line saying the repo's CI runs the checks. A draft PR adds **Failed checks** with each failure tail in `<details>`. The body stays under 60,000 characters: tails are shortened, then left out, before anything else is cut.
  7. Footer: "Opened by Hinomi. Hinomi never merges; review and merge by hand." plus a hidden marker `<!-- hinomi:fix repo=<id> plan=<planId> run=<runId> schema=1 -->`.
- **Labels:** `dependencies` and `security` **only if they exist** in the repo (`GET /labels`); Hinomi never creates labels.
- **Draft:** when checks failed or the install bisect skipped steps; ready otherwise.
- **Idempotency:**
  - Re-dispatch updates the same branch (force with lease) and the same PR: find an open PR by `head=<owner>:hinomi/fix-plan`, `PATCH` title, body and draft state. Draft to ready uses the GraphQL `markPullRequestReadyForReview`, ready to draft uses `convertPullRequestToDraft`.
  - Concurrency group per repo without cancel in progress, so two dispatches never race on the branch (section 16).
  - If the last fix PR was **closed unmerged**, Hinomi does not reopen it silently (decision D10).
  - If the plan produces an empty diff (everything already fixed), no push and no PR; the run ends `nothing-to-do` and #63 jumps to a rescan.

## 6. Tracking (#63)

### 6.1 Learning the run id

- Primary: `return_run_details: true`, so the dispatch response carries `workflow_run_id`. Store it on the `fix_runs` row before returning to the UI.
- Fallback (GitHub Enterprise Server or an older API without the field): the caller sets `run-name: hinomi fix ${{ inputs.run_id }}` ([run-name](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#run-name)). Hinomi lists `GET /repos/{o}/{r}/actions/workflows/hinomi-fix.yml/runs?event=workflow_dispatch&created=>=<dispatch time minus 1 min>` and matches `display_title`. Keep this path even with the primary, as a self check.

### 6.2 State machine

```
dispatched -> queued -> running -> (failed | nothing-to-do | branch-pushed)
branch-pushed -> pr-open -> checks-pending -> (checks-passing | checks-failing)
checks-* -> (merged | closed-unmerged | superseded)
merged -> deployed (Coolify deployment of the merge commit finished) -> verified (rescan clears the findings) | not-cleared
```

`superseded` covers a newer dispatch for the same repo. Each transition is a pure function of (row, GitHub snapshot), unit tested with fixtures, the same style as `scan/state.ts`.

### 6.3 Polling

| State | Endpoint | Interval |
|---|---|---|
| queued, running | `GET /actions/runs/{id}` | 20 s for the first 5 min, then 60 s; give up after the job timeout plus 10 min and mark `lost` |
| run completed | `GET /actions/runs/{id}/artifacts`, then `GET /actions/artifacts/{aid}/zip` (redirect to blob storage, outbound internet only) | once |
| branch-pushed (mode A) | create or update the PR | once, retried with backoff |
| pr-open, checks | `GET /commits/{head}/check-runs` and `/status` with `If-None-Match` | 2 min |
| checks done | `GET /pulls/{n}` with ETag | 10 min; 1 h after 3 days |
| merged | the existing Coolify source: deployment for the merge commit | the next Coolify poll |
| deployed | a targeted rescan of that repo, then compare finding ids from the plan | once |

ETags: a `304` on an authorized conditional request does not count against the primary limit ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2026-03-10#use-conditional-requests)). The client in `sources/github/client.ts` needs an `ifNoneMatch` option and `acceptStatus: [304]`. Budget: PATs and App installations get 5,000 requests per hour (installations scale up to 12,500) ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28#about-primary-rate-limits)). Ten concurrent runs at the fastest cadence come to roughly 1,800 requests per hour worst case before ETags, so add a global cap of 600 tracking requests per hour shared with scans through the existing `blockedUntil` backoff.

Watch path warning (from #63): when the merge commit only changes lockfiles or manifests and the Coolify app's watch paths exclude them, warn "this merge will not redeploy" (reuses the drift guards logic if that issue lands first).

### 6.4 Optional webhook

Events: `workflow_run` (completed), `pull_request` (opened, closed, synchronize), `check_suite` (completed). Verify `X-Hub-Signature-256` HMAC with a per installation secret. Hinomi usually has no public ingress, so this needs a public ingress for one path only (for example a Cloudflare Tunnel route for `/api/github/webhook` with everything else blocked). Off by default; when on, polling drops to a 15 min safety net. For a GitHub App, the webhook is set on the App itself (today the docs say untick Active).

## 7. Security

| Threat | Mitigation |
|---|---|
| **Expression injection:** plan text interpolated into `run:` scripts | The plan never appears in `${{ }}` inside a `run:`. It goes to the action through `with:` (not a shell) and is read with `core.getInput`. The few shell steps get values through `env:` and quote them ([secure use](https://docs.github.com/en/actions/reference/security/secure-use#use-an-intermediate-environment-variable)). Lint `fix.yml` with `actionlint` and `zizmor` in Hinomi's CI. |
| **Malicious or wrong plan** (compromised Hinomi credential, bug) | Strict zod validation: `schema` literal, package names matching the npm/crates name grammar, `to` an exact semver (no ranges, tags, URLs, `git:`, `file:`, `npm:` aliases), only packages **already in the lockfile** (no new dependencies), `to` never lower than the resolved version, manifest paths relative, normalized and inside the repo, at most 200 steps. Worst case left: a plan picks a legitimately published but bad version of an existing dependency. That is bounded by the release age gate and by the human reviewing every PR. |
| **Install scripts and tests run untrusted code** | They run in `apply`, which has a read only token, no secrets and no `id-token`. Only the patch crosses to `publish`. |
| **Patch tampering between jobs** | `publish` checks the patch only touches allowlisted paths (`**/package.json`, lockfiles, `pnpm-workspace.yaml`, `Cargo.toml`, `Cargo.lock`, `.yarnrc.yml` resolutions only), refuses anything under `.github/`, `.npmrc`, scripts or source, and checks that the patch's SHA-256 matches the one in `hinomi-result.json`. |
| **Supply chain of the runner itself** | Every third party action is pinned by full commit SHA with a version comment; Dependabot for Actions bumps them in the Hinomi repo. Callers pin `fix.yml` by SHA. Immutable releases on the Hinomi repo. |
| **`pull_request_target` pitfalls** | Not used anywhere. The runner triggers only on `workflow_dispatch`; the fix PR's CI is the repo's normal `pull_request` CI. Docs warn not to "improve" this with `pull_request_target`, which runs with a write token and secrets on PR code ([hardening](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target#hardening-a-pull_request_target-workflow)). |
| **Who can dispatch** | Anyone with Actions write on the repo can dispatch with a hand written plan. They already have write access, so this adds no new power, and validation still applies. Plan signing is decision D9. |
| **Agent hand off** | Separate job, read only token, its own secret only when enabled, prompt passed as a file (not an expression), output goes through the same patch allowlist except that source files are allowed on its own branch `hinomi/majors`, and it always opens as a draft. |
| **Secrets in logs** | Check log tails are masked by the runner and scrubbed again for token shapes before they enter the PR body or the result file. |

## 8. Cost

- **Per run, private repo** (estimate): `apply` is checkout 5 s, toolchain 15 s, install with a warm store cache 30 to 60 s (cold 1 to 3 min), then the repo's checks (Hinomi's own CI job is about 3 to 5 min). `publish` takes about 20 s, but jobs are billed in whole minutes, so 1 min. **Total about 3 to 8 min, plus the repo's own CI on the PR**, which runs the same checks again. Public repos: free on standard hosted runners ([billing](https://docs.github.com/en/actions/concepts/billing-and-usage#about-billing-for-github-actions)).
- **The double run** is the main waste: checks in `apply` and again in PR CI. Hence decision D2: for private repos, default to `install` mode in the runner (about 2 min total) and let PR CI be the check; the PR opens ready and CI decides. Public repos get full checks in the runner.
- **Caching:** none in the first release (section 16): no step restores or saves a cache, and the setup actions run with their caches off. A restore only cache could come later; a save from the apply job never.
- **Concurrency:** `concurrency: { group: hinomi-fix-${{ github.repository }}, cancel-in-progress: false }` at the reusable workflow's top level, with a name the caller never uses. A run is never cancelled halfway; GitHub keeps one pending run per group, so a newer dispatch replaces an older pending one.
- **Guard rails in Hinomi:** show "private: about N min of Actions" before dispatch (Hinomi has the repo visibility), confirm batch runs across several private repos, a per repo cooldown (default 6 h, override per click), and `timeout-minutes: 20` on `apply`.

## 9. YAML sketches

### Caller (in each target repo)

```yaml
# .github/workflows/hinomi-fix.yml
name: Hinomi fix
run-name: hinomi fix ${{ inputs.run_id }}

on:
  workflow_dispatch:
    inputs:
      run_id:
        description: Hinomi run id
        type: string
        required: true
      plan:
        description: Fix plan from Hinomi (JSON, or gzip plus base64)
        type: string
        required: true
      encoding:
        type: choice
        options: [json, gzip-base64]
        default: json

permissions: {}

jobs:
  fix:
    uses: Shironex/hinomi/.github/workflows/fix.yml@<40 char sha> # v0.2.0
    permissions:
      contents: write
      # pull-requests: write   # only in mode B (workflow opens the PR)
    with:
      run_id: ${{ inputs.run_id }}
      plan: ${{ inputs.plan }}
      encoding: ${{ inputs.encoding }}
    # secrets:
    #   agent_api_key: ${{ secrets.HINOMI_AGENT_KEY }}   # only with the agent hand off
```

### Reusable workflow outline (`Shironex/hinomi/.github/workflows/fix.yml`)

The sketch below is the plan from before the build; the real file is `.github/workflows/fix.yml` and the differences are in section 16.

```yaml
name: Hinomi fix (reusable)
on:
  workflow_call:
    inputs:
      run_id:   { type: string, required: true }
      plan:     { type: string, required: true }
      encoding: { type: string, default: json }
      open_pr:  { type: boolean, default: false }   # mode B
      checks:   { type: string, default: auto }     # auto (from the dispatch) | install | list
    secrets:
      agent_api_key: { required: false }
    outputs:
      branch: { value: ${{ jobs.publish.outputs.branch }} }

concurrency:
  group: hinomi-fix-reusable-${{ github.repository }}
  cancel-in-progress: true

permissions: {}

jobs:
  apply:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions: { contents: read }
    outputs:
      has_changes: ${{ steps.run.outputs.has_changes }}
      agent_needed: ${{ steps.run.outputs.agent_needed }}
    steps:
      - uses: actions/checkout@<sha>            # default branch, persist-credentials: false
        with: { persist-credentials: false }
      - id: detect
        uses: Shironex/hinomi/actions/fix-runner@<sha>
        with: { step: detect, plan: ${{ inputs.plan }}, encoding: ${{ inputs.encoding }} }
      # toolchain steps gated on steps.detect.outputs.pm (setup-node, pnpm, bun, rust), all SHA pinned
      - uses: actions/cache/restore@<sha>       # key from steps.detect.outputs.cache_key
      - id: run
        uses: Shironex/hinomi/actions/fix-runner@<sha>
        with:
          step: apply
          plan: ${{ inputs.plan }}
          encoding: ${{ inputs.encoding }}
          checks: ${{ inputs.checks }}
          run_id: ${{ inputs.run_id }}
      - uses: actions/upload-artifact@<sha>
        with: { name: hinomi-result, path: .hinomi/, retention-days: 7 }

  publish:
    needs: apply
    if: needs.apply.outputs.has_changes == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions: { contents: write }            # plus pull-requests: write in mode B
    outputs:
      branch: ${{ steps.push.outputs.branch }}
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/download-artifact@<sha>
        with: { name: hinomi-result, path: .hinomi/ }
      - id: push
        uses: Shironex/hinomi/actions/fix-runner@<sha>
        with:
          step: publish                         # verify allowlist and hash, git apply, commit, push --force-with-lease
          open_pr: ${{ inputs.open_pr }}
          token: ${{ github.token }}

  majors:                                       # optional agent hand off, off unless the plan asks and the secret exists
    needs: apply
    if: needs.apply.outputs.agent_needed == 'true'
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - run: echo "agent job: writes the prompt file from the plan, runs the SHA pinned agent action, uploads its patch; a second small job pushes hinomi/majors"
```

## 10. Dispatch payload and result schemas

Both are zod schemas in `packages/shared`, shared by the server, the runner action and the web app: the schemas and the projection in `runner.ts`, the encoder in `runner-payload.ts`, the PR renderer in `runner-pr.ts`. The dispatch is a projection of the FixPlan (`fixPlanSchema`, see docs/api.md "Fix plans"). Unknown keys are stripped, so a later optional field does not break an older runner; anything else that changes raises the `schema` value.

```ts
// input `plan`, after decoding: fixDispatchV1Schema
FixDispatchV1 = {
  schema: 'hinomi.fix-dispatch/1',
  runId: string,                  // Hinomi's fix run id, also in run-name
  dispatchedAt: string,           // ISO, from the shared clock
  plan: { version: 1, scanRunId: number, createdAt: string },
  repo: { id: number, fullName: string /* must equal github.repository */, baseBranch: string },
  steps: FixDispatchStep[],       // safe steps only, in plan order, at most 200
  risky: FixDispatchRisky[],      // risky steps for the majors job; empty unless options.agent
  omitted: { steps: number, risky: number, advisories: boolean },  // what the size budget left out
  options: {
    checks: 'full' | 'install',   // full on public repos, install on private ones
    agent: boolean,               // run the optional majors job
    linksAllowed: boolean,        // the PR may link back to Hinomi (private repos only)
    releaseAgeDays: number,       // Hinomi's floor (7); the runner uses the stricter of this and the repo's gate
  },
}

FixDispatchStep = {
  id: string, order: number,      // the FixPlan step id and order
  tier: FindingTier,              // most urgent tier of its findings, used to trim by priority
  ecosystem: string, packageName: string,
  relationship: 'direct' | 'transitive' | 'unknown',
  lockfile: string,               // repo relative
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'cargo',
  workspaces: string[],           // folders (npm family) or crate names (cargo)
  from: string[], to: string,     // exact versions
  level: 'patch' | 'minor' | 'major' | 'unknown',
  apply:                          // the FixPlan apply union without `manual`
    | { type: 'manifest_bump', manifests: string[], packageName: string, version: string }
    | { type: 'override', manifest: string, field: 'pnpm.overrides' | 'overrides' | 'resolutions', key: string, value: string }
    | { type: 'lockfile_update', tool: 'cargo', packageName: string, from: string[], to: string },
  advisories: string[],           // dropped first when the payload is too large
  releasedAt: string | null, releaseAge: 'clear' | 'too_new' | 'unknown',
}

FixDispatchRisky = {
  id, order, tier, ecosystem, packageName, packageManager, lockfile: string | null, workspaces,
  from, to, level, riskReasons: FixPlanRiskReason[], note: string | null,
  apply: /* same union, looser versions */ | null,   // null when the plan says manual
  advisories,
}
```

Validation is strict where a value reaches a manifest edit or a command: npm and crate name grammar, exact semver for `to`, `from`, override values and bump versions (no ranges, tags, URLs or aliases), repo relative paths that stay inside the repo and outside `.github`, manifests that are `package.json` files, an override key for the step's own package, `lockfile_update` and crate bumps only for cargo, at most 200 steps. The projection drops a safe step that fails these checks (or has no lockfile, or a `manual` apply); the PR body shows it as not sent.

**Encoding** (`encodeFixDispatch`): plain JSON when it fits in 60,000 characters (`FIX_DISPATCH_PAYLOAD_BUDGET`, headroom under GitHub's 65,535 for the other inputs), else gzip plus base64 within the same budget. If that is still too large it drops, in order, the risky entries, the advisory lists, and then the least urgent steps (by tier, then plan order), keeping as many as fit, and records the counts in `omitted` and the step ids in its return value. It fails with `FixPayloadError` `too_large` only when not one step fits. gzip comes in through a `FixPayloadCompressor` (node:zlib in the server and the action), so `packages/shared` stays free of platform APIs; the decompressor must cap its output. `decodeFixDispatch` reverses it and validates the result.

```ts
// .hinomi/hinomi-result.json, uploaded by `apply`, read by Hinomi: fixResultV1Schema
FixResultV1 = {
  schema: 'hinomi.fix-result/1',
  runId: string, planScanRunId: number, repo: string /* owner/name */,
  baseSha: string,                // the base branch commit the steps were applied to
  packageManager: PackageManager, packageManagerVersion: string | null,
  checksMode: 'full' | 'install',
  steps: Array<{ id: string, status: 'applied' | 'skipped' | 'failed',
                 reason: 'already_fixed' | 'no_longer_vulnerable' | 'too_new' | 'manual_specifier'
                       | 'not_in_lockfile' | 'install_failed' | 'edit_failed' | null,
                 detail: string | null, files: string[] }>,
  releaseAge: Array<{ stepId, packageName, version, publishedAt: string | null, gateDays: number,
                      gateSource: string, status: 'clear' | 'too_new' | 'unknown', eligibleAt: string | null }>,
  install: { status: 'ok' | 'failed' | 'skipped', durationMs: number, output: string | null, truncated: boolean },
  checks: Array<{ name: string, command: string, status: 'passed' | 'failed' | 'skipped' | 'timeout',
                  durationMs: number, output: string | null, truncated: boolean }>,
  patch: { sha256: string, files: string[], insertions: number, deletions: number } | null,
  finishedAt: string,
}
```

Check and install output is the tail kept by `truncateCheckOutput`: the last 60 lines, at most 4,000 characters, with token shaped strings replaced by `***` on top of the runner's own masking.

**Version checks:** `parseFixPlan`, `parseFixDispatch` and `parseFixResult` throw `FixPayloadError` `unsupported_version` for a plan `version`, dispatch `schema` (or its plan version) or result `schema` they do not know, before any other validation, and `malformed` with the failing path otherwise.

**PR body:** `renderFixPrBody(plan, result, { linksAllowed, hinomiUrl? })` returns `{ title, body, draft }` as described in section 5. It throws `mismatch` when the result is for another plan or repo.

## 11. Decisions for the user

Each lists the recommendation first.

- **D1. Who opens the fix PR?**
  1. Hinomi opens or updates it from the pushed branch (CI runs normally, no secrets or settings in the target repo; Hinomi needs Pull requests write) **(recommended)**
  2. The workflow opens it with GITHUB_TOKEN (needs the repo setting; CI waits for an "Approve workflows to run" click)
  3. An App or PAT secret stored in each target repo
  4. Offer 1 and 2 per repo, with 1 the default
- **D2. Checks inside the runner?**
  1. Full checks on public repos, install only on private repos (PR CI does the checks; saves about half the minutes) **(recommended)**
  2. Always full
  3. Always install only
- **D3. When checks fail:**
  1. Open a draft PR with every change and the failure tail **(recommended)**
  2. Bisect to find the breaking steps and hold them back (more minutes)
  3. Open no PR, only report in Hinomi
- **D4. How callers pin the reusable workflow:**
  1. Commit SHA with a version comment, and Hinomi flags outdated callers **(recommended)**
  2. Release tag (`@v0.2.0`) with immutable releases
  3. A moving major tag (`@v0`)
- **D5. Setup of the caller workflow:**
  1. Copy paste panel by default, plus a "setup PR" button when the token has Workflows write **(recommended)**
  2. Copy paste only (Hinomi never asks for Workflows write)
  3. Always a setup PR (Workflows write required for the runner)
- **D6. Risky majors with the agent on:**
  1. A separate draft PR per repo on `hinomi/majors`, so the safe PR stays mergeable **(recommended)**
  2. Agent commits on the same fix PR
  3. Hinomi opens an issue listing the majors, no agent
  4. Leave the agent out of v0.2.0
- **D7. Which agent action for the hand off:**
  1. A pluggable "agent step" with one supported preset (Claude Code action) and docs for others **(recommended)**
  2. Claude Code action only
  3. Copilot coding agent (assign an issue)
- **D8. Install scripts during `apply`:**
  1. Allowed, as the repo normally runs them, isolated in the read only job **(recommended)**
  2. `--ignore-scripts` always (breaks builds with native or postinstall deps)
- **D9. Plan authenticity:**
  1. No signing; strict schema, lockfile membership and patch allowlist **(recommended)**
  2. HMAC with a per repo secret `HINOMI_PLAN_KEY`
  3. Ed25519 signature checked against a public key in a repo variable
- **D10. Re-dispatch after the last fix PR was closed unmerged:**
  1. Ask in the UI, then open a fresh PR **(recommended)**
  2. Always open a fresh PR
  3. Skip the repo until a person reopens the old PR
- **D11. Where the action code lives:**
  1. In the Hinomi monorepo under `actions/fix-runner`, released with Hinomi **(recommended)**
  2. A separate public repo `Shironex/hinomi-fix-action`
- **D12. Ecosystems in v0.2.0:**
  1. pnpm and npm first, yarn, bun and cargo in follow up slices before the release **(recommended)**
  2. All five in the first slice
  3. pnpm and npm only for v0.2.0, the rest in v0.3
- **D13. Fix PR links back to the Hinomi instance:**
  1. Leave links out on public repos, include them on private ones **(recommended)**
  2. Always include them
  3. Never include them

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Hinomi moves from read only to write | Trust, docs ("never writes") become false | Runner off by default, separate permission probe, docs section "what the runner writes" |
| `return_run_details` is newish | Run id missing on GHES or on API changes | run-name correlation fallback kept and tested |
| Plan exceeds 65,535 characters | Dispatch rejected | Lean payload, gzip plus base64, priority split with `deferred` steps |
| Repo default branch moved since the scan | Wrong `from` versions | Reconcile step against the live lockfile |
| Release age gate blocks the target | Install fails | Pre-check publish time, `too-new` with eligible date; #63 re-dispatches after that date if the user opts in |
| Monorepo layouts (catalogs, nested workspaces, Turbo filters) | Edits in the wrong manifest | #61 records the manifest per step; the action refuses ambiguous cases as `manual` |
| Format checks fail on edited manifests | Red PR for a cosmetic reason | Keep formatting on edits; run the repo's formatter on changed files if a `format` script exists |
| Double checks burn minutes | Cost on private repos | D2 default, restore only cache, cooldowns, cost shown before dispatch |
| Branch protection on `hinomi/*` or required signed commits | Push rejected | Detect a push failure, report it clearly; document a ruleset exception or signing via the App (later) |
| PAT author cannot approve own PR | Merge blocked under required reviews | Recommend the GitHub App for the runner |
| Third party action compromise | Code runs with the repo token | SHA pins, minimal actions, read only apply job |
| Artifact zip parsing on the server | A new dependency | Small zip reader on `node:zlib` (`inflateRaw`) with the central directory, about 80 lines plus tests; the house rule prefers small helpers |

## 13. Slice plan

Each slice is one PR. #61 must land its FixPlan schema first.

### #62 runner

1. **feat(shared): fix dispatch and result schemas.** `packages/shared/src/runner.ts`: zod `FixDispatchV1`, `FixResultV1`, an encoder (json or gzip plus base64 with the size budget and priority split), a projection from FixPlan, and a PR body renderer as a pure function. Tests with fictional repos.
2. **feat(runner): fix runner action for pnpm and npm.** `actions/fix-runner` (TypeScript, bundled, node24): detect, validate, reconcile, release age pre-check, manifest and override edits, lockfile install with bisect, check detection and run, patch plus result. Fixture repos under `actions/fix-runner/fixtures` driven by unit tests (registry mocked).
3. **ci(runner): reusable fix workflow and caller template.** `.github/workflows/fix.yml`, `docs/runner/hinomi-fix.yml` template, actionlint and zizmor in CI, a release step that pins the action SHA, and a self test workflow that dispatches against a public fixture repo (free minutes).
4. **feat(server): github actions runner and dispatch.** A `FixRunner` interface (shared later with #65), `GithubActionsRunner.dispatch` with `return_run_details`, per repo enable (off by default), a runner permission probe (`RUNNER_APP_PERMISSIONS`, fine grained probes), the caller detection and pin check, docs/github.md "Fix runner" section.
5. **feat(server): open and update the fix pr.** Mode A publisher: find or create on `hinomi/fix-plan`, body from the shared renderer, existing labels only, draft state sync, closed unmerged handling (D10). Mode B toggle passed in the dispatch.
6. **feat(runner): yarn, bun and cargo appliers.** One PR, or three if large.
7. **feat(server): runner setup pr.** The optional setup PR when Workflows write is present; the copy paste payload API for #64.
8. **feat(runner): optional agent hand off for risky majors.** The `majors` job, prompt file, `hinomi/majors` draft PR; docs on secrets and cost. Off by default.

### #63 tracking

1. **feat(server): fix runs table and state machine.** A Drizzle migration for `fix_runs` (repo, plan id and version, run id, branch, PR number, state, timestamps, result json, etags), pure transition function, tests.
2. **feat(server): poll fix runs and read results.** A scheduler job with cadence per state, ETag support in `GithubClient` (`ifNoneMatch`, accept 304), artifact download and zip reader, PR and check polling, a shared request cap.
3. **feat(server): link merged fixes to deployments and verify.** Coolify deployment of the merge commit, the watch path warning, a targeted rescan, `verified` or `not-cleared`.
4. **feat(server): fix run notifications.** PR opened, checks failed, verified fixed, through the existing notifier (ranked, deduped). Built, see section 18.
5. **feat(server): optional github webhook for fix runs.** HMAC verified endpoint, `workflow_run`, `pull_request` and `check_suite` handlers feeding the same transitions, docs for a single path tunnel ingress.

Order: #61, then 62.1, then 62.2 and 63.1 in parallel, then 62.3, then 62.4, then 62.5 and 63.2, then 63.3, 63.4, 62.6, 62.7, 62.8, 63.5. #64 (UI) can start against the API after 62.4 and 63.1.

## Sources

- Workflow dispatch REST, `return_run_details`, 25 inputs: https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event (and the 2026-03-10 version)
- `workflow_dispatch` event, 65,535 character payload, default branch rule: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch
- Repository dispatch limits and permission: https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#create-a-repository-dispatch-event--parameters
- GITHUB_TOKEN and triggered runs (approval required PR runs): https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs
- Allow Actions to create PRs setting: https://github.com/github/docs/blob/main/content/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository.md
- Reusable workflows (access, limits, permissions, billing, github context): https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#reusable-workflows
- Workflow permissions keys: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions
- run-name: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#run-name
- Workflows permission for App tokens: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28#repository-permissions-for-workflows
- App token inside a workflow: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow
- Script injection mitigations: https://docs.github.com/en/actions/reference/security/secure-use#writing-workflows
- pull_request_target hardening: https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
- Conditional requests: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2026-03-10#use-conditional-requests
- Rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28#about-primary-rate-limits
- Actions billing: https://docs.github.com/en/actions/concepts/billing-and-usage#about-billing-for-github-actions
- pnpm overrides and minimumReleaseAge: https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/dependency-resolution.md
- bun minimumReleaseAge: https://github.com/oven-sh/bun/blob/main/docs/runtime/bunfig.mdx
- npm min-release-age and before: https://docs.npmjs.com/cli/v11/using-npm/config

To verify while building (not checked against docs here): whether fine grained PR labelling needs Issues write. Checked in 62.6: yarn berry's `npmMinimalAgeGate` ([yarnrc](https://yarnpkg.com/configuration/yarnrc#npmMinimalAgeGate)), `yarn install --mode=update-lockfile` ([yarn install](https://yarnpkg.com/cli/install)), `bun install --lockfile-only` and `--ignore-scripts` ([bun lockfile](https://github.com/oven-sh/bun/blob/main/docs/pm/lockfile.mdx), [lifecycle](https://github.com/oven-sh/bun/blob/main/docs/pm/lifecycle.mdx)), bun `overrides` and `resolutions` ([overrides](https://github.com/oven-sh/bun/blob/main/docs/pm/overrides.mdx)).

## 14. Decisions taken (user, 2026-11-07)

1. Hinomi opens and updates the fix PR from the pushed branch with its own credential (mode A).
2. Checks: full checks in the runner on public repos, install only on private repos.
3. Failing checks: draft PR with every change and the failure output.
4. Callers pin the reusable workflow by full commit SHA; Hinomi flags outdated callers.
5. Caller setup: copy paste by default, plus a setup PR button when the token has Workflows: write.
6. Risky majors with the agent on: separate draft PR on `hinomi/majors`.
7. Agent: pluggable step with a Claude Code preset, off by default.
8. Install scripts allowed inside the read only `apply` job.
9. No plan signing; strict schema, lockfile membership and the dependency file allowlist.
10. Re-dispatch after a closed unmerged PR: ask in the UI.
11. Action code lives in the Hinomi monorepo (`actions/fix-runner`), add `runner` to the commitlint scope enum.
12. Ecosystems: all five (pnpm, npm, yarn, bun, cargo) in the first runner release; build the core with pnpm and npm, then yarn, bun and cargo in parallel right after.
13. PR body links back to Hinomi only on private repos.

## 15. Resolved after #61

Answers to the questions the fix plan work left open, and where they live in the contract.

1. **Unsupported versions.** The runner refuses any plan or dispatch whose version it does not support: a FixPlan `version` other than 1, a dispatch `schema` other than `hinomi.fix-dispatch/1`, or a dispatch whose `plan.version` is not 1. Hinomi refuses a result `schema` other than `hinomi.fix-result/1`. All fail with `FixPayloadError` `unsupported_version` before anything is applied.
2. **Range prefix.** `manifest_bump` keeps the existing range prefix (`^`, `~`, or an exact pin) and replaces only the version: `^1.2.0` becomes `^1.3.0`, `1.2.0` stays exact. Specifiers that are not a plain version (`workspace:`, `catalog:`, `npm:` aliases, git, file) are not edited; the step is skipped with reason `manual_specifier`.
3. **Cargo manifests.** A Cargo `manifest_bump` lists no manifests and names the crates in the step's `workspaces`. The runner finds each crate's Cargo.toml with `cargo metadata` in the checkout. Hinomi never fetches manifests for this.
4. **Safe and risky steps.** The fix PR contains only safe steps. Risky steps never enter it: they go to the optional majors job (in `risky`, only when the agent is on) and are always listed in the PR body under "Risky upgrades, not applied", whether the agent is on or not.
5. **Where pnpm overrides go.** The runner decides, from the checkout, not Hinomi: an override with `field: 'pnpm.overrides'` is written to `overrides` in the project's `pnpm-workspace.yaml` when that file exists, else to `pnpm.overrides` in the `manifest` (the root `package.json`). If the package already has an override in either place, it is updated where it is and never added twice. Hinomi keeps sending `pnpm.overrides`, so the plan and the dispatch stay independent of the pnpm version.
6. **Release age.** The plan has `releaseAge: unknown` for every step, because OSV and GitHub carry no publish dates. The action checks each target against the registry, applies the stricter of the repo's own gate and Hinomi's floor (`options.releaseAgeDays`, 7), skips a step inside the gate with reason `too_new`, and records every check in the result's `releaseAge` with the eligible date. It never lowers a gate or adds an exclusion.

## 16. Built in 62.3: the workflow

What the reusable workflow, the caller template and the self test settled, where it differs from the sketches above.

1. **Action reference.** `uses: $/actions/fix-runner` (self repository reference) instead of an action SHA written at release time. The caller's pin on `fix.yml` covers the action, the action never sits in the target's checkout (so the repo's lint and tests never see it), and there is no extra checkout. `$/` and the `job.workflow_*` contexts are not available on GitHub Enterprise Server, so the runner needs github.com. actionlint 1.7.12 does not parse `$/` yet; `.github/actionlint.yaml` ignores exactly those two messages for `fix*.yml`.
2. **Latest SHA.** The server reads the latest Hinomi release (`GET /repos/Shironex/hinomi/releases/latest`), the commit its tag points at, and checks `fix.yml` exists there, with plain unauthenticated requests through the source fetch: three requests per 6 hours, retried after 30 minutes on failure (`apps/server/src/runner/latest.ts`). On any failure it answers `LATEST_FIX_WORKFLOW`, which stays null until a release chooses to record the previous release's commit there. No release workflow change was needed: the tag is the record.
3. **Apply in three steps.** `apply` runs with `defer_checks: true`: manifest edits and lockfile only installs (pnpm `--lockfile-only`, `npm install --package-lock-only`, cargo update, none of which runs lifecycle scripts) and the patch capture. Its outputs `base_sha`, `patch_sha256` and `patch_files` become the job outputs. Only then does the `check` step run the full install and the repo's checks, then the artifact is uploaded. The publish job verifies the downloaded patch against those job outputs, not against `hinomi-result.json` alone, so code that runs during the check step cannot swap the patch.
4. **Publish in the action.** A `publish` step in the action (not shell): the patch's SHA-256 must equal the apply job output and the result file, it must touch exactly the listed files, each must pass `isAllowedPatchPath`, and the patch may not rename, copy, delete, re-mode or add a symlink. It applies with `git apply --index` on a checkout of the base commit, checks the staged list again, commits as `github-actions[bot]` with `fix(deps): apply hinomi fix plan <scanRunId>` and pushes `hinomi/fix-plan` with `--force` (the per repo concurrency group serializes runs). The token reaches git through `GIT_CONFIG_*` environment variables, never argv or `.git/config`, and its base64 form is masked. `dry_run: true` stops before the push.
5. **Mixed ecosystems.** The detect step detects every project of the dispatch and reports every package manager present (`package_managers`, `setup_node`, `setup_pnpm`, `setup_yarn`, `setup_bun`, `setup_rust` and their versions); the workflow sets up each one. Mixed plans are not rejected: each project is applied on its own, and a project whose lockfile does not match fails only its own steps.
6. **Toolchains.** Node from `.node-version` or `.nvmrc` (the project folder, then the root), else a package.json with `engines.node`, else LTS. pnpm through `pnpm/action-setup` from the `packageManager` field, else pnpm 10. yarn without corepack (current Node majors no longer bundle it): the exact version the `packageManager` field names, installed with npm without scripts (`yarn@1.x`, or `@yarnpkg/cli-dist` for yarn 2 and later), else the yarn classic on the runner image, which follows a `yarnPath`. bun through `oven-sh/setup-bun` with its binary cache off. Rust through `dtolnay/rust-toolchain` (stable), then `rustup toolchain install` when a `rust-toolchain(.toml)` in the crate folder or above pins another one.
7. **Concurrency** does not cancel in progress (a half pushed branch is worse than a queued run). **Caches** are off entirely.
8. **Self test.** `.github/workflows/fix-selftest.yml` calls `fix.yml` on pull requests touching it or the action, with a plan that bumps `ms` from 2.1.2 to 2.1.3 in an npm and a pnpm fixture project inside this repo, and `dry_run: true`. No extra repositories, about three short jobs on a public repo (free).

### Residual risks

- **`ACTIONS_RUNTIME_TOKEN` in the apply job.** The runner gives every JavaScript action step the runtime token. The action strips it (and `ACTIONS_CACHE_URL`, `ACTIONS_RESULTS_URL`, the OIDC request variables, `GITHUB_TOKEN`) from the environment of every process it starts, but an install script or a test runs as the same user and can read the action process's own environment through `/proc/<pid>/environ`. With it, dependency code can write cache entries for the dispatch's ref (the default branch, so the repo's own CI could restore a poisoned cache), upload or delete artifacts of this run, and write job step files. What it cannot do: push (the apply token is read only), or change the patch the publish job accepts, which is pinned by the apply step's outputs set before any such code runs. The fix runs no cache step at all, so it never hands that power a cache of its own to fill, but the repo's CI caches remain exposed. Repos that cache on the default branch can reduce it by keying caches on the lockfile hash (a poisoned entry then only matches the fix branch's lockfile) or by turning the runner to install mode, which runs no install scripts in the runner at all.
- **The result file after the checks.** `hinomi-result.json` is rewritten by the check step and uploaded after it, so dependency code can forge its check results and step details. Hinomi parses it with the strict schema; the publish job takes nothing from it beyond what it cross checks. The PR's own CI reruns the checks.
- **Repo owned code during the apply step.** A repo's `.pnpmfile.cjs` or yarn plugins run during the lockfile update; they are the repo's own committed code, trusted as much as the repo's CI.
- **Pending runs.** A third dispatch while one runs and one waits replaces the waiting one; Hinomi sees that run as cancelled.
- **Force push.** `--force` instead of a lease: anything pushed to `hinomi/fix-plan` by hand is overwritten by the next run.

## 17. Built in 63.3: deployments and verification

What linking merged runs to deployments and verifying them settled, where it differs from section 6.

1. **Deploy link.** Not the scan's Coolify poll: the tracker reads each mapped application's deploy history itself (the same reader as the deployment detail view) while the run is `merged`, every 2 minutes for an hour, then every 15 minutes. A deploy ships the fix when its commit is the merge commit or a descendant of it (GitHub compare `identical` or `ahead`), so a deploy of a later commit counts. Answers are cached in memory and the compare calls share the tracker's request budget.
2. **Several apps.** The first app that ships the fix moves the run to `deployed`; the others get one more hour before the rescan. Apps that deploy another branch are listed as `other_branch` and never waited for.
3. **No deploy.** After 3 days without a deploy of the merge, the run keeps `merged` with a `deploy_not_seen` warning and polling stops. Repos with no mapped application are verified right after the merge, since the lockfile on the default branch is what Hinomi reads.
4. **Watch paths.** Checked against the files the runner's patch changed, with Coolify's rules (ordered patterns, `!` negation, last match wins). A miss is a `watch_paths_skip` warning on the run, not a state.
5. **Rescan.** A scoped rescan of the one repo through the scheduler (`scanRepo`), never beside a full scan, recording no scan run so the schedule and the last scan stay as they are. It counts only when every source read the repo fully; failures retry with backoff (5 tries), then the next full scan verifies the run. Partial results stay `not_cleared`: the state machine has no partial state, the counts and ids live in `verification`.

## 18. Built in 63.4: notifications

What announcing fix run events settled, where it differs from the slice plan. The user facing description is in [notifications.md](../notifications.md).

1. **One hook, every writer.** `fixRuns.onChanged(listener)` on the repository fires after a committed write that changed a run (`applyEvent`, `saveVerify`, and the runs a new dispatch supersedes). The tracker, the publisher, the dispatch and the verification all write through it, so none needs its own callback and the runner layer never imports `notify`. `index.ts` connects it to `notifier.handleFixRunChanged`, like the scan listener. A listener that throws is swallowed; the write stands.
2. **Derived from the row, not the event.** The notifier looks at the run's current row (state, PR, warnings) and sends what it calls for and was not sent yet (`apps/server/src/notify/fix-run-events.ts`). A missed intermediate poll therefore loses nothing, and a run first seen after its PR merged does not announce the PR.
3. **Dedup in settings.** `notify.fixRunState` holds `sent[runId][event]` as the channel ids that got it. No migration. Failed deliveries stay open for the next change of the run; records of deleted runs are pruned on write.
4. **Immediate, not batched.** Fix events skip the first scan summary, the batching and the digest, and ignore a channel's minimum severity.
5. **Links.** The PR on GitHub always; the Hinomi run page only when the run was dispatched for a private repo (`checksMode` is `install`) and a public base URL is set, as in the PR body (decision 13).
