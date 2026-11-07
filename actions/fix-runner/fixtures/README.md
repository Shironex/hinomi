# Fix runner fixtures

Tiny repos the pipeline tests copy into a temporary folder, `git init` and run the action
against. Package managers are faked at the exec boundary and the registry is mocked, so
nothing here is ever installed (except by the real tool test). Every package name is made up.

- `pnpm-workspace`: a pnpm 10 workspace with `pnpm-workspace.yaml` (an existing override and
  a 14 day `minimumReleaseAge`), two apps that list `plover-parse` with `^` and `~`.
- `pnpm-package-overrides`: a single pnpm project without `pnpm-workspace.yaml`, so overrides go
  to `pnpm.overrides` in `package.json`.
- `npm-overrides`: an npm project with nested `overrides` and `min-release-age` in `.npmrc`.
- `yarn-classic`: a yarn 1 project with a `**/heron-log` resolution.
- `yarn-berry`: a yarn 4 workspace with a range scoped resolution, a git resolved package and a
  `.yarnrc.yml` that sets a two week `npmMinimalAgeGate` and its own registries.
- `bun-text`: a bun project with `bun.lock`, a `resolutions` entry and a 14 day
  `minimumReleaseAge` in `bunfig.toml`. `bun-binary` is its manifest alone; the test writes a
  `bun.lockb` next to it.
- `real-pnpm`, `real-npm`, `real-yarn-classic`, `real-yarn-berry`, `real-bun`: one dependency
  each, for the test that runs the real tool against a registry served on 127.0.0.1 by the test
  itself. The yarn and bun ones have a `postinstall` script the lockfile install must not run.
- `cargo-workspace`: a Cargo workspace with two member crates, `heron-codec` in
  `[workspace.dependencies]` (inherited with `workspace = true`), a target specific `=` pin, a
  `[dependencies.name]` table, dev and build dependencies, a build script that leaves a marker
  if it ever runs, and a Cargo.lock that the real cargo test updates against a sparse
  registry it serves on 127.0.0.1.
- `dispatches`: dispatches the runner must refuse.
