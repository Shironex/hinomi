# Several GitHub sources: design

Status: accepted, built for #121. One Hinomi can connect several GitHub sources (tokens or GitHub Apps, for example one per organization). Every repo is read and fixed through exactly one of them.

## Data

- `repos.source_id`: the source that reads the repo, chosen by scans. Null when no connected source can read it.
- `repos.source_override_id`: a source picked by hand. It wins while it is enabled and holds a credential.
- `repo_sources (repo_id, source_id, alerts_readable, last_seen_at)`: every source that saw the repo on the last scan that asked it. It lets a repo move to another source when its own goes away, and the UI offer the switch.

Migration `0010_repo_sources` adds them and gives every existing repo the source it was read through before: the first enabled GitHub source with a credential, by id.

## Which source reads a repo

A scan asks every enabled GitHub source with a credential about every repo it scans, one source after another (each source spends only its own rate limit). With "include account repos" on, each source's own repo list is read first and a source whose list leaves a repo out is not asked about it. The reader is then:

1. the source picked by hand, while it is enabled;
2. else the lowest id source that can read the repo and tell whether its Dependabot alerts are on (a token without the alerts permission answers "unknown");
3. else the lowest id source that can read the repo at all.

The rule depends only on what the sources answer now, never on scan order or on the previous reader, so it is the same on every instance. Two exceptions keep a bad minute from moving repos: when no source can read the repo and the current reader failed for a passing reason (network, timeout, rate limit, server error), the reader stays; and a source that answered with an error (other than "not found") keeps its `repo_sources` row.

Alerts, lockfiles and the repo's health are read through the reader only, so a repo seen by two sources still produces one set of findings. Each source records its own outcome (`last_ok_at`, `last_error`); the scan run keeps one GitHub result for all of them.

## Removing or switching off a source

Removing, switching off or clearing the credential of a GitHub source moves each repo it reads to the next source in `repo_sources` (one that could read the alerts setting first, then the lowest id), or leaves it with no reader. Findings, plans, fix runs and their history stay. A removed Coolify source still takes its deployments with it.

A repo with no reader (and a repo no scan has placed yet) uses the only connected GitHub source when there is exactly one, so a single source install behaves as before. With several, such a repo is unreadable until a scan places it or a source is picked by hand.

## Everything else that talks to GitHub

`openRunnerGithub(repositories, repoId)` opens the repo's source: the fix run dispatch, the publisher, the setup PR, the runner status and its permission probe, the report handler and the tracker all go through it. `cachedRunnerGithub` keeps one opened source per source row (keyed by its `updated_at`), so a GitHub App's installation token is reused across repos and polls. The tracker polls each run through its repo's source and shares one request budget.

The GitHub webhook maps a delivery to a repo by owner and name, whatever source reads it; the tracker then polls through that repo's source. The latest Hinomi release is read anonymously from the public API.

## API

- `GET /api/sources`: `repoCount` (GitHub) and `deploymentCount` (Coolify) per source.
- `GET /api/repos/:id`: the repo with `source: { current, mode, overrideId, seenBy }`, where `mode` is `override`, `auto`, `fallback` or `none`.
- `PATCH /api/repos/:id` with `{ sourceId }` picks a source by hand; `{ sourceId: null }` clears it.
