# Changelog

All notable changes to Hinomi. Versions follow [Semantic Versioning](https://semver.org/); release images are on `ghcr.io/shironex/hinomi`.

## 0.2.0 (2026-11-07)

Hinomi now fixes what it finds. Version 0.1.0 told me which vulnerable dependency mattered; this one opens the pull request that updates it, follows that pull request until the fix is deployed, and rescans to check the findings are really gone. It never merges anything: a person reads every pull request, and the fix runner stays off for each repo until I turn it on.

### Highlights

- **One fix plan and one pull request per repo.** After every scan Hinomi builds a plan of the safe bumps for each repo, shows it as the diff its pull request will make, and opens one PR for all of it.
- **A GitHub Actions fix runner.** A reusable workflow, pinned by commit SHA, applies the plan inside the repo's own Actions with npm, pnpm, yarn, bun or Cargo. The job that runs install scripts and tests never holds a write token.
- **Fix runs tracked to the end.** From dispatch to the pull request, its checks, the merge, the deploy and a scoped rescan that says verified or not cleared.
- **Other places to run a fix.** An optional GitHub webhook for faster tracking, a webhook runner for your own CI, and an opt in local runner for a Hinomi host.
- **A majors agent, experimental.** Off by default and clearly marked: major upgrades can go to a coding agent on a separate draft PR.
- **Several GitHub sources.** One Hinomi can read an account and an organization side by side, with Add source in Settings.

### What's New

#### Fix plans
- A plan per repo at the end of each scan: the safe steps, the findings each step clears and what was skipped and why. Major upgrades are never mixed into it.
- The plan shows as the diff of its pull request in the UI and the API, and is linked from findings and the By fix view.
- The fix target is checked: a version that a known advisory still affects is never picked, and the plan records what the check found.

#### The GitHub Actions fix runner
- A small caller workflow in each repo calls the reusable workflow `Shironex/hinomi/.github/workflows/fix.yml`, pinned by commit SHA. The runner status suggests the SHA of the latest release.
- Two jobs split by trust: apply (read only token, no secrets) edits the dependency files and builds the patch; publish (contents: write only) checks the patch against the allowed dependency files and pushes the branch `hinomi/fix-plan`. Hinomi opens or updates the pull request itself.
- All five package managers: npm, pnpm, yarn, bun and Cargo, with the release age gate and mixed ecosystems in one plan.
- Checks run on public repos; on private repos only the install runs, and the PR's own CI does the rest. When the checks fail, the PR is a draft that says why.
- A setup PR adds the caller workflow, and flags and re-pins an outdated pin. It needs Workflows write, so it is off unless the credential has it.
- Off for every repo until turned on, with a per credential permission check on the runner status. Hinomi never merges.

#### Fix runs and notifications
- Each run is followed through queued, running, branch pushed, PR open, checks, merged and deployed, by polling GitHub; a run that goes quiet is marked lost.
- After the merge Hinomi links the Coolify deploys that shipped it and warns when none is seen or when the app's watch paths would skip the deploy.
- A scoped rescan of that one repo then ends the run as verified or not cleared, with the counts.
- Discord, webhook and email channels announce fix run events (PR opened, checks failing, verified, not cleared, failed, warnings), each switchable in Settings.
- A fix runs page and run detail, and a "Fix with Hinomi" action on findings and in the By fix view, always after a diff preview.

#### The optional GitHub webhook
- GitHub can tell Hinomi that a workflow run, pull request or check changed, so tracking does not wait for the next poll. Polling stays the source of truth, so a lost or forged delivery cannot move a run.
- The webhook path is the only thing meant to be exposed. `HINOMI_WEBHOOK_PORT` serves it on a second port and nothing else, with recipes for Cloudflare Tunnel, Tailscale Funnel, Caddy and nginx.

#### Webhook and local runners
- The webhook runner posts the signed plan to your own CI or build box and takes its report on a signed callback. Each repo picks its runner kind.
- The local runner applies plans on the Hinomi host with the same action. It is the riskiest option, so it is opt in twice (`HINOMI_LOCAL_RUNNER=1`, then the repo) and the docs list the residual risks. Run it only in a dedicated container.

#### The majors agent (experimental)
- Off by default and per repo. It hands major upgrades to Claude Code, run headless in the repo's Actions, and its changes go to `hinomi/majors` and a separate pull request that is always a draft and says an agent wrote it.
- It needs your own Anthropic API key as an Actions secret, with a spend limit. A run stops at 80 turns or about 10 USD of usage, and after 40 minutes.
- Experimental: CI tests it with a stub agent, and the real Claude Code preset has not yet been run outside CI. Expect rough edges and review the draft like an outside contribution.

#### Sources and tokens
- Several GitHub sources, a token or a GitHub App each, with Add source and remove in Settings after setup. Each repo is read and fixed through one source, chosen by a stable rule or by hand in the repo's runner panel.
- Prefilled fine grained token links in setup and the runner panel, with the permissions the runner needs already ticked.

### Fixes
- A fix target no known advisory affects is chosen; a version that is itself vulnerable is no longer offered.
- A fix run does not wait for a deploy when no app deploys the repo.
- Server messages end with one full stop.

### Under the Hood
- Migrations 0004 to 0010 run on boot: fix plans, fix runs, runner settings, verification, the majors agent, the runner kind and repo sources.
- esbuild and minimatch are overridden to patched versions.
- Every GitHub Action in CI is pinned by commit SHA, and the workflows are linted with actionlint and zizmor, with the tools checked by SHA-256.
- The fix runner action is bundled and committed under `actions/fix-runner/dist`, and CI fails when the bundle is out of date. The image ships it for the local runner.
- A self test runs the reusable workflow on pull requests, with a dry run publish.

### Upgrade notes
- Migrations run on boot; take a copy of `/data` first if you want a way back.
- This is the first release that callers can pin: `fix.yml` of v0.1.0 does not exist. Repos that add the caller workflow pin the commit of v0.2.0 or later.
- If you run v0.1.0, update the image tag (`HINOMI_VERSION=0.2.0` for compose, or `ghcr.io/shironex/hinomi:0.2.0`).
- Nothing changes until you turn on a runner for a repo.

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
