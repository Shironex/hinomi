# Phase 2 (v0.3.0): guard it

Status: decided 2026-11-07 (see "Decisions taken" before section 13). Covers #66 (drift guards), #87 (runtime support windows), #67 (image scan for image only deployments), #68 (desktop tier), #70 (more lockfile ecosystems) and #71 (more deployment sources). Built in auth (#69) is out of scope. Section 13 keeps the options as they were asked; the "Decisions taken" section wins over them and over anything earlier in this document. The running version and update check (#130) is part of v0.3.0 as slice 28.

## 0. Summary

- **One new finding kind, `guard`.** Every non-advisory check (root container, shared network, Docker socket, watch paths, framework support, runtime support, disagreeing pins) is a guard check that writes a finding with a `guardCheck` and a `guardLevel` (`warn`, `fail` or `unknown`). Guard findings live in the existing `findings` table, keep the existing states (snooze, accept, reopen) and the existing event history, and rank on the same formula as advisories and blind spots.
- **Turn off with a reason** is a row in a new `check_overrides` table (check, deployment or repo, reason). A turned off check still runs; its finding is stored as `accepted` with the override's reason, so it stays visible under the accepted filter. Rank, never hide.
- **Signals are named field by field** (section 4). The Coolify API has no container user field and no network list per application, so: the root check reads `custom_docker_run_options`, compose `user:` and the final stage `USER` of the Dockerfile; the shared network check groups resources by destination and project; anything a source cannot tell gives `unknown`, never a silent pass. The Docker labels source reads the real values (`Config.User`, `Mounts`, `NetworkSettings.Networks`) from container inspect.
- **Support windows come from endoflife.date**, cached once a day in SQLite and used offline from the last copy. The same engine powers the runtime check (Node first: `.nvmrc`, `.node-version`, `.tool-versions`, `mise.toml`, `volta`, `engines`, `devEngines`, Dockerfile `FROM`, `setup-node`, action `runs.using`) and the framework check (lockfile packages joined to endoflife.date products by the purl identifiers the API already publishes, for example `pkg:npm/next`, `pkg:pypi/django`, `pkg:composer/laravel/framework`).
- **Notifications fire on entering a window**, never on every scan: a runtime or framework finding opens when it enters the warning window, and an `escalated` event fires once when it crosses into end of life.
- **Image scan, off by default:** read Coolify's own scan results (`GET /applications|services|databases/{uuid}/vulnerabilities`) when the instance has them; registry SBOM attestations plus OSV is the second option; a Trivy or Grype sidecar is documented but not built.
- **Desktop tier:** a repo with GitHub releases that look installable and no deployment gets its latest release tag scanned (lockfiles fetched at the tag, then OSV). Findings land in a new `released` tier between `internal` and `public_low` weight.
- **Six lockfile formats** join: `go.mod`/`go.sum` (plus Go `stdlib` from the toolchain line), `uv.lock`, `poetry.lock`, `requirements.txt` (pins only), `composer.lock`, `Gemfile.lock`, each a hand written parser like the existing ones.
- **One `DeploymentSource` interface** with capabilities. Coolify moves behind it first, then a manual list, then Docker labels (socket proxy, GET only), then Dokploy (its API returns database passwords in plain text, so it ships with a loud warning or waits, see Q22).
- **About 6 migrations** (0011 to 0016) and **27 slices**, most of them parallel after the contract and framework slices land.

## 1. Goals, non-goals, what stays

### Goals

1. Catch risky configuration drift on deployed things, ranked next to advisories, with a fix text per check.
2. Warn before a runtime or framework release line loses security support, with the exact files to edit.
3. Cover deployments that run only an image (optional), repos that ship releases instead of deployments, and six more lockfile ecosystems.
4. Read deployments from more than Coolify without changing the join or the ranking.

### Non-goals

- Not a general CIS benchmark or container hardening scanner. Checks are few, explained, and each tied to a real way these setups get hurt.
- Not a general SBOM platform (the spec's non-goal stands). Image scanning reuses results someone else computed, or an SBOM the image already carries.
- No writes to any deployment platform. Every new source is read only, and the doc says where a platform makes that impossible to enforce.
- No auto fix for guards in v0.3. The fix runner can open a runtime bump PR later (section 5.7), not now.
- No built in auth (#69).

### What stays as it is

- The scan phases (deployments, alerts, lockfiles, matching, ranking). Guards evaluate in the ranking phase, next to `applyBlindSpots`, in the same transaction pattern.
- The rank formula `reach*10 + runtime*5 + severity(1..4) + cvss/100`, the dedupe by `dedupeKey`, the states, `finding_events`, snooze and accept.
- The existing blind spots and the `image_only` coverage note. `archived_deployed` stays a blind spot (Q5).
- The notifier's rules: first scan or more than 10 items sends one summary, per channel minimum severity, dedupe per (event, channel), coverage notes never sent.
- The fix runner and its contract version 1.
- One container plus SQLite. Nothing new is required to boot; every new source and the image scan are inert until configured.

## 2. Findings model for non-advisory findings

### 2.1 Kinds

| Finding | Kind | Subject | Why this kind |
|---|---|---|---|
| Drift checks (root, network, socket, watch paths) | `guard` | deployment | configuration, not a package |
| Framework support line | `guard` | deployment, else repo | a line, not an advisory |
| Runtime support line, disagreeing pins, action runtime | `guard` | repo (deployment linked when the pin source is the deployed Dockerfile) | pins live in the repo |
| Desktop release advisories | `advisory` with `releaseTag` | repo plus release | it is an advisory, only the reach differs |
| Image scan results | `advisory` reported by `image` | deployment | it is an advisory on a package in the image |
| Release without a lockfile at the tag | `coverage_note` `release_lockfile_missing` | repo | same role as `image_only` |

Shared contract additions (`packages/shared/src/model.ts`):

```ts
export const FINDING_KINDS = ['advisory', 'blind_spot', 'coverage_note', 'guard'] as const
export const GUARD_CHECKS = [
  'root_user',
  'shared_network',
  'docker_socket',
  'watch_paths_skip',
  'framework_support',
  'runtime_support',
  'runtime_pins_disagree',
  'action_runtime',
] as const
export const GUARD_LEVELS = ['warn', 'fail', 'unknown'] as const
export const REPORTERS = ['github', 'osv', 'image'] as const
export const COVERAGE_NOTE_TYPES = ['image_only', 'release_lockfile_missing'] as const
export const FINDING_TIERS = [
  'blind_spot', 'exposed', 'internal', 'released', 'public_low', 'dev', 'not_deployed', 'patched', 'coverage',
] as const
```

`archived_deployed` keeps its blind spot type. The override table accepts any check id from `GUARD_CHECKS` or `BLIND_SPOT_TYPES`, so a blind spot can be turned off per deployment with a reason too (Q5).

### 2.2 Table shape

Columns added to `findings` (migration 0011):

| Column | Type | Meaning |
|---|---|---|
| `guard_check` | text, enum `GUARD_CHECKS`, nullable | set when `kind = 'guard'` |
| `guard_level` | text, enum `GUARD_LEVELS`, nullable | current level |
| `evidence` | json, nullable | check specific, zod typed per check: the signal source, the raw value, file and line, for example `{ source: 'dockerfile', path: 'apps/api/Dockerfile', line: 31, user: null, from: 'node:22-alpine' }` |
| `release_tag` | text, nullable | desktop advisories: the tag that was scanned |

Dedupe keys (`repository/findings.ts`):

- `guardFindingKey(check, subject)`: `guard:{check}:deployment:{id}` or `guard:{check}:repo:{id}`. One row per check per subject; the row updates its level and evidence in place.
- `releaseAdvisoryFindingKey(advisoryId, repoId)`: `advisory:{id}:repo:{repoId}:release`. A separate row from the default branch advisory on the same repo, because the version at the tag can differ. The row follows the latest tag (`release_tag` updates), it is not one row per tag.
- `imageAdvisoryFindingKey(advisoryId, deploymentId)`: `advisory:{id}:deployment:{deploymentId}:image`. `repo_id` stays null for image only deployments (the column is already nullable).

New table `check_overrides` (migration 0012):

| Column | Type |
|---|---|
| `id` | integer pk |
| `check` | text (a guard check or a blind spot type) |
| `deployment_id` | integer, nullable, cascade |
| `repo_id` | integer, nullable, cascade |
| `reason` | text, not null, 1 to 500 characters |
| `created_at`, `updated_at` | ms timestamps |

Unique on (`check`, `deployment_id`, `repo_id`). Exactly one of the two ids is set (checked in code, the repo has no CHECK constraints today).

`finding_events.type` is free text, so the new `escalated` event (with `reason` holding `warn -> fail` or `warning -> eol`) needs no migration.

### 2.3 Levels and the "unknown" rule

Each check returns, per subject, one of:

| Result | Effect |
|---|---|
| `pass` | no finding; an open one is marked fixed (`markFixed`, actor system) |
| `warn` | finding open at level warn |
| `fail` | finding open at level fail |
| `unknown` | finding at level unknown, shown in the `coverage` tier with the reason ("this source does not report the container user"), never notified, ranked like a coverage note |
| `null` (could not run: fetch failed, rate limited) | leave the existing row alone, same as `present: null` in `BlindSpotCheck` |

A source that cannot give a signal produces `unknown`, never `pass`. This is what keeps a manual list or an image only deployment from looking safe.

Level changes on an open row: a worse level writes an `escalated` event and reopens a snoozed row (snooze means "not now", not "never tell me it got worse"). A better level updates in place and writes a `level_changed` event, no notification.

### 2.4 Ranking

Guard findings use the existing formula with a per check severity table, exactly like `BLIND_SPOT_SEVERITY`:

| Check | `fail` counts as | `warn` counts as |
|---|---|---|
| `docker_socket` | critical | (no warn level) |
| `root_user` | high | moderate (no USER in the final stage, Q9) |
| `shared_network` | high when a database shares the network, else moderate | moderate |
| `runtime_support` | high (end of life) | moderate (inside the window) |
| `framework_support` | high (end of life) | moderate (inside the window) |
| `watch_paths_skip` | (no fail level) | moderate |
| `runtime_pins_disagree` | (no fail level) | low |
| `action_runtime` | moderate (deprecated runtime) | low (inside the window) |

`rank = REACH_WEIGHT[reach]*10 + (running ? 5 : 0) + severity`, with no cvss part. Repo subject findings take the best reach of the repo's running deployments, the same way advisory findings do today, and `none` when nothing is deployed.

Tier (Q2, recommended option): guard findings take the reach tiers like advisories (`exposed` for public plus high or critical, `public_low`, `internal`, `not_deployed`), so a root container on a public app sorts next to a high advisory on the same app. The `kind=guard` filter and a "Guards" chip separate them when wanted. `unknown` level goes to `coverage`.

Desktop: `REACH_WEIGHT.released = 1`, the same weight as internal. Tier `released` for runtime scope findings, `dev` for dev scope (dev dependencies are not shipped in an installer). Image advisories rank exactly like lockfile advisories on that deployment.

### 2.5 Decisions on guard findings

| Decision | Applies to guards | Notes |
|---|---|---|
| Snooze until a date | yes | reopens early on escalation |
| Snooze until a new advisory | no (advisory only, the API returns 400 for guards) | |
| Accept with a reason | yes | for one finding; a later escalation reopens it |
| Turn off with a reason | yes, per deployment or per repo (Q4) | writes `check_overrides`; the finding moves to `accepted` with the override reason and actor user; future scans keep it accepted and keep its level and evidence current; deleting the override reopens it if the check still fails |
| Reopen | yes | |
| Bulk | yes, the existing bulk endpoints accept guard ids | |

Turning off is recorded as an `accepted` state with `stateReason` set from the override and a `turned_off` event, so no new state enum value is needed and every existing filter keeps working (Q3).

### 2.6 API

All schemas in `packages/shared/src/api.ts`.

- `GET /api/findings`: `kind` accepts `guard`; new filters `check` (comma separated `GUARD_CHECKS`), `level`, `release` (`true` for desktop rows). Each guard row carries `guardCheck`, `guardLevel`, `evidence`, `explanation`, `fixText`, `override` (when turned off).
- `GET /api/guards`: the check registry: id, title, what it reads, levels, per source capability (`coolify: full | partial | unknown`), counts per level.
- `GET /api/overrides`, `POST /api/overrides` `{ check, deploymentId | repoId, reason }`, `PATCH /api/overrides/:id` `{ reason }`, `DELETE /api/overrides/:id`.
- `GET /api/deployments/:id`: gains `guards` (one entry per check: level or pass, evidence, override) and `facts` (section 9.2).
- `GET /api/repos/:id`: gains `runtimePins` (every pin found, with file and line), `supportLines` (runtime and framework lines with dates), `release` (latest tag, date, installer assets, scanned at).
- `GET /api/overview`: gains `guardCounts` per check and level, and `windows` (lines ending soonest, top 5).
- `GET /api/shell/nav-counts`: `guards` (open warn plus fail on running deployments).
- `GET /api/support/status`: endoflife.date cache age, last fetch result, offline flag.
- `GET /api/settings` and `PATCH`: `supportWindowDays` (default 90, Q8), `imageScan` (`off` default, `coolify`, `sbom`), `releaseTier` (`auto` default, `off`).

### 2.7 UI

| View | Gains |
|---|---|
| Overview | a "Guards" card (counts per check, worst first), a "Support windows" strip (next lines to end, with dates) |
| Findings list | `Guard` kind chip, `check` and `level` filters, guard rows with the check title, the evidence one liner and the fix text on expand |
| Deployment detail | a "Guards" panel: one row per check with level or pass or unknown, the signal source ("from Dockerfile line 31"), and a "Turn off for this deployment" action with a required reason field |
| Repo detail | "Runtime" panel (pins table, the disagreement highlighted, the line's end of life date), "Release" panel for desktop repos (tag, date, assets, "fixed on the default branch, not released yet" counts) |
| Settings | "Checks" page: each check, what it reads, a list of active overrides with reason and who and when, window days, image scan mode, release tier mode |
| Sources | new source kinds (manual, Docker, Dokploy) with their own connection test and a capability table ("container user: yes / no") |

### 2.8 Notifications

Rules added to `docs/notifications.md`:

1. A guard finding that opens or reopens at `fail` on a running deployment is sent immediately, like a blind spot.
2. A guard finding that opens at `warn` goes to the daily digest (Q14). For `runtime_support` and `framework_support`, opening at `warn` is exactly "entered the warning window", so it happens once per line.
3. An `escalated` event (warn to fail, window to end of life) is sent immediately, once (dedupe per event and channel already holds).
4. `unknown` levels are never sent, like coverage notes.
5. Level improvements and every scan that finds the same level send nothing.
6. Image scan advisories follow the advisory rule (critical or high on a deployed thing, immediate).
7. Desktop advisories go to the digest only, unless critical (Q18).
8. The first scan or more than 10 items still collapse into one summary, so the first run of the guards on a big instance sends one message.

In `notify/items.ts` the `NotificationItem` kind gains `guard`, labels come from a `GUARD_LABELS` map next to `BLIND_SPOT_LABELS`, and `notifier.ts` treats `guard` at `fail` like `blind_spot` and `escalated` like `opened`.

## 3. The check framework

```ts
// apps/server/src/scan/guards/types.ts
export interface GuardResult {
  check: GuardCheck
  subject: { deploymentId: number } | { repoId: number }
  level: 'pass' | GuardLevel | null
  evidence?: GuardEvidence
}
export interface GuardContext {
  deployments: DeploymentRow[]          // with facts
  repos: RepoRow[]
  lockfiles: Map<number, ScannedLockfile[]>  // from the lockfile phase
  support: SupportIndex                 // endoflife.date, may be stale
  now: number
}
export type Guard = (ctx: GuardContext) => GuardResult[]
```

- One file per check under `scan/guards/`, each a pure function of the context, tested with fictional rows.
- `applyGuards(db, results, overrides, now)` mirrors `applyBlindSpots`: in one transaction, observe or update rows, apply overrides, mark passes fixed, write events.
- Explanation and fix text live in `packages/shared/src/guards.ts` as a map (title, explanation, fix steps, docs link), so the web and notifications render the same copy.
- Stopped deployments: checks still run (a stopped root container is still configured as root), but the finding ranks with `running = false`, which keeps it low.

## 4. Each check in detail

Sources of truth used below:
- Coolify application fields from the v4.x OpenAPI: `custom_docker_run_options`, `docker_compose_raw`, `dockerfile` (inline content), `dockerfile_location`, `base_directory`, `build_pack`, `git_commit_sha`, `git_branch`, `watch_paths`, `destination_id`, `destination_type`, `environment_id`, `settings` (ApplicationSetting: `is_auto_deploy_enabled`, `connect_to_docker_network`). Services: `docker_compose_raw`, `connect_to_docker_network`, `destination_id`, `server_id`. Storages: `GET /applications/{uuid}/storages` (also services and databases) returns `{ persistent_storages, file_storages }`; file storages have `fs_path` and `is_directory` (from the create schema); persistent storages are untyped in the spec.
- Coolify has **no field for the container user** and **no list of networks** per resource.
- Docker Engine API v1.47 container inspect: `Config.User`, `Config.Labels`, `Mounts[]` (`Type`, `Source`, `Destination`, `RW`), `HostConfig.Binds`, `HostConfig.Privileged`, `HostConfig.NetworkMode`, `NetworkSettings.Networks` (map keyed by network name).

### 4.1 `root_user`

**Question:** does the main process run as root?

Signal, in precedence order (the first that answers wins):

| Source | Field | Reading |
|---|---|---|
| Docker labels source | inspect `Config.User` | `""`, `root`, `0`, `0:0`, `root:*` mean root; anything else is not root. Authoritative, it is the running value. |
| Coolify, any build pack | `custom_docker_run_options` | `--user X`, `--user=X`, `-u X` (tokenised like a shell line, quotes respected) |
| Coolify, compose (`build_pack` dockercompose, and services) | `docker_compose_raw` | `services.<name>.user` per service; a service without `user:` falls through to its image or build |
| Coolify, `build_pack` dockerfile | `dockerfile` (inline) if non empty, else the file at `base_directory` + `dockerfile_location` fetched from the repo at `git_commit_sha` when it is a 40 character hex sha, else `git_branch` | the last `USER` in the final stage |
| Coolify, nixpacks, static, image only | none | `unknown` with "this build pack does not say which user the container runs as" |

Dockerfile reading (`packages/shared/src/dockerfile.ts`, also used by the runtime check):
- Split into stages at `FROM`; handle `FROM x AS name`, line continuations, comments, parser directives, `ARG` before the first `FROM` and inside stages, `${VAR}` and `${VAR:-default}` substitution from ARG defaults only (build args passed by the platform are not visible).
- The final stage is the last `FROM`, unless the deployment has a target stage (`dockerfile_target_build` in Coolify), then that stage.
- In the final stage, the last `USER` wins. A value with an unresolved variable is `unknown`.

States and texts:

| Level | When | Explanation | Fix |
|---|---|---|---|
| fail | user resolves to root | "The container runs as root. A bug in the app or a dependency gets root inside the container, and any host mount or socket becomes a root foothold." | "Add a non root user in the final stage and switch to it: `RUN addgroup -S app && adduser -S app -G app` then `USER app`, or set `--user 1000:1000` in the platform's run options. Make sure files the app writes are owned by that user." |
| warn | final stage has no `USER` and no override | "No USER is set, so the container runs as the base image's user. Most official base images run as root." | same as above |
| pass | non root user resolved, or the base image tag ends in `nonroot` and no USER resets it | | |
| unknown | no signal | "This source does not report the container user." | "Add a USER line to the Dockerfile or connect a Docker host source." |

False positive risks: images that drop privileges at runtime (an entrypoint that `exec`s `gosu` or `su-exec`, for example many database images) look like root; they are the reason `accept` and turn off exist. Databases managed by Coolify are excluded by default (their images are not built by the user, and the check would be noise). A `USER` set through a build arg that the platform passes in reads as unknown, not fail.

Tests (fictional): `kestrel-api` Dockerfile with `FROM node:22-alpine AS build`, then `FROM node:22-alpine`, `USER node` in the final stage passes; the same file with `USER node` only in the build stage warns; `--user 0` in run options fails even with `USER node`; compose service `worker` with `user: "1000"` passes and `web` without `user:` and `image: nginx:1.27` warns; nixpacks app is unknown; Docker source with `Config.User: ""` fails; `ARG APP_USER` without default plus `USER ${APP_USER}` is unknown; multi-line `FROM` with `--platform=$BUILDPLATFORM`.

### 4.2 `docker_socket`

**Question:** is the Docker daemon socket mounted into the container?

| Source | Field | Reading |
|---|---|---|
| Docker labels | inspect `Mounts[].Source` and `HostConfig.Binds` | source is `/var/run/docker.sock`, `/run/docker.sock`, or a directory containing it (`/var/run`, `/run`) |
| Coolify | `custom_docker_run_options` | `-v SRC:DST`, `--volume`, `--mount type=bind,source=SRC` (also `src=`) |
| Coolify | `docker_compose_raw` | `services.*.volumes` short form `SRC:DST[:ro]` and long form `{ type: bind, source }` |
| Coolify | storages `file_storages[].fs_path`; `persistent_storages[].host_path` | match the same paths. `host_path` is not in the spec: confirm it on a live response while building; until then only `fs_path` counts and the evidence says so |

Level: `fail` only (read only mounts too: `:ro` on the socket still allows every API call). Pass when no mount matches. `unknown` only for the manual list source.

Explanation: "The Docker socket is mounted. Anyone who gets code execution in this container controls the Docker daemon, which is root on the host, even when the mount is read only." Fix: "Remove the mount. If the app needs container data, put a socket proxy in front that allows only the GET endpoints it needs, and mount nothing else."

False positives: deliberate infrastructure containers (a reverse proxy, a monitoring agent, a socket proxy itself). Those are the turn off with reason case; the settings page lists them with their reasons so the exception is visible. Coolify's own proxy is not a Coolify resource, so it is not in the inventory.

Tests: run options `-v /var/run/docker.sock:/var/run/docker.sock:ro` fails; `--mount type=bind,source=/run/docker.sock,target=/sock` fails; compose long form fails; `/var/run/docker.sock.bak` passes; `/var/lib/app:/data` passes; a named volume `docker:/data` passes; Docker source `Mounts[{Type:'bind',Source:'/var/run'}]` fails.

### 4.3 `shared_network`

**Question:** can this container reach containers of an unrelated project over a shared Docker network?

Coolify does not list networks per resource. What it does give:
- `destination_id` and `destination_type` on applications (and databases), `destination_id` and `server_id` on services.
- `GET /servers/{server_uuid}/destinations` returns `{ uuid, name, network, type, server_uuid }` but **no integer id**, so the integer `destination_id` cannot be joined to a network name from the API. The check therefore groups by the integer, not the name.
- `environment_id` on applications; `GET /projects/{uuid}/environments` maps environments to `project_id`, which gives a project key per resource.
- Services get their own compose network unless `connect_to_docker_network` is true; applications follow `settings.connect_to_docker_network` the same way for compose based apps.
- `custom_docker_run_options` `--network X` and compose `networks:` with `external: true` name extra networks.

Rule (Coolify): two resources share a network when they have the same `(server, destination_type, destination_id)` and are attached to the destination network (applications built from a Dockerfile, nixpacks or image are attached; compose apps and services only when `connect_to_docker_network`), or when they name the same external network. The finding fires when a resource shares a network with a resource from **another project**. Level `fail` when one of the other resources is a database, `warn` otherwise.

| Source | Reading |
|---|---|
| Docker labels | inspect `NetworkSettings.Networks` keys; group containers by network, ignore `none` and `host` (host gets its own finding text: "uses the host network"); project key from `com.docker.compose.project`, else the `hinomi.project` label, else the container name |
| Coolify | rule above |
| Dokploy | to verify: application and compose network fields; until then `unknown` |
| Manual | `unknown` |

Explanation: "This container is on the same Docker network as `kestrel-billing-db` from another project. A compromise here can reach that database directly, without going through its domain." Fix: "Put each project on its own destination (its own network), or turn off the shared network for compose resources. Connect projects only through their public endpoints."

False positives: resources that are meant to talk across projects (a shared cache). The grouping relies on Coolify attaching resources to the destination network; if a user moved containers by hand on the host, the API cannot see it (the Docker source can). The default `coolify` destination on a single server puts everything together, so the first scan on such an instance flags most resources: that is true, and the first scan summary rule keeps it to one message.

Tests: two apps from projects `kestrel-shop` and `kestrel-blog` on destination 3 of `edge-1` warn; add a postgres database from `kestrel-shop` and the `kestrel-blog` app fails; a service with `connect_to_docker_network: false` passes; same project on the same destination passes; `--network shared-cache` on two apps of different projects warns; Docker source with `NetworkMode: host` gives the host text.

### 4.4 `watch_paths_skip`

**Question:** will a change to the Dockerfile or a lockfile not trigger a deploy because the watch paths skip it?

This reuses the fix runner's matcher. `watchPathRegExp` and `watchPathsTrigger` move from `runner/verify.ts` to `packages/shared/src/watch-paths.ts` (Coolify rules: patterns in order, `!` negates, last match wins, `**` crosses folders, no patterns watch everything); `runner/verify.ts` imports them from there, so the fix run warning and the guard share one implementation, as section 6.3 of the fix runner design promised.

Signal: Coolify `watch_paths` (already stored as `deployments.watchPaths`), `settings.is_auto_deploy_enabled`, `base_directory`, `dockerfile_location`, plus the lockfile and manifest paths the lockfile phase found for the repo (`manifestPaths` on findings, or the scanned lockfile list). Files checked: the Dockerfile path, every lockfile and its manifest (for example `apps/api/package.json` and `pnpm-lock.yaml`), and `.nvmrc` or other runtime pins found by section 5.

| Level | When |
|---|---|
| warn | auto deploy on, watch paths non empty, and at least one checked file does not trigger |
| pass | no watch paths, auto deploy off (evidence notes it), or every file triggers |
| unknown | the source has no watch paths concept (Docker labels, manual) |

Explanation: "Watch paths `apps/api/src/**` do not include `pnpm-lock.yaml` or `apps/api/Dockerfile`. A security bump that only changes the lockfile will merge without deploying, and the old version keeps running." Fix: "Add the lockfile and the Dockerfile to the watch paths, for example `apps/api/**`, `pnpm-lock.yaml`, `package.json`."

False positives: monorepos where the lockfile is deliberately excluded because another deploy hook handles it. Accept or turn off.

Tests: patterns `apps/api/src/**` with files `pnpm-lock.yaml`, `apps/api/Dockerfile` warns listing both; `apps/api/**` plus `pnpm-lock.yaml` passes; `**` then `!**/*.lock` warns on `Cargo.lock`; empty patterns pass; auto deploy off passes.

### 4.5 `framework_support`

**Question:** is a framework the app runs on on a release line that has lost, or is about to lose, security support?

Definition (Q6, recommended): a "framework" is any direct runtime dependency whose package matches an endoflife.date product identifier. The API publishes purls per product (checked: `nextjs` has `pkg:npm/next`, `nestjs` has `pkg:npm/%40nestjs/core`, `django` has `pkg:pypi/django`, `laravel` has `pkg:composer/laravel/framework`, `rails` has `pkg:gem/rails`, `express` has `pkg:npm/express`). `GET /api/v1/identifiers/purl` lists all of them (984 identifiers today). So no hand kept framework list.

Mapping a version to a release line: endoflife.date release names are a prefix of the version (`16` for Next.js 16.4.5, `6.1` for Django 6.1.3, `8.0` for Rails 8.0.5.2). Pick the longest release name that is a dotted prefix of the installed version.

| Level | When |
|---|---|
| fail | the line has `isEol` true, or `eolFrom` is in the past |
| warn | `eolFrom` within `supportWindowDays` |
| pass | maintained and outside the window, or no `eolFrom` announced |
| unknown | installed version matches no release name |

`isEoas` (end of active support, bug fixes only) is shown in the evidence but does not raise a level: security support is what matters.

Subject: each deployment of the repo when the dependency is runtime scope; the repo when nothing is deployed (then it ranks `none` and tiers `not_deployed`).

Explanation: "Next.js 15 (installed 15.5.29) loses security support on 2027-01-31, in 84 days." Fix: "Upgrade to a supported line (16, latest 16.4.5). Follow the framework's upgrade guide."

Q7 asks whether "behind the latest patch of its line" should also produce a low level. Recommended: no, because a missing security patch already shows up as an advisory finding; the support line is the new information.

False positives: endoflife.date dates that differ from a vendor's paid support (we show the source and date); dev only frameworks are excluded by scope.

Tests: fictional `kestrel-web` lockfile with `next@15.5.29`, `now = 2026-11-08`, fixture product with `eolFrom 2027-01-31` warns; `next@14.2.35` with `isEol` fails; `django@6.1.3` matches `6.1` not `6`; a package with no product match produces nothing; dev scope `vitest` produces nothing.

### 4.6 `archived_deployed`

Already a blind spot (`REPO_BLIND_SPOTS`, high). It stays a blind spot (Q5): it is about lost coverage (no more fixes upstream), and its rows and history already exist. What changes: the override table accepts `archived_deployed`, so it can be turned off per deployment with a reason ("archived on purpose, frozen internal tool"), and the deployment detail lists it in the guards panel next to the guard checks.

### 4.7 Runtime checks

`runtime_support`, `runtime_pins_disagree` and `action_runtime` are specified in section 5.

### 4.8 Candidate checks not in v0.3

Cheap later, all from fields already read: `privileged` (`HostConfig.Privileged`, `--privileged` in run options, compose `privileged: true`), `host_network` (folded into the network check text today), base OS end of life from the `FROM` tag suffix (`bookworm`, `alpine3.20`) through the endoflife.date `debian` and `alpine` products, or from Coolify's scan `eol` flag.

## 5. Runtime support windows (#87)

### 5.1 Sources per repo

Node first (Q12 asks about Python, Go, Ruby, PHP, Bun, Deno in the same release; the parser layer is generic, each runtime is a table entry).

| Source | Where | Example | What it gives |
|---|---|---|---|
| `.nvmrc`, `.node-version` | repo root and each app folder the lockfile scan already visits | `22`, `v22.11.0`, `lts/jod` | a line; `lts/<codename>` maps through the endoflife.date `codename` field; `lts/*` and `node` float |
| `.tool-versions` | same | `nodejs 22.11.0` | a line |
| `mise.toml`, `.mise.toml` | same | `[tools] node = "22"` | a line |
| `package.json` `volta.node` | same | `"22.11.0"` | a line |
| `package.json` `engines.node` | same | `">=20 <23"` | a range, the floor is used for the window check |
| `package.json` `devEngines.runtime` | same | `{ "name": "node", "version": "22" }` | a line |
| Dockerfile `FROM` | the deployed Dockerfile (section 4.1), and any `Dockerfile` the lockfile walk finds | `node:22-alpine`, `node:22.11-bookworm-slim`, `node:${NODE_VERSION}`, `node:lts`, `node@sha256:...` | a line for the image's `node` repository (also `library/node`, registry prefixed mirrors); `lts`, `current`, `latest` float; a digest without a tag is unknown |
| `actions/setup-node` in `.github/workflows/*.yml` | repo | `node-version: 22`, `node-version-file: .nvmrc`, `${{ matrix.node }}` | a line per job; a matrix expands from literal lists; an expression it cannot resolve is unknown |
| `action.yml` `runs.using` | the repo itself when it is an action | `node20` | the action runtime |
| Used actions | each `uses: owner/repo@ref` in workflows | `runs.using: node20` in their `action.yml` | the runtime of each action the repo depends on |

Files are fetched with the same contents API calls the lockfile phase uses (same token, same `?ref=`), only for paths that exist in the listing it already does, so a repo without these files costs nothing extra. Workflow files need one listing of `.github/workflows`.

Each pin is stored in `runtime_pins` (migration 0014): `repo_id`, `ref` (branch or release tag), `runtime`, `source` (enum of the rows above), `path`, `line`, `raw`, `line_name` (resolved, nullable), `floating` (bool), `scanned_at`. The repo detail renders it; the checks read it.

### 5.2 Parsing

- Pure parsers in `packages/shared/src/runtime-pins/` (one per source), each `(text, path) => Pin[]` with line numbers. No YAML library is needed for workflows beyond the `yaml` package the server already depends on.
- Normalise to the endoflife.date release name: Node majors (`22`), Python `3.12`, Go `1.23`, Ruby `3.3`, PHP `8.3`.
- Floating values (`lts`, `lts/*`, `latest`, `node` in nvm, `current`) resolve at scan time to today's line and are marked `floating`; they never count in the disagreement rule and never fail the window check (a floating pin moves on by itself), but the evidence says what it resolved to.
- Docker image references: parse `[registry/][namespace/]name[:tag][@digest]`; the runtime is known when the last path part is `node` (or `python`, `golang`, `ruby`, `php`, `oven/bun`, `denoland/deno` later); the tag's leading numeric part gives the line (`22-alpine` gives 22, `22.11-bookworm-slim` gives 22).
- `runs.using`: `node12`, `node16`, `node20`, `node24` map to Node lines; `docker` and `composite` give nothing (a composite action is followed one level to its own `uses:`).

### 5.3 Caching endoflife.date

- API: `https://endoflife.date/api/v1`. Responses carry an `ETag` and `last_modified`; the server answers `304` to a conditional request, may answer `301` (followed, for example `ruby-on-rails` to `rails`), and `429` with `Retry-After`. 404 bodies are HTML, so non JSON is treated as "not found". Data licence MIT.
- One fetch per day of `GET /api/v1/products/full` (about 3 MB, all 489 products with releases and identifiers) with `If-None-Match` (Q11). Stored compressed in a new `http_cache` table (migration 0013): `key`, `etag`, `last_modified`, `fetched_at`, `status`, `body` (gzip blob). An in memory index (purl to product, product to releases) is rebuilt on each change.
- Offline: if the fetch fails, the last copy is used and `GET /api/support/status` reports its age; after 7 days stale the support checks still run but a single coverage style banner says "support dates are N days old". Never empty: a fresh install with no network has no copy, so support checks return `null` (leave rows alone) until the first fetch succeeds.
- No fetch at all when no repo has a pin or a matching framework (inert until needed).
- The same table caches `action.yml` reads: key `action:{owner}/{repo}@{sha}` forever (a sha is immutable), `@{tag}` for a day.

### 5.4 Window states

Per pin's line: `fail` when `isEol` or `eolFrom` passed, `warn` when `eolFrom` is within `supportWindowDays` (default 90, Q8), `pass` otherwise, `unknown` when the line is not in the product (for example a typo, or a line newer than the cached copy, which then says "not in the support data yet").

`runtime_support` is one finding per repo per runtime, at the worst level among the **deployed or default** pins (precedence for "what runs in production": the final stage `FROM` of a deployed Dockerfile, then version files (`.nvmrc`, `.node-version`, `.tool-versions`, `mise.toml`, `volta`, `devEngines`), then the `engines` floor). CI pins only matter through the disagreement rule, so an old CI matrix entry does not page anyone.

`action_runtime` is one finding per repo: `fail` when any used action or the repo's own `action.yml` declares a Node line past end of life (`node20` after 2026-04-30), `warn` inside the window; evidence lists each action and workflow line.

### 5.5 Disagreement rule

`runtime_pins_disagree` (warn, low) fires when the non floating pins of one runtime in one repo resolve to more than one line, with these exceptions:
- A range (`engines`) disagrees only if a pinned line does not satisfy it.
- CI matrix entries are allowed to span lines if the production line is one of them (testing on several lines is good practice); the rule fires only when no CI job uses the production line.
- Build stages of a Dockerfile other than the final one are allowed to differ only if they are pure build stages (no `COPY --from` of `node_modules` into the final stage); otherwise they must match, because native modules built on one line can break on another.

Explanation: "Node pins disagree: Dockerfile runs 22, CI tests on 20 only, `.nvmrc` says 24." Fix: list each file and line with the target line.

### 5.6 Fix hint files

Every runtime finding carries `fixHints`: `{ path, line, from, to }[]`, built from the pins, with the target being the newest line that is `isLts` and maintained (for Node), or the next maintained line for runtimes without LTS. Example:

```
.nvmrc:1                          22            -> 24
apps/api/Dockerfile:1             node:22-alpine -> node:24-alpine
.github/workflows/ci.yml:18       node-version: 22 -> 24
package.json:41 (engines.node)    >=22          -> >=24
```

The UI shows them as a checklist with copy buttons.

### 5.7 Can the fix runner open the bump PR later?

Yes, with three constraints, so it is a later slice, not v0.3:
1. It needs a new plan kind (`runtime_bump`) and FixPlan contract version 2: text edits on named files instead of package bumps. The patch allowlist widens to exactly the hint paths.
2. Workflow files cannot be pushed with the run's `GITHUB_TOKEN` (pushing a change under `.github/workflows` needs the `workflows` permission, which that token does not have). Options then: leave workflow lines as hints in the PR body, or push with Hinomi's own credential when it has Workflows write. Recommended: hints in the body (Q24).
3. A runtime bump usually needs a reinstall (native modules) and the repo's CI is the real check, so the PR always opens as a draft.

## 6. Image scan for image only deployments (#67)

Off by default (`imageScan: 'off'`). When a mode is on and a deployment is covered, its `image_only` coverage note resolves with `resolvedData: { coveredBy: 'image_scan', mode }`.

### 6.1 Options

| | A. Coolify's own scan results | B. Trivy or Grype sidecar | C. Registry SBOM attestations | D. OSV on an SBOM |
|---|---|---|---|---|
| What it is | read `GET /applications/{uuid}/vulnerabilities` (also services, databases) and `GET /servers/{uuid}/image-scanning` | a second container that pulls each image and scans it; Hinomi calls it (Trivy has a client and server mode; Grype is a CLI) | fetch the image index from the registry, find an SPDX or CycloneDX attestation, read packages | send packages (from C, or from an SBOM a user uploads) to OSV `querybatch` with OS ecosystems (`Debian:12`, `Alpine:v3.20`, `Ubuntu:24.04:LTS`) |
| New infra | none | a container, a vulnerability DB on disk (hundreds of MB), image pulls (bandwidth, disk) | none (HTTP to registries) | none (OSV client exists) |
| Fits "one container, inert until configured" | yes | no, optional profile only | yes | yes |
| Private images | Coolify already pulled them | registry credentials in Hinomi | registry credentials in Hinomi (read only pull token) | n/a |
| Coverage | every resource Coolify scans, the image that actually runs | everything | only images published with attestations; self built images usually have none unless built with SBOM output | as good as the SBOM |
| Data per finding | id, aliases, title, severity, package, version, package type, fixed in, state (fixed, no fix, ignored), KEV flag, EPSS, risk, CVSS, advisory URL, image ref | full | packages only | OSV advisories, server side matching |
| Availability | only newer Coolify builds; the first release that has it is unknown, detect by 404 on the endpoint or `is_image_scanning_allowed` false | always | depends on the publisher | always |
| Permissions | the scanning settings endpoint needs team admin or owner; the vulnerability list is read | n/a | pull | n/a |
| Licence | n/a (HTTP API) | Trivy, Grype, Syft: Apache 2.0, compatible with AGPL as a separate process | n/a | OSV API; OSV-Scanner is Apache 2.0 |
| Effort | small | large | medium | medium (OS version compare must be left to OSV: the local affected check skips OS ecosystems) |

**Recommendation: A first, then C plus D as the fallback for non Coolify sources, B documented only.** A costs one read per covered resource, uses the image that actually runs, and needs nothing installed. C plus D gives the Docker labels, Dokploy and manual sources a path without a scanner. B is the heaviest and duplicates what A already does on Coolify; a compose profile in the docs is enough for users who want it (Q15).

### 6.2 Mapping Coolify results

- Each `findings[]` entry becomes an advisory row: `advisoryKey` = the GHSA alias if present, else `display_id` or `id`; `cveIds` from aliases; `ecosystem` from `package_type` (`deb`, `apk`, `rpm`, `npm`, `gomod`...) mapped to OSV names where they exist, else kept as given; `packageName` = `package`; `firstPatchedVersion` = `fixed_in`; severity mapped (`medium` to moderate, `unknown` stays unknown); `cvssScore`.
- The finding: kind `advisory`, `reportedBy ['image']`, `deploymentId` set, `repoId` null for image only deployments, `installedVersion` = `version`, `scope` runtime, `evidence { imageRef, scannedAt, kev, epss }`.
- Coolify `state` `ignored` maps to Hinomi `accepted` with reason "ignored in Coolify" (system actor) on first sight only; later Hinomi decisions win. `no_fix` stays open with "no fix available" shown.
- `truncated: true` on an image means Coolify capped the list: a coverage note on that deployment says the result is partial.
- `SecurityStatus.eol` (end of life base OS) feeds the base OS candidate check later (4.8).
- Applies to image only deployments first (issue scope); a setting can extend it to every Coolify resource later, which would then also cover OS packages under built images.

### 6.3 Tests

Fictional `static-docs` image only app on `edge-1` with a vulnerabilities fixture (two findings, one KEV, one `ignored`, one `truncated` image); a 404 fixture (old Coolify) leaves the coverage note and shows "not available on this Coolify version"; a 403 on the scanning settings endpoint is reported as "needs team admin to read scan status" and the list is still read.

## 7. Desktop tier (#68)

### 7.1 Detecting "released, not deployed"

- Candidate: a repo in the inventory with no deployment joined (no `deployments.repoId` match, stopped ones included: a stopped deployment means "deployed somewhere", not "released").
- `GET /repos/{owner}/{repo}/releases/latest` (excludes drafts and prereleases; 404 means no release). Once a day per candidate, not every scan; result stored on `repos` (migration 0015): `release_tier` (`auto`, `on`, `off`), `latest_release_tag`, `latest_release_at`, `release_installers` (bool), `release_checked_at`.
- `auto` treats the repo as released when the latest release has installer like assets: `.dmg`, `.pkg`, `.exe`, `.msi`, `.msix`, `.AppImage`, `.deb`, `.rpm`, `.flatpak`, `.apk`, `.aab`, or `.zip`/`.tar.gz` whose name contains a platform word (`mac`, `darwin`, `win`, `linux`, `x64`, `arm64`, `universal`). A release with only source archives is a library release, not something in users' hands (Q16). `on` and `off` override per repo.

### 7.2 Which version is in users' hands

The latest release tag. `fetchLockfiles(owner, repo, tag, token)` already takes any ref, so the existing lockfile walk runs at the tag, then `scanDependencies` through OSV (Dependabot alerts only cover the default branch, so OSV is the only path for a tag). Q17 asks whether the last N releases should count too (auto updaters do not reach everyone).

- No lockfile at the tag: coverage note `release_lockfile_missing`.
- Findings: `releaseAdvisoryFindingKey`, `release_tag` set, `scope` from the lockfile (runtime or dev).
- "Fixed on the default branch, not released yet": when the default branch lockfile (already scanned for this repo) no longer has the vulnerable version, the release finding shows that line and the repo detail counts them. It stays open, because users still run the old build.
- Electron, Tauri and similar apps: their framework line goes through `framework_support` with the tag's lockfile (endoflife.date has these products; confirm slugs while building).
- Runtime pins at the tag feed `runtime_support` with `ref = tag`.

### 7.3 Ranking

`REACH_WEIGHT.released = 1`, tier `released` for runtime scope, `dev` for dev scope. So a critical advisory in a released desktop app ranks with internal deployments: above public low severity, below anything exposed publicly. Notifications: digest only, critical immediately (Q18).

Tests: fictional `kestrel-desk` with release `v2.3.0` assets `Kestrel-2.3.0-universal.dmg` and `Kestrel-Setup-2.3.0.exe` is released; `kestrel-lib` with only source archives is not; a repo with a deployment is never in the tier; tag lockfile fixture with `electron@30.0.0` gives a fail framework finding with fixture dates; the default branch fixture with the patched version shows "fixed on main, not released".

## 8. More lockfile ecosystems (#70)

Every parser is a pure function returning `LockfileDependency[]`, line by line like `cargo.ts` (no TOML library: the formats use a fixed subset). `LOCKFILE_NAMES` and `parseLockfile`'s switch grow; `osvEcosystemSchema` widens; `fetchLockfiles` learns the names.

| Format | File(s) read | Parser notes | Direct and scope | Paths | OSV ecosystem |
|---|---|---|---|---|---|
| Go | `go.mod` (primary), `go.sum` (presence only) | since Go 1.17, `go.mod` lists every module needed to build the main module's packages, with the selected version; `require` blocks, `// indirect` marks indirect; `replace` directives rewrite path and version (local path replaces are dropped); `go.sum` lists hashes for versions that may not be selected, so it is not used for versions (Q20) | direct = no `// indirect`; scope `unknown` (Go has no dev dependencies; test only modules are not marked) | `[module]` for direct, none for indirect (the graph needs the toolchain) | `Go`; versions sent without the leading `v` is the expected form, confirm with a fixture against the API |
| Go stdlib | `go.mod` `toolchain go1.23.4`, else `go 1.23.4` | one dependency `stdlib` at that version | runtime | none | `Go` package `stdlib` |
| uv | `uv.lock` | `[[package]]` with `name`, `version`, `source`, `dependencies = [{ name = ... }]`, `[package.optional-dependencies]`, `[package.dev-dependencies]`; the project itself has `source = { editable = "." }` or `virtual` | direct = dependencies of the root package; dev = reachable only through `dev-dependencies` groups | yes, graph walk like `graph.ts` | `PyPI` (OSV normalises names per PEP 503) |
| Poetry | `poetry.lock` plus `pyproject.toml` | `[[package]]` with `name`, `version`, `[package.dependencies]`; Poetry 1.x had `category = "main" / "dev"`, 2.x has `groups = [...]`; direct from `pyproject.toml` (`[tool.poetry.dependencies]`, `[tool.poetry.group.*.dependencies]`, `[project] dependencies`) | from groups or category | yes | `PyPI` |
| pip | `requirements.txt`, `requirements/*.txt` one level | only `name==version` (and `===`) lines; extras `name[x]==1.0`; environment markers kept; `-r other.txt` followed once; `-e`, URLs, `>=` ranges are not a version (Q19: a coverage note "N unpinned requirements not checked") | all direct; scope runtime unless the file name contains `dev` or `test` | none | `PyPI` |
| Composer | `composer.lock` | JSON `packages` (runtime) and `packages-dev` (dev); `require` per package gives the graph; direct from `composer.json` `require` and `require-dev` | yes | yes | `Packagist` |
| Bundler | `Gemfile.lock` | `GEM` section `specs:` with 4 space indent for gems and 6 space indent for their dependencies; `DEPENDENCIES` section lists direct gems; platform suffixes (`nokogiri (1.16.5-x86_64-linux)`) strip to the version | direct from `DEPENDENCIES`; scope `unknown` (Bundler groups live in the Gemfile, not the lock) | yes | `RubyGems` |

Test fixtures: one small and one realistic fictional lockfile per format under `apps/server/src/sources/osv/lockfiles/fixtures/` (a `kestrel-api` Go module with a replace and an indirect, a uv project with a dev group, a Poetry 1.x and a 2.x lock, a requirements file with markers, includes and an unpinned line, a Laravel style composer lock, a Rails style Gemfile lock with platform gems), plus an OSV client test per ecosystem with a recorded response.

Fix runner later (out of scope now): Composer and uv are the easiest next appliers (lock regeneration is a single command with a pinned target); Poetry and Bundler next; pip only when the file holds the pin; Go needs `go get module@version` plus `go mod tidy` and the stdlib bump is a toolchain change (runtime bump, section 5.7). `scan/targets.ts` `osvEcosystemOf` must return "not supported by the fix runner" for the new ecosystems so plans skip them cleanly instead of failing.

## 9. Deployment source interface (#71)

### 9.1 The interface

```ts
// apps/server/src/sources/deployments/types.ts
export interface DeploymentSource {
  kind: DeploymentSourceKind              // 'coolify' | 'docker' | 'dokploy' | 'manual'
  capabilities: SourceCapabilities
  test(): Promise<ConnectionTestResult>
  inventory(): Promise<DeploymentRecord[]>
  deployHistory?(externalId: string): Promise<DeployEvent[]>
  imageFindings?(externalId: string): Promise<ImageScanResult | null>
}
export interface SourceCapabilities {
  facts: ReadonlySet<FactKey>             // which of user, mounts, networks, runOptions, dockerfile, watchPaths, autoDeploy, project
  domains: boolean
  status: boolean
}
```

`SOURCE_KINDS` grows to `['coolify', 'github', 'osv', 'docker', 'dokploy', 'manual']`. `deploymentRecordSchema` (today in `sources/coolify.ts`) moves to `packages/shared/src/sources/deployment.ts`, gains `facts`, and Coolify becomes the first implementation. The scan's deployments phase loops over every enabled deployment source; `externalId` is unique per source (the existing `sourceId` plus `externalId`). Guards read `capabilities.facts`: a missing fact gives `unknown`.

### 9.2 What the join and the guards need

| Field | Join needs | Coolify | Docker labels | Dokploy | Manual |
|---|---|---|---|---|---|
| `externalId`, `name`, `kind` | yes | uuid, name, application/service/database | container id or compose project plus service, name | application or compose id (`application.one`, compose routes) | user given |
| repo (`owner/name`) | yes, the join | `git_repository` | `org.opencontainers.image.source` label (a standard OCI label), else `hinomi.repo` | to verify: git provider fields on the application (`customGitUrl` and provider specific fields) | user given |
| branch | nice | `git_branch` | `hinomi.branch` | to verify | optional |
| image | coverage, image scan | registry image and tag | `Config.Image` | to verify: `dockerImage` | optional |
| domains, reach | ranking | `fqdn` | `hinomi.domains`, else router labels of the reverse proxy (`Host(...)` rules); published ports on `0.0.0.0` count as public | domains routes, to verify | user picks reach |
| server | grouping | server name | the Docker source's name | server | optional |
| status | stopped handling | `status` | `State.Status` | to verify | `unknown` |
| lastDeployAt | nice | deploy history | `Created` / `State.StartedAt` | to verify | none |
| watchPaths, autoDeploy | `watch_paths_skip` | yes | no | watch paths exist for applications and compose; field names to verify | no |
| user, mounts, networks, runOptions, dockerfile, project | guards | partial (section 4) | full from inspect | to verify | none |

`deployments.facts` (json, migration 0016) stores the normalised facts so guards never call a source.

Coolify fetch cost: storages and settings need per resource calls. They are refetched only when the resource's `updated_at` changed since the last scan; environments to projects once per scan (one call per project). Dockerfiles are fetched from GitHub only for `build_pack` dockerfile apps without an inline `dockerfile`, cached by commit sha (Q10).

### 9.3 Docker labels

- Connection: a Unix socket path or a TCP URL with TLS client certificates. The doc recommends a socket proxy allowing only `GET /containers/json`, `GET /containers/{id}/json`, `GET /networks`, `GET /version`, `GET /_ping` (Q21). Raw socket access, even mounted read only, is full control of the daemon and therefore root on the host: the connection test detects it (a `POST` to a harmless endpoint that a proxy would reject is **not** sent; instead the test reads `GET /info` and, if it works, says "this connection allows more than Hinomi needs, put a GET only proxy in front"). Plain TCP without TLS is refused.
- Inventory: `GET /containers/json?all=1&filters={"label":["hinomi.enable=true"]}` when `opt_in` is set (default), else every container; then inspect each. Compose services group by `com.docker.compose.project` and `com.docker.compose.service` into one deployment per service.
- Native fetch over a Unix socket: Node's `fetch` cannot take a socket path directly; use `undici`'s Agent with `connect.socketPath` (undici is Node's own fetch implementation, but it is a separate package import; acceptable, or `node:http` with `socketPath` in a small hand written helper, which is the house preference). Recommended: the `node:http` helper, about 40 lines, tested with a fake socket server.
- Self check: if Hinomi itself runs on that host, its own container is skipped by its container id.

### 9.4 Dokploy

- API base `/api`, header `x-api-key`, tRPC style routes (`project.all`, `application.one`, compose routes).
- `project.all` returns database records with `databasePassword` and `databaseRootPassword` in plain text, and no read only API key scope exists. A key that can read the inventory can also deploy, delete and read secrets.
- So: Hinomi never stores those fields (the client strips every key matching `/password|secret|token|key/i` from responses before anything is logged or kept, and reads per application routes where it can instead of `project.all`), the source form shows a red warning that the key is full access, and the docs suggest a dedicated Dokploy user. Q22 asks whether to ship it in v0.3 at all.
- Fields for facts (mounts, network, watch paths names, docker image, git source) must be confirmed against a live instance while building; until then those facts are not in `capabilities` and the guards say unknown.

### 9.5 Manual list

- `POST /api/sources` kind `manual`, then `POST /api/deployments` (manual only) with `name`, `repo`, `branch`, `image`, `domains`, `reach`, `server`; edit and delete; a YAML import of the same shape (Q23).
- Capabilities: none of the facts; guards are unknown except `framework_support` and `runtime_support`, which come from the repo.
- Status `unknown` ranks as running (a manual entry exists because it runs).

## 10. Migrations

Starting at 0011 (the last is `0010_repo_sources`). Drizzle text enums have no CHECK constraint in SQLite, so widening `SOURCE_KINDS`, `FINDING_KINDS` and `REPORTERS` needs no migration; confirm in the generated SQL of 0000 while building.

| # | Name | Contents | Slice |
|---|---|---|---|
| 0011 | `guard_findings` | `findings`: `guard_check`, `guard_level`, `evidence`, `release_tag`; index on (`kind`, `guard_check`) | 2 |
| 0012 | `check_overrides` | the overrides table | 2 |
| 0013 | `http_cache` | key, etag, last_modified, fetched_at, status, body (blob) | 8 |
| 0014 | `runtime_pins` | the pins table, index on (`repo_id`, `runtime`) | 9 |
| 0015 | `repo_releases` | `repos`: `release_tier`, `latest_release_tag`, `latest_release_at`, `release_installers`, `release_checked_at` | 19 |
| 0016 | `deployment_facts` | `deployments`: `facts` (json), `facts_updated_at`, `image_scanned_at`; `sources`: `config` (json, for socket path, TLS material references, opt in flag) | 3 |

Six migrations. 0011 and 0012 could be one; kept apart so the overrides table can be reviewed on its own. No data migration: existing rows keep `guard_*` null.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The shared network rule assumes Coolify attaches resources to the destination network; a setup changed by hand on the host looks different | evidence says "from Coolify destination grouping"; the Docker source shows the real networks; accept or turn off |
| First guard scan floods a big instance | the existing first scan and more than 10 items summary rule; warn levels go to the digest |
| `host_path` on persistent storages is not in the OpenAPI spec | count only `fs_path` until a live response confirms it, and say so in the evidence |
| endoflife.date down or changed | daily cache, offline from the last copy, stale banner after 7 days, schema validated with zod and a failed parse keeps the last good copy |
| Dockerfile fetches add GitHub calls | only for Dockerfile build pack apps without inline content, cached by commit sha |
| Dokploy key is full access and the API returns secrets | strip secret looking keys on receipt, warning in the form, optional in v0.3 (Q22) |
| Docker socket access is root on the host | GET only proxy recommended and detected; TLS required for TCP |
| Coolify image scan endpoints differ between Coolify builds | 404 and 403 handled as "not available" with a clear note; fixtures per response |
| Desktop heuristic misses an app (assets named oddly) or flags a CLI | `release_tier` on and off per repo |
| Go versions with or without `v` in OSV queries | fixture test against the real API before merging the Go slice |
| More guard noise than value | every check is turn off able with a reason, listed in settings; Q14 keeps warns out of immediate notifications |

## 12. Slice plan

Each slice is one PR, one agent. Model: **Opus** for contract design, cross cutting framework code and anything with a tricky trust or parsing boundary; **Sonnet** for parsers with clear formats, UI on an existing pattern and docs. Size: S under about 300 lines, M about 300 to 800, L above.

### Foundation

1. **feat(shared): guard findings contract.** `FINDING_KINDS` plus `guard`, `GUARD_CHECKS`, `GUARD_LEVELS`, tiers (`released`), reporters (`image`), coverage note `release_lockfile_missing`, evidence schemas per check, override and API schemas, `guards.ts` copy map (titles, explanations, fix texts). Opus, M. Depends on nothing.
2. **feat(server): guard framework.** Migrations 0011 and 0012, `Guard` types, `applyGuards`, dedupe keys, rank and tier for guards and `released`, overrides API, `escalated` and `turned_off` events, findings filters, overview and nav counts, notifier and items changes. Opus, L. Depends on 1.
3. **feat(server): deployment facts from coolify.** Migration 0016, settings and storages per resource with `updated_at` caching, environments to projects, run options and compose parsing into `facts`, capabilities declared. Opus, M. Depends on 1.
4. **feat(shared): dockerfile and compose readers.** Pure `dockerfile.ts` (stages, ARG substitution, FROM, USER, target stage) and compose reader (user, volumes, networks), plus the shell line tokeniser for run options. Sonnet, M. Depends on nothing.

### Drift checks (#66)

5. **feat(server): root user and docker socket guards.** Includes the Dockerfile fetch at the commit sha. Sonnet, M. Depends on 2, 3, 4.
6. **feat(server): shared network and watch path guards.** Moves the watch path matcher to `packages/shared/src/watch-paths.ts` and points `runner/verify.ts` at it. Sonnet, M. Depends on 2, 3.
7. **feat(web): guards in the ui.** Findings chips and filters, deployment guards panel with the turn off dialog, overview card, settings checks page with overrides. Sonnet, L. Depends on 2 (can start on fixtures after 1).

### Support windows (#87)

8. **feat(server): support data cache.** endoflife.date client (conditional requests, 301, 429), migration 0013, daily job, offline fallback, purl and release index, `GET /api/support/status`. Sonnet, M. Depends on 1.
9. **feat(server): runtime pin readers.** Parsers for every source in 5.1 (Node), migration 0014, fetch through the existing contents walk. Sonnet, M. Depends on 4.
10. **feat(server): runtime support and disagreement guards.** Window states, production precedence, disagreement rule, fix hints, repo detail data. Opus, M. Depends on 2, 8, 9.
11. **feat(server): action runtime guard.** Workflow `uses:` listing, `action.yml` fetch and cache, composite follow one level. Sonnet, M. Depends on 8, 9, 10.
12. **feat(server): framework support guard.** Purl join on direct runtime dependencies, release name prefix match. Sonnet, S. Depends on 2, 8.
13. **feat(web): runtime and windows ui.** Repo runtime panel with pins and hints, overview windows strip. Sonnet, M. Depends on 7, 10.

### Lockfiles (#70)

14. **feat(shared): wider osv ecosystems.** Enum, `LOCKFILE_NAMES`, `fetchLockfiles` names, `osvEcosystemOf` returns unsupported for the fix runner, OSV client tests per ecosystem. Sonnet, S. Depends on nothing.
15. **feat(server): go.mod parser with stdlib.** Sonnet, M. Depends on 14.
16. **feat(server): uv.lock and poetry.lock parsers.** Sonnet, M. Depends on 14.
17. **feat(server): requirements.txt parser.** Sonnet, S. Depends on 14.
18. **feat(server): composer.lock parser.** Sonnet, S. Depends on 14.
19. **feat(server): Gemfile.lock parser.** Sonnet, S. Depends on 14. (15 to 19 run in parallel.)

### Desktop tier (#68)

20. **feat(server): desktop release tier.** Migration 0015, daily latest release check, installer heuristic, `release_tier` override API, tag lockfile scan, release findings and coverage note, "fixed on main, not released". Opus, M. Depends on 2.
21. **feat(web): release panel.** Repo release panel, `released` tier chip, release tier toggle. Sonnet, S. Depends on 7, 20.

### Image scan (#67)

22. **feat(server): image scan from coolify results.** Setting, endpoint probing (404, 403), mapping, coverage note resolution, truncated note. Opus, M. Depends on 2.
23. **feat(server): image scan from registry sboms.** OCI registry client (index, attestation manifests), SPDX and CycloneDX package extraction, OSV OS ecosystems with the local check skipped. Opus, L. Depends on 22. Only if Q15 keeps it in v0.3.

### Sources (#71)

24. **refactor(server): deployment source interface.** `DeploymentSource`, capabilities, shared record schema, Coolify moved behind it, scan loops over sources. Opus, M. Depends on 3.
25. **feat(server): manual deployment list.** Source kind, CRUD, YAML import, web form. Sonnet, M. Depends on 24.
26. **feat(server): docker labels source.** `node:http` socket helper, TLS, inventory and inspect to facts, proxy detection, web form. Opus, M. Depends on 24.
27. **feat(server): dokploy source.** Secret stripping client, inventory, verified facts, warning in the form. Opus, M. Depends on 24. Only if Q22 says v0.3.

Docs: each slice updates the docs it touches (`docs/api.md`, `docs/notifications.md`, a new `docs/guards.md`, `docs/sources.md`); the last slice merged also updates `docs/spec.md` phase 2.

**Order:** 1, 4, 14 and 28 first in parallel. Then 2, 3, 8 and 15 to 19 in parallel. Then 5, 6, 7, 9, 12, 20, 22 and 24 in parallel. Then 10, 21, 23, 25, 26 and 27. Then 11 and 13. Critical path: 1, 2, 7, 13 on the UI side; 1, 8, 10, 11 on the support side (four steps each).

## Decisions taken (2026-11-07)

These win over the options in section 13 and over anything earlier in this document.

- **Q1.** A new `guard` finding kind with a check column.
- **Q2.** Guard findings sit in the reach tiers next to advisories, told apart by a kind chip.
- **Q3.** Turning a check off keeps it running; the finding is stored as accepted with the reason.
- **Q4.** Turn off per deployment and per repo.
- **Q5.** `archived_deployed` stays a blind spot and can be turned off through the same override table.
- **Q6.** Framework support: direct runtime dependencies matched to endoflife.date products by purl, flagged near or past end of security support.
- **Q7.** No "behind the latest patch" check; advisories cover it.
- **Q8.** Warning window 90 days, configurable.
- **Q9.** No `USER` in the final stage: `warn` "probably root", pass for nonroot tags.
- **Q10.** Fetch the Dockerfile at the deployed commit sha when Coolify has no inline copy, cached by sha.
- **Q11.** `products/full` once a day with a conditional request, offline from the last copy.
- **Q12. Changed from the recommendation: Node, Bun and Rust in v0.3.** Slice 9 reads Bun pins too (`packageManager: bun@`, `.bun-version`, `.tool-versions`, `mise.toml`, Dockerfile `FROM oven/bun`, `oven-sh/setup-bun`) and Rust pins (`rust-toolchain.toml` or `rust-toolchain`, Cargo `rust-version`, Dockerfile `FROM rust`, toolchain actions such as `dtolnay/rust-toolchain`). Slice 8 must confirm the endoflife.date product for each (`nodejs`, `bun`, `rust`) and record what support data each publishes; where a product has no security support dates, the check uses its release cycle data and says so in the finding.
- **Q12a (2026-11-07, after the endoflife.date check in slice 8). Rust and Bun use a "behind latest" rule, not end of life dates.** endoflife.date marks every Rust line but the newest as end of life (Rust supports only the latest stable), and publishes no end of life dates for Bun. So for both: a floating channel (`stable`, `latest`) or no pin passes; a pinned version warns once it is more than N releases behind the latest (Rust: N stable releases, default 4, about six months; Bun: N minor releases, default 4); it never fails. Cargo `rust-version` is a minimum supported version and is never treated as the running toolchain. Node keeps the end of life rule with its security dates.
- **Q13.** Action runtimes: the repo's own `action.yml` and every action its workflows use.
- **Q14.** `fail` and escalations notify immediately, `warn` goes to the digest, `unknown` never.
- **Q15.** Image scan: Coolify's own results first, registry SBOM plus OSV next (slice 23 stays in v0.3), sidecar documented only.
- **Q16.** "Released" means the latest release has installer like assets, with a per repo override.
- **Q17.** Only the latest release counts as in users' hands.
- **Q18.** Desktop findings weigh like internal, tier between internal and public_low, digest only except critical.
- **Q19.** Unpinned `requirements.txt` lines are skipped with a coverage note.
- **Q20.** Go versions from `go.mod`; `go.sum` only for presence.
- **Q21.** Docker: socket proxy with GET only endpoints recommended, raw socket allowed with a warning, TCP only with TLS.
- **Q22.** Dokploy ships in v0.3 (slice 27 stays) with secret stripping and a full access warning.
- **Q23.** Manual list: a web form plus a YAML import of the same shape.
- **Q24.** Later, runtime bumps through the fix runner as plan contract version 2, workflow lines as hints in the PR body. Not built in v0.3.
- **Q25.** Shared network: flag resources of different projects on one network, `fail` when a database is among them.

### Slice 28 (#130): running version and update check

**feat(web): show the running version and when a newer release exists.** Build args for version, commit and build date; `GET /api/version`; version in the rail footer and an About block in Settings; a daily opt out check of the latest final GitHub release, with a Settings switch. Sonnet, M. Depends on nothing; can run in the first wave.

## 13. Open questions for the user

Each lists the recommendation first.

- **Q1. One finding kind for all non advisory checks?**
  1. A new `guard` kind with a check column (one framework, one filter, one notification rule) **(recommended)**
  2. Add each check as a new blind spot type
  3. A separate table outside `findings`
- **Q2. Where do guard findings sit in the tiers?**
  1. In the reach tiers next to advisories (exposed, internal, public_low), separated by a kind chip **(recommended)**
  2. Their own `guard` tier after `blind_spot`
  3. Their own tier at the bottom, before `coverage`
- **Q3. What does "turn off with a reason" do to the finding?**
  1. The check still runs; the finding is stored as accepted with the reason, so it stays visible and its evidence stays current **(recommended)**
  2. The check is skipped and any finding is deleted
  3. A new `turned_off` state value
- **Q4. Turn off scope?**
  1. Per deployment and per repo **(recommended)**
  2. Per deployment only (as the issue says)
  3. Per deployment, per repo and instance wide (switch a check off everywhere)
- **Q5. `archived_deployed`?**
  1. Keep it a blind spot, let it be turned off per deployment through the same override table **(recommended)**
  2. Move it into the guard kind with a data migration
  3. Leave it exactly as it is
- **Q6. Definition of "framework behind its security release"?**
  1. Any direct runtime dependency that matches an endoflife.date product (by purl), flagged when its line nears or passes end of security support **(recommended)**
  2. A hand kept list of frameworks, flagged when an open advisory exists on them (duplicates advisory findings)
  3. Drop the check, advisories already cover missing security patches
- **Q7. Also flag "behind the latest patch of a supported line"?**
  1. No, advisories cover missing security patches **(recommended)**
  2. Yes, low level, when the latest patch is more than 30 days old
  3. Yes, low level, always
- **Q8. Warning window before end of life?**
  1. 90 days, configurable **(recommended)**
  2. 180 days
  3. 30 days
- **Q9. Root check when the final stage has no USER line?**
  1. `warn` "probably root" (most official base images run as root), pass for `nonroot` tags **(recommended)**
  2. `unknown`
  3. `fail`
- **Q10. Fetch Dockerfiles from the repo when Coolify has no inline copy?**
  1. Yes, at the deployed commit sha, cached by sha (one call per changed deploy) **(recommended)**
  2. Only use the inline `dockerfile` field, else unknown
- **Q11. How to fetch endoflife.date?**
  1. `products/full` once a day (about 3 MB, one conditional request, everything offline) **(recommended)**
  2. `identifiers/purl` plus one request per product actually used
- **Q12. Which runtimes in v0.3?**
  1. Node only, with the generic parser layer ready **(recommended)**
  2. Node, Python and Go
  3. All with an endoflife.date product and an image: Node, Python, Go, Ruby, PHP, Bun, Deno
- **Q13. Action runtimes scope?**
  1. The repo's own `action.yml` and every action its workflows use **(recommended)**
  2. Only the repo's own `action.yml`
  3. Skip action runtimes in v0.3
- **Q14. When are guard findings sent?**
  1. `fail` and escalations immediately, `warn` in the digest, `unknown` never **(recommended)**
  2. Every open or reopen immediately, any level
  3. Digest only
- **Q15. Image scan approach?**
  1. Coolify's own scan results first, registry SBOM plus OSV next, sidecar documented only **(recommended)**
  2. Coolify results only in v0.3
  3. A Trivy server sidecar as an optional compose profile
  4. Registry SBOM plus OSV only
- **Q16. How is a repo detected as "released"?**
  1. Latest release has installer like assets, with an on or off override per repo **(recommended)**
  2. Any non draft, non prerelease release
  3. Only when marked by hand
- **Q17. Which releases count as "in users' hands"?**
  1. The latest release only **(recommended)**
  2. The last 3 releases
  3. Every release published in the last 90 days
- **Q18. Desktop tier placement and notifications?**
  1. Weight like internal, tier between internal and public_low, digest only except critical **(recommended)**
  2. Weight like public, tier with exposed, immediate for critical and high
  3. Weight like not deployed, no notifications
- **Q19. Unpinned lines in requirements.txt?**
  1. Skip them and add a coverage note "N unpinned requirements not checked" **(recommended)**
  2. Skip them silently
  3. Resolve each to the latest version on PyPI and check that
- **Q20. Go versions from which file?**
  1. `go.mod` (selected versions since Go 1.17), `go.sum` only for presence **(recommended)**
  2. `go.sum` (every listed version, many false positives)
- **Q21. Docker labels connection?**
  1. Socket proxy with GET only endpoints recommended, raw socket allowed with a warning, TCP only with TLS **(recommended)**
  2. Only through a socket proxy (refuse a raw socket)
  3. Raw socket mounted read only, no proxy guidance
- **Q22. Dokploy in v0.3?**
  1. Yes, with secret stripping and a full access warning in the form **(recommended)**
  2. Defer until Dokploy has a read only key
  3. Yes, only through a user supplied read only proxy
- **Q23. Manual list input?**
  1. A web form plus a YAML import of the same shape **(recommended)**
  2. Web form only
  3. YAML file only, read at startup
- **Q24. Runtime bump through the fix runner later?**
  1. Yes, as plan contract version 2, workflow lines left as hints in the PR body **(recommended)**
  2. Yes, and push workflow edits with Hinomi's credential when it has Workflows write
  3. No, hints only
- **Q25. Shared network strictness?**
  1. Flag resources of different projects on one network, fail when a database is among them **(recommended)**
  2. Flag only when a database of another project shares the network
  3. Flag any shared network, same project included

## Sources

- Coolify API, v4.x OpenAPI: https://raw.githubusercontent.com/coollabsio/coolify/v4.x/openapi.yaml (Application, ApplicationSetting, Service, Server, Destination, storages, vulnerabilities, image scanning schemas)
- Docker Engine API v1.47: https://docs.docker.com/reference/api/engine/version/v1.47.yaml (ContainerInspect, ContainerConfig.User, MountPoint, HostConfig, NetworkSettings)
- endoflife.date API v1: https://endoflife.date/docs/api/v1/ and live calls to `/api/v1/products/nodejs`, `/products/full`, `/identifiers/purl` (2026-11-07)
- OSV ecosystems: https://ossf.github.io/osv-schema/#affectedpackage-field and https://google.github.io/osv.dev/post-v1-querybatch/
- Dokploy API: https://docs.dokploy.com/docs/api
- GitHub REST, latest release: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
- Go modules reference (module graph pruning, go.mod completeness since 1.17): https://go.dev/ref/mod#graph-pruning
- Hinomi: `docs/design/fix-runner.md` sections 6.3 and 17.4, `apps/server/src/runner/verify.ts`, `apps/server/src/scan/blind-spots.ts`, `apps/server/src/scan/rank.ts`
