# Changelog

All notable changes to Hinomi. Versions follow [Semantic Versioning](https://semver.org/); release images are on `ghcr.io/shironex/hinomi`.

## 0.3.0-rc.1 (2026-11-15)

Hinomi now guards what it finds. Version 0.2.0 fixed vulnerable dependencies; this release looks at the other half of staying safe: how your deployments are configured and whether what runs on them is still supported. It also reads more than Coolify, more than lockfiles and more than deployed repos. This is a release candidate: it is a pre-release image, `latest` and the `0.3` tag stay where they are, and I would like it run on a real setup before 0.3.0.

### Highlights

- **Drift guards.** Checks for a container that runs as root, a mounted Docker socket, resources of different projects on one network, watch paths that skip the Dockerfile or lockfiles, a framework or runtime near end of life, runtime pins that disagree and a GitHub Action on an old Node. Each is a finding with a level, evidence and a fix hint, and each can be turned off for one deployment or repo with a reason.
- **Runtime support windows.** Node, Rust, Bun and your frameworks are judged against endoflife.date: a line near its end warns, a line past it fails.
- **Image scan.** Deployments that run an image with no repo are scanned from Coolify's own results, or from the SBOM the image carries in its registry, with a login per registry for private images.
- **A desktop release tier.** A repo that ships installers on GitHub releases but deploys nowhere gets its latest release scanned.
- **More lockfiles.** go.mod, uv.lock, poetry.lock, requirements.txt, composer.lock and Gemfile.lock join the npm, pnpm, yarn, bun and Cargo files.
- **More than Coolify.** Deployments can come from a manual list, from Docker hosts or from Dokploy, all behind one source interface.
- **A version display and an update check.** The running version is in the rail and in Settings, About, with a note when a newer release exists.

### What's New

#### Drift guards
- A guard is a configuration or support check on a deployment or a repo. It writes one finding per check and subject, at level warn, fail or unknown, next to the advisories and with the same states (snooze, accept, reopen) and history.
- Container checks: `root_user`, `docker_socket`, `shared_network` and `watch_paths_skip`. They read what the deployment source reports about the container, and say unknown when the source cannot give the signal. Unknown never counts as a pass.
- Support checks: `framework_support`, `runtime_support`, `runtime_pins_disagree` and `action_runtime`. See the support windows below.
- A fail on a running deployment is sent right away, a warn goes in the daily digest, and unknown is never sent.
- Turn a check off for one deployment or repo with a reason. The check keeps running and its finding stays visible as accepted.
- A guards view, a guards panel on each deployment, an overview card, and a Checks section in Settings.

#### Runtime support windows
- Node pins are judged by the end of security support from endoflife.date. The warning window is `supportWindowDays` (default 90).
- Rust and Bun have no usable end dates, so they are judged by releases behind the latest: a pin more than 4 releases behind warns (`rustBehindReleases` and `bunBehindReleases`).
- Frameworks come from the direct runtime dependencies in the lockfiles, joined to the endoflife.date products by package; there is no hand kept list.
- Runtime pins are read from version files, `engines`, Dockerfiles and CI, and the repo page lists every file that pins an old line, with the edit that moves it.
- The overview has a support windows strip. The data is cached, refreshed daily and shown at `GET /api/support/status`.

#### Image scan
- For deployments that run an image with no git source. Off by default: turn it on in Settings, Scans.
- `coolify` reads the results Coolify already computed. It needs Coolify 4.7.0 or newer with image scanning on for the server and the app.
- `sbom` does the same and, for what Coolify does not cover, reads the SBOM attestation in the image's registry and matches it on OSV.
- Findings are reported as `image`, ranked like lockfile advisories, and each deployment shows Coolify's verdict on its image.
- Registry credentials for private images: a login per registry host under Settings, Scans. They are write only, encrypted, never shown again, and sent only to that registry.

#### Desktop release tier
- A repo with GitHub releases and no deployment gets its latest release checked once a day. When the release has installers, its tag is scanned against OSV and the findings are tracked apart from the default branch.
- A finding already fixed on the default branch says so, because users still run the released build.
- Per repo, the tier can be set to auto, on or off. A repo page shows the release.

#### More lockfile ecosystems
- go.mod, uv.lock, poetry.lock, requirements.txt (pinned lines only), composer.lock and Gemfile.lock are read and checked on OSV, which now covers Go, PyPI, Packagist and RubyGems.
- A requirements.txt with lines that name no exact version gets a coverage note instead of a guess.

#### Deployment sources
- Hinomi reads deployments through one source interface. Coolify moved behind it, so a scan reads every enabled source and the guards never call a platform directly.
- A manual list, for hosts Hinomi cannot read: entries in Settings, through the API or by importing a YAML file. It needs no token.
- Docker hosts, read through the Engine API with GET requests only, over a socket or https. Containers are labelled with `hinomi.*` labels, and Traefik and Caddy labels give the domains. Hinomi never keeps environment variables.
- Dokploy, with an instance URL and an API key. Its container facts are not read yet, so the container checks say unknown for Dokploy deployments.
- Coolify now also reports how containers are configured (user, mounts, networks, watch paths).

#### Version display and update check
- The rail footer and Settings, About show the running version, commit and build date, and release images carry them as build args.
- Once a day Hinomi reads the latest release from GitHub and says when a newer one exists. A pre-release only looks for newer pre-releases, and Settings, About switches it off.

#### Follow-ups
- Settings controls for the image scan mode, the support window and the Rust and Bun allowances.
- A repo page, with links from repo names, a release filter on the alerts search, and an image security verdict on each deployment.
- Release notes are written from this changelog and the merged pull requests.

### Fixes
- Releases of repos nothing deploys are checked even when account repos are off, for the repos your GitHub sources list.
- Pinning a repo to a GitHub source that never saw it is refused.
- Coverage notes are named by their own type in recent activity and in the alerts messages, and the needs action tab counts the list it opens.
- Long names stay readable in the deployment join strip, and the phone tabs show the running fix count.
- Fix with Hinomi is hidden on release findings, which a release fixes instead.

### Under the Hood
- Migrations 0011 to 0016, 0020 and 0023 (the numbers in between are not used).
- Dependency updates: hono 4.13.16, @hono/node-server 2.1.6, jsdom 31 for the web tests, and newer pnpm/action-setup and docker/login-action in CI.
- The release workflow bakes the version, commit and build date into the image.

### Upgrade notes
- Migrations 0011 to 0023 run on start and only go forward. Back up the `/data` volume first, with your `HINOMI_SECRET_KEY`.
- New settings and their defaults: `imageScan` is `off`, `supportWindowDays` is 90, and `rustBehindReleases` and `bunBehindReleases` are 4. Nothing about your existing scans changes until you turn something on; the guards run on the next scan.
- `HINOMI_SECRET_KEY` now also protects registry credentials and Docker host client keys, on top of tokens. Rotating it means entering those again.
- With `includeAccountRepos` off, the releases of the repos your GitHub sources list are now still checked, once a day. Their default branch stays unread.
- Pinning a repo to a GitHub source that never saw it now answers 409. Run a scan first, or pick a source that sees it.
- The Coolify image scan needs Coolify 4.7.0 or newer with image scanning switched on. The reader follows the 4.7.0 API description and has not been compared with a running instance yet.
- A Dokploy API key has full access, because Dokploy has no read only key. Create a dedicated Dokploy user for Hinomi and generate the key as that user.
- Give Hinomi a GET only socket proxy for a Docker host rather than the socket itself, even mounted read only.
- Hinomi now also fetches support data from endoflife.date once a day, and, with the `sbom` image scan, the registries your images name.
- This is a pre-release: `docker pull ghcr.io/shironex/hinomi:0.3.0-rc.1`. `latest` and `0.3` do not move.

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
