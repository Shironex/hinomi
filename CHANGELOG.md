# Changelog

All notable changes to Hinomi. Versions follow [Semantic Versioning](https://semver.org/); release images are on `ghcr.io/shironex/hinomi`.

## 0.1.0 (2026-11-07)

The first release. Hinomi joins what is deployed on Coolify with the advisories GitHub and OSV.dev know about, and answers one question: is anything that is actually deployed and reachable right now exposed to a serious vulnerability? I run it on my own servers, behind Tailscale, and this is the version that does that job end to end.

### Highlights

- **Thousands of alerts narrow to the few that matter.** Every finding is ranked by severity, runtime or dev code, deployed or not, and public or internal, so a critical advisory on a public app sits at the top and dev tooling in an undeployed repo sits at the bottom.
- **Blind spots are findings too.** A deployed repo with Dependabot alerts switched off, or an app with no repo mapped, shows up instead of staying silent.
- **Fixes, not just findings.** The By fix view groups open findings by the version bump that clears them, so one upgrade that clears 31 findings across two repos is the first thing you see.
- **A redesigned, keyboard first interface** in the Nightshade theme: an icon rail, split triage views, a deployments map shaded by exposure, light and dark.
- **Ready to run images.** Multi arch (amd64, arm64) images with an SBOM and build provenance, a compose file that pulls them, and a self hosting guide.

### What's New

#### Sources
- Coolify: applications, services and databases with their repo, branch, domains, server, status and image, from a read only token.
- GitHub: repos, whether Dependabot alerts are on, and the alerts themselves, with a personal access token or a GitHub App installation (GitHub Enterprise Server supported).
- OSV.dev: an independent scan of each repo's lockfiles (npm, pnpm, yarn, bun, Cargo) with dependency paths, which also covers repos where Dependabot is off.
- Repo mapping from the Coolify git field, with manual overrides for monorepos and renamed repos; image only deployments get a coverage note instead of a false blind spot.

#### Ranking and triage
- Exposure view with Needs action, Blind, In progress and By fix tabs, and a funnel from all alerts down to what is exposed.
- Finding detail: why it ranks where it does, the fix and how many findings the same bump clears, affected apps, advisory text, vulnerable range and the lockfile path.
- Alerts the lockfile already patched, and alerts dismissed upstream, are told apart from open ones.
- Decisions: snooze (until a date or a new advisory) and accept risk, one at a time or in bulk; an expired snooze puts the finding back in the ranking.

#### Deployments
- A map of every app by server, shaded by exposed findings, with blind spots hatched in cyan, unmapped apps outlined and stopped apps faded.
- Deployment detail with exposure numbers, blind spots, the bumps that clear the most in that app and recent deploys.

#### Notifications
- Discord, generic webhook and email (SMTP) channels.
- A ranked summary instead of a flood for the first scan and for large batches; a daily digest hour.

#### Setup, settings and access
- A four step setup: Coolify, GitHub (with a link that opens GitHub with the right token scopes), notifications and a first scan that shows its phases.
- Settings for sources, channels, scan interval, repo mapping, access and appearance.
- Access status: Hinomi detects whether a request came through Tailscale or a verified Cloudflare Access token, and warns when it looks publicly reachable.
- Installable as an app (PWA) over HTTPS, with an offline state and an update prompt.

### Fixes
- The installed version of a GitHub only alert is read from the lockfile, and an unknown version says why.
- Stopped apps rank as not deployed, and auto scans wait until GitHub is connected.
- Blind spot states use cyan everywhere; red is only for critical.
- Text is at least 13 px and control outlines reach 3:1 contrast in both themes.

### Under the Hood
- Hono and SQLite (better-sqlite3, Drizzle migrations that run on boot), source tokens encrypted at rest with AES-256-GCM.
- The server waits for a running scan on shutdown (`HINOMI_SHUTDOWN_TIMEOUT_SECONDS`, 25 s by default).
- Node 26 LTS; the container runs as uid 10001.
- House ESLint plugins with layer rules between the server, the web app and the shared contract.
- A fixture mode with fictional data for deterministic screenshots, never part of a production build.
- Release workflow on version tags: native amd64 and arm64 builds, attestations, and these notes.
