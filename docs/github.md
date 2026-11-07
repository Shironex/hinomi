# Connecting GitHub

Hinomi reads Dependabot alerts, repo metadata and lockfiles from GitHub. Scans never write anything; only the optional [fix runner](#fix-runner), off until you turn it on per repo, dispatches workflows and opens fix pull requests. Connect it in onboarding or under Settings, Sources, with either a personal access token or a GitHub App.

| | Personal access token | GitHub App |
|---|---|---|
| Tied to | your user | an installation on a user or organization |
| Repos read | every repo the token can see | the repos picked when installing |
| Expires | when you set it to | never: Hinomi mints a one hour installation token as needed |
| Stored | the token, encrypted | the private key, encrypted |

## Personal access token

Fine-grained: Dependabot alerts (read) and Metadata (read) on the repos to watch, plus Contents (read) for the OSV.dev lockfile scan of private repos and Administration (read) to see whether Dependabot alerts are on. Classic: `repo` and `security_events`.

In setup, the GitHub step links to the classic token form with both scopes ticked and to the fine-grained form. If the repos belong to an organization with SAML SSO, authorize the token for it (Configure SSO on the token's page), or its repos stay hidden.

## Create the GitHub App

1. Open Settings, Developer settings, GitHub Apps, New GitHub App. For an organization, use the organization's settings instead, so the app belongs to it.
2. Give it a name and any homepage URL. Untick Webhook, Active: Hinomi polls and does not need events. The optional [webhook](github-webhook.md) for faster fix run updates can be turned on later.
3. Under Repository permissions, set these to Read-only:
   - **Dependabot alerts**: the alerts themselves.
   - **Contents**: lockfiles for the OSV.dev scan.
   - **Metadata**: repo names, archived state, default branch (GitHub adds it on its own).
   - **Administration** (recommended): lets Hinomi see whether Dependabot alerts are switched on. Without it every repo shows the "alerts unknown" blind spot.
4. Under "Where can this GitHub App be installed?", keep "Only on this account". Create the app.
5. On the app's settings page, note the **App ID** (the Client ID works too). Under Private keys, click "Generate a private key". GitHub downloads a `.pem` file.
6. Click Install App, pick the account, and choose all repos or only the ones Hinomi should watch.
7. The **installation ID** is the number at the end of the installation's settings URL, for example `https://github.com/settings/installations/51234567`.

In Hinomi choose "GitHub App", enter the App ID and the installation ID, and paste or load the `.pem` file. The connection test reports the account the app is installed on and how many repos it can read, and fails when Dependabot alerts, Contents or Metadata is missing.

If you change the app's permissions later, GitHub asks the installation's owner to accept them before they apply.

## How Hinomi signs in as the app

- It signs a JWT with RS256 using the private key: `iat` 60 seconds in the past to absorb clock drift, `exp` nine minutes ahead (GitHub allows at most ten), `iss` the App ID.
- It exchanges the JWT at `POST /app/installations/{installation_id}/access_tokens` for an installation token, which lasts one hour.
- The token is cached and replaced five minutes before it expires. When GitHub answers 401, Hinomi drops the token, mints a new one and retries once.
- Repos come from `GET /installation/repositories`; alerts and repo health use the same calls as a token.

The private key is encrypted at rest with AES-256-GCM under `HINOMI_SECRET_KEY`, like tokens. It is never logged and never sent back: the API only says whether it is set. Rotate it by generating a new key on GitHub, replacing it in Hinomi, then deleting the old one on GitHub.

## Fix runner

The fix runner applies a repo's fix plan inside the repo's own GitHub Actions and opens one fix pull request. Hinomi never merges it. It is off for every repo until you turn it on, and scans keep working with a read only credential.

How it works: Hinomi dispatches a small caller workflow in the repo (`.github/workflows/hinomi-fix.yml` by default) with three inputs: `run_id` (the fix run's id), `plan` (the plan as JSON, or gzip plus base64 when large) and `encoding`. The caller hands them to the reusable workflow `Shironex/hinomi/.github/workflows/fix.yml`, pinned by commit SHA. The workflow edits only dependency files, installs, runs the checks on public repos (install only on private ones, where the PR's own CI runs them) and pushes the branch `hinomi/fix-plan`; Hinomi then opens or updates the PR.

### Permissions per connection type

| Needed for | GitHub App | Fine grained token | Classic token |
|---|---|---|---|
| Dispatch the workflow and follow its runs | Actions: write | Actions: write | `repo` (`public_repo` is enough for public repos) |
| Read the caller workflow and the fix branch | Contents: read (scans already need it) | Contents: read | `repo` |
| Open and update the fix pull request, add the `dependencies` and `security` labels when the repo has them | Pull requests: write | Pull requests: write | `repo` |
| Follow checks on the fix PR (optional) | Checks: read, Commit statuses: read | Checks: read, Commit statuses: read | `repo` |
| Setup PR that adds the caller workflow (optional) | Contents: write, Workflows: write | Contents: write, Workflows: write | `workflow` |

Hinomi checks these on the runner status of each repo (Settings for the repo, or `GET /api/repos/:id/runner`):

- **GitHub App:** the installation's granted permissions are read directly, so every row is granted or missing. After adding permissions to the app, the installation's owner must accept them on GitHub.
- **Classic token:** the scopes come from the `X-OAuth-Scopes` header of `GET /user`.
- **Fine grained token:** GitHub cannot be asked what such a token may do, so Hinomi makes harmless reads (the workflow's metadata, one pull request, one commit). A refused read shows the permission as missing; a read that works leaves the write level as unverified until the first dispatch, which fails with a clear reason if write is not granted.

The setup PR button (`setupPr` on the runner status, `POST /api/repos/:id/runner/setup-pr`) is shown only when the credential can write a file under `.github/workflows`, which is a powerful permission (it can change any workflow in the repo), so it is off by default and best granted temporarily:

- **Classic token:** `repo` plus `workflow`, read from the scopes header, so the button is exact.
- **GitHub App:** Contents: write and Workflows: write on the installation (the owner must accept the change), read from the installation, so the button is exact.
- **Fine grained token:** Contents: write, Pull requests: write and Workflows: write. These cannot be read in advance, so the button shows and Hinomi tries; a refusal comes back with the permission to add. Without any of these, copy the caller from the runner status instead (below).

The same button updates an outdated pin: when the caller on the default branch pins an older release commit, it opens a PR that moves the pin. It needs a known release commit, so on an instance that cannot reach api.github.com the answer is a 409 until one is.

A GitHub App is the recommended credential for the runner: the PR author is the app's bot, so you can approve the fix PR yourself in repos with required reviews. A classic token cannot be narrowed (`repo` grants everything except workflow files).

### Set up a repo

1. Give the credential the permissions above for the repos you want fixed.
2. Add the caller workflow on the repo's default branch: `workflow_dispatch` only runs workflows that exist there. The template is [docs/runner/hinomi-fix.yml](runner/hinomi-fix.yml); the runner status shows the same file with the SHA filled in:

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
       uses: Shironex/hinomi/.github/workflows/fix.yml@<40 char sha>
       permissions:
         contents: write
       with:
         run_id: ${{ inputs.run_id }}
         plan: ${{ inputs.plan }}
         encoding: ${{ inputs.encoding }}
   ```

   Replace `<40 char sha>` with the commit the runner status shows, and keep the version comment it adds (`# v0.2.0`) so readers can tell the release. Hinomi finds that commit by asking GitHub for the latest Hinomi release and the commit its tag points at (cached for 6 hours); an instance that cannot reach api.github.com falls back to the SHA built into it, and with none known it shows the placeholder. You can also look it up yourself: the commit of the latest release tag on [Shironex/hinomi](https://github.com/Shironex/hinomi/releases). Pin the full commit SHA, never a tag or branch: the pin covers the workflow and the action it runs, which comes from the same commit. The status reports the caller as missing, not calling Hinomi, unpinned, pinned, current or outdated, and lists any of the three inputs the file does not declare. To use another file name, set it in the repo's runner settings.
3. Turn the runner on for the repo. When the status says ready, dispatch the latest plan.

If the repo's last fix PR was closed without merging, Hinomi asks before opening a fresh one. Nothing secret is stored in the target repo, and no repo setting needs to change (unless you turn on the majors agent, below).

What the workflow does in the repo, job by job, is in [docs/runner/README.md](runner/README.md). It needs github.com (the self repository reference it uses is not available on GitHub Enterprise Server).

### The optional majors agent

Major upgrades never go into the fix PR. With the majors agent on, Hinomi also hands them to a coding agent (Claude Code, run headless in the repo's Actions), which sets the new versions, adapts the code and tries to make the tests pass. Its changes go to the branch `hinomi/majors` and a separate pull request that is **always a draft** and says plainly that an agent wrote it. Review it like any outside contribution. It is off for every repo.

To turn it on for a repo:

1. Create an Anthropic API key for this purpose only, with a spend limit, and add it to the repo as the Actions secret `ANTHROPIC_API_KEY` (Settings, Secrets and variables, Actions).
2. Pass it to the reusable workflow: uncomment the `secrets:` lines at the end of the caller workflow (or use the setup PR button after step 3, which writes them). `secrets: inherit` works too but passes every secret; naming the one is better.
3. Set the majors agent to `claude-code` in the repo's runner settings (`PATCH /api/repos/:id/runner` with `{ "majorsAgent": "claude-code" }`). The runner status warns while the caller passes no secret.

Each dispatch of a plan with major upgrades then starts a second workflow run after the fix run. Only the majors job sees the key, and the action passes it to the agent process alone.

**Cost.** Model usage is billed to the key: the agent stops at 80 turns or about 10 USD of usage per run, whichever comes first, and the runner stops it after 40 minutes. On private repos the majors job also uses up to about an hour of Actions minutes (public repos are free). Large upgrades can hit those limits; the draft then shows what the agent got done.

**What the agent can and cannot do.** Its shell commands run in Claude Code's sandbox (bubblewrap): they write only inside the checkout, reach only the npm, yarn and crates registries, and cannot read the key. Its file tools read and edit inside the checkout, never `.github`. The job's GitHub token is read only, and a separate job pushes the branch after checking the patch: no files under `.github`, git hooks, CI, editor or registry configuration, `.env` files, binaries, deletions or more than 200 files or 1 MB. It cannot merge anything or touch the fix PR. It does send the repo's code to Anthropic as it works, so do not turn it on for repos whose code may not leave your hands, and dependency code or changelogs it reads could steer it (prompt injection), which is why the PR stays a draft. The full trust model is in [the design](design/fix-runner.md#20-built-in-628-the-majors-agent).
