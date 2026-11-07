# Fix runner fixtures

Tiny repos the pipeline tests copy into a temporary folder, `git init` and run the action
against. Package managers are faked at the exec boundary and the registry is mocked, so
nothing here is ever installed. Every package name is made up.

- `pnpm-workspace`: a pnpm 10 workspace with `pnpm-workspace.yaml` (an existing override and
  a 14 day `minimumReleaseAge`), two apps that list `plover-parse` with `^` and `~`.
- `pnpm-package-overrides`: a single pnpm project without `pnpm-workspace.yaml`, so overrides go
  to `pnpm.overrides` in `package.json`.
- `npm-overrides`: an npm project with nested `overrides` and `min-release-age` in `.npmrc`.
- `real-pnpm`, `real-npm`: one dependency each, for the test that runs the real pnpm and npm
  against a registry served on 127.0.0.1 by the test itself (no network).
- `cargo-workspace`: a Cargo workspace with two member crates, `heron-codec` in
  `[workspace.dependencies]` (inherited with `workspace = true`), a target specific `=` pin, a
  `[dependencies.name]` table, dev and build dependencies, a build script that leaves a marker
  if it ever runs, and a Cargo.lock that the real cargo test updates against a sparse
  registry it serves on 127.0.0.1.
- `dispatches`: dispatches the runner must refuse.
