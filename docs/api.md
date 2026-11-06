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
| `GET /api/overview` | Advisory funnel (total, deployed, runtime, critical or high, public, exposed, needs action, dismissed upstream), distinct repos and apps behind each funnel step (`funnelReach`), blind spot counts, counts per tier and the same split by severity (`tierSeverity`), last scan, next scan time, health of every source, the 20 latest finding events |
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
| `ranking` | Opens and resolves blind spots and records the run | None (0 of 0) |

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
| `GET /api/findings/:id` | Detail: full advisory with its description, versions (installed, first patched, vulnerable ranges), dependency scope, manifests and path, deployments, history newest first, notifications sent |
| `POST /api/findings/:id/snooze` | `{ reason, until }` or `{ reason, untilNewAdvisory: true }`. A reason and exactly one expiry; `until` in the future. Returns the detail |
| `POST /api/findings/:id/accept` | Same body, accepts the risk until the date or the next advisory |
| `POST /api/findings/:id/reopen` | `{ reason? }`, cancels a snooze or acceptance |
| `POST /api/findings/bulk` | `{ action: "snooze" \| "accept", ids, reason, until \| untilNewAdvisory }` or `{ action: "reopen", ids, reason? }`, 1 to 200 ids. Each finding is changed on its own: `{ results: [{ id, ok: true, state } \| { id, ok: false, error: { code, message } }], ok, failed }` |

A transition the current state does not allow (snoozing a fixed finding, reopening an open one) answers 409; in a bulk call that finding gets the same code in its result.

**Until a new advisory.** `untilNewAdvisory` keeps the snooze or acceptance in force (`stateUntil` is null) until a scan opens a finding for a different advisory on the same repo and package. The finding then reopens with a `snooze_expired` or `acceptance_expired` event whose data says `reason: "new_advisory"`. Only advisory findings can use it.

**Dependency path.** `dependency.path` is the chain of package names from a direct dependency down to the vulnerable package, taken from the lockfiles Hinomi parses for OSV (pnpm, npm v2 and v3, yarn, bun, Cargo; not npm v1). Chains longer than 12 links keep the first ten, `...` and the package. `pathSource` says what is known: `lockfile` (the path), `manifest` (only `manifestPaths`) or `package` (neither).

**Notifications.** `notifications` lists the immediate messages that announced the finding, one per channel (the latest announcement), with the channel name and kind (null when the channel was removed) and when it went out. Daily digests are not recorded per finding.

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

### Sources

| Method and path | Does |
|---|---|
| `GET /api/sources` | `{ sources, canStoreTokens }`. Each source has `auth` (`token` or `github_app`), `appId` and `installationId` (null for tokens) and `hasToken` (the token or the app's private key is stored) |
| `GET /api/sources/:id` | One source |
| `POST /api/sources` | `{ kind, name, baseUrl?, token?, enabled? }`. Coolify needs a URL and a token, GitHub a token (URL only for Enterprise), OSV neither. A GitHub App instead sends `auth: "github_app"`, `appId`, `installationId` and `privateKey` (PEM) |
| `PATCH /api/sources/:id` | Any of `name`, `baseUrl`, `token` (replaces the stored one), `enabled`; for a GitHub App `appId`, `installationId`, `privateKey`. Changing `auth` also needs the new token or private key |
| `DELETE /api/sources/:id` | Removes it and its deployments |
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
| `GET /api/notifications/settings` | `{ publicBaseUrl, digestHour }` |
| `PATCH /api/notifications/settings` | `publicBaseUrl` (empty clears it) and `digestHour` (0 to 23, server local time) |

See [notifications.md](notifications.md) for what is sent and when.

## Scheduler

One scan at a time, in the server process. Scans run every `scanIntervalMinutes` after the previous one started, right away on boot when one is overdue, and right away once GitHub is connected (or, with only Coolify, once setup is finished). Scheduled scans are skipped while nothing is connected, and while only Coolify is connected and setup is not finished: such a scan would report every repo as having no lockfile. A manual scan always runs. A scan run left `running` by a crash is marked failed on boot. On SIGTERM or SIGINT the server starts no new scan (`POST /api/scans` answers 503), waits up to `HINOMI_SHUTDOWN_TIMEOUT_SECONDS` (25 by default) for the running one, then closes storage; a scan still running after that is marked interrupted first. A second signal exits at once. After each scan the notifier gets the summary; a failing listener is logged and never stops the scheduler.
