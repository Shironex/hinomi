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
- `dispatches`: dispatches the runner must refuse.
