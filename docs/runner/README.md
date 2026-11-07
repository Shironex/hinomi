# Hinomi fix runner

`hinomi-fix.yml` here is the caller workflow each repo adds to `.github/workflows/`. It calls the reusable workflow [`.github/workflows/fix.yml`](../../.github/workflows/fix.yml), which runs the action in [`actions/fix-runner`](../../actions/fix-runner). Setup steps and the credential's permissions are in [docs/github.md](../github.md#fix-runner); the design and its decisions in [docs/design/fix-runner.md](../design/fix-runner.md).

## Pinning

Callers pin `fix.yml` by full commit SHA. `fix.yml` takes the action with `uses: $/actions/fix-runner`, the self repository reference, which resolves to the same commit as the workflow. One pin therefore fixes both, and no release step has to write an action SHA into the workflow.

Hinomi suggests the commit of the latest release: at run time it reads `GET /repos/Shironex/hinomi/releases/latest`, the commit that tag points at, and checks `fix.yml` exists there (cached for 6 hours, retried after 30 minutes on failure). When that fails it uses `LATEST_FIX_WORKFLOW` in `packages/shared/src/runner-setup.ts`.

Release step: nothing is required, the tag is the record. Optionally, when cutting a release, set `LATEST_FIX_WORKFLOW` to the previous release's tag commit and version, so instances without access to api.github.com still suggest a known good pin. Turn on immutable releases so a tag cannot move under people who pin it.

## What runs where

| Job | Token | Steps |
|---|---|---|
| `apply` | `contents: read`, no secrets | checkout (no persisted credentials); `detect` (validates the plan, names every toolchain); setup of Node, pnpm, yarn, bun and Rust as needed; `apply` (manifest edits and lockfile only installs, no install scripts; sets `base_sha`, `patch_sha256` and `patch_files` as job outputs); `check` (full install and the repo's checks, full mode only); upload of `.hinomi/` as `hinomi-fix-<run_id>`, kept 7 days |
| `publish` | `contents: write` | only when there is a patch: checkout of the base commit; download of the artifact; `publish` (hash and file list against the apply job outputs, the dependency file allowlist, no renames, deletions, mode changes or symlinks), commit as `github-actions[bot]` with `fix(deps): apply hinomi fix plan <id>`, force push of `hinomi/fix-plan`. It never opens the PR. |

Runs are serialized per repo (`hinomi-fix-<owner/repo>`, never cancelled halfway). No step saves a cache. Every third party action is pinned by commit SHA.

**Mixed ecosystems.** A plan whose steps span several lockfiles (a pnpm app and a Rust crate, say) gets every package manager set up; each project is then applied on its own. A project whose lockfile does not match the plan fails its own steps with the reason and the others go on.

## Self test

[`.github/workflows/fix-selftest.yml`](../../.github/workflows/fix-selftest.yml) runs `fix.yml` on pull requests that touch it or the action (and by hand): a plan in `actions/fix-runner/fixtures/selftest-dispatch.json` bumps a real package in an npm and a pnpm fixture project inside this repo, and the publish job runs with `dry_run: true`, so the patch is verified, applied and committed but never pushed.

## Linting

`.github/scripts/lint-workflows.sh` downloads pinned actionlint and zizmor (checked by SHA-256) and lints every workflow plus this template with a dummy SHA. CI runs it in the "Workflow lint" job.
