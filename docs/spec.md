# Hinomi spec

## Problem

A solo developer or small team deploys a dozen apps from a few dozen repos. GitHub reports thousands of Dependabot alerts, mostly for repos that are not deployed anywhere, so the few that matter drown. Worse, alerts can be switched off on a repo without anyone noticing, so a critical advisory on a live site produces no alert at all.

Hinomi answers one question: **is anything that is deployed and reachable right now exposed to a serious vulnerability, and what is being done about it?**

## Principles

- **Deployed first.** Every finding is ranked by real exposure: deployed and public beats deployed and internal beats not deployed.
- **Rank, never hide.** Noise is handled by ranking, badges and filters. Snoozes and accepted risks stay visible with a reason and an expiry.
- **Blind spots are findings.** A deployed repo with no advisory coverage (alerts off, no lockfile, private repo without access) is reported, not skipped.
- **Self-hostable in one command.** One container, SQLite, `docker compose up` or a Coolify one-click. No external services required beyond the APIs it reads.
- **Inert until configured.** No required secrets at boot; each source turns on when connected.
- **Read-only by default.** Write access (opening PRs, triggering deploys) is opt-in per action.

## Sources

| Source | What it gives | How |
|---|---|---|
| Coolify API | applications, services, databases: git repo, branch, domains, status, server, image, last deploy | `GET /api/v1/applications`, `/services`, `/servers` with a read token |
| GitHub | Dependabot alerts per repo, repo metadata (archived, default branch, alerts enabled) | GraphQL `repository.vulnerabilityAlerts` (severity, CVSS, `dependencyScope` RUNTIME/DEVELOPMENT, vulnerable range, first patched version, manifest path); REST `GET /repos/{o}/{r}/vulnerability-alerts` (404 = disabled) |
| OSV.dev | independent advisory matching from lockfiles, covers repos with Dependabot off | fetch lockfiles via GitHub contents API, parse (pnpm, npm, yarn, bun, Cargo first), `POST /v1/querybatch` |
| Later | plain Docker hosts (labels), GitHub releases for desktop apps, Docker image scan | phase 2+ |

## Core model

- **Deployment**: one running app (source, name, domains, public/internal, server, status, repo, branch, last deploy).
- **Repo**: owner/name, default branch, archived, alerts enabled, last scanned.
- **Advisory**: GHSA/CVE ids, package, ecosystem, severity, CVSS, summary, vulnerable range, first patched version.
- **Finding**: advisory x repo (x deployments through the repo), with scope (runtime/dev), sources that reported it (github, osv), first seen, state (open, fixing, fixed, snoozed until, accepted with reason).
- **Exposure score**: severity x scope x deployment reach (public, internal, none). Shown as a rank and badges, never as a hard cutoff.
- **Fix run** (phase 1): finding(s) -> agent run -> PR -> CI -> merged -> deployed -> verified by rescan.

Repo to deployment mapping comes from the Coolify git repository field, with manual overrides in settings for monorepos and renamed repos.

## Phases

### Phase 0: see it
- Connect Coolify and GitHub in a first-run flow; scan on a schedule (default every 6 h) and on demand.
- Exposure view: ranked findings for deployed repos. Everything-else view: the rest, ranked and filterable.
- Blind spot findings: alerts disabled, archived repo still deployed, deployment with no repo mapping.
- Notifications: Discord webhook first (new critical/high on a deployed repo immediately, daily digest for the rest), then generic webhook and email.

### Phase 1: fix it
- "Run fix agent" per finding or per repo: launches a dependency-bump agent (pluggable runner: local CLI agent, GitHub Actions workflow dispatch, or a webhook) that opens a PR.
- Track the run: queued, running, PR open, CI, merged, deployed, verified fixed (rescan clears the finding).
- Snooze and accept risk with reason and expiry.

### Phase 2: guard it
- Drift checks: container running as root, app on a shared network, framework behind its latest security release, deploy watch paths that skip Dockerfile-only changes.
- Desktop tier: repos with GitHub releases but no deployment (shipped apps still in users' hands).
- Built-in auth (until then, run it behind Tailscale or Cloudflare Access; the UI says so).

## Stack

- One Node process: Hono (API, static SPA, scheduler), SQLite via Drizzle, React SPA (Vite, Tailwind CSS v4, shadcn/ui).
- TypeScript strict, ESM, pnpm workspace (`apps/server`, `apps/web`, `packages/shared`).
- Docker image runs as a non-root user; `docker-compose.yml` with one volume for the database.
- Tokens are stored encrypted at rest with a key from the environment; never logged, never sent to the browser.

## Non-goals (for now)

- Not a general SCA or SBOM platform, not a replacement for Dependabot or Renovate.
- No multi-tenant SaaS.
- No auto-merge: a human merges every fix PR.
