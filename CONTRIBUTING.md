# Contributing to Hinomi

Thanks for wanting to help. Hinomi is a small project that I maintain on my own, so a few ground rules keep it manageable for both of us.

## Issues and discussions first

I accept pull requests only after an issue or a discussion has agreed on the change.

- Found a bug? Open a [bug report](https://github.com/Shironex/hinomi/issues/new/choose).
- Want a feature? Open a feature request, or float a rough idea in [Discussions](https://github.com/Shironex/hinomi/discussions) first.
- Have a question? Use the Q&A category in Discussions.
- Found a vulnerability? Do not open an issue, follow [SECURITY.md](SECURITY.md).

Once we agree, say so on the issue that you would like to build it, and link it from your pull request. A pull request without an agreed issue will most likely be closed, which is never about the quality of the work. Hinomi has a narrow scope (see [docs/spec.md](docs/spec.md)) and I would rather tell you early than after you spent a weekend on it.

## Development setup

You need Node 26 and pnpm through corepack. Node 26 no longer bundles corepack, so install it once first.

```sh
npm install --global corepack
corepack enable
git clone https://github.com/Shironex/hinomi.git
cd hinomi
pnpm install
pnpm dev        # server on :3000, web on :5173
```

Use pnpm only, not npm or yarn. The repo applies a 7 day minimum release age to packages, so if an install refuses a very fresh version, pick an older release instead of disabling the gate. Use native `fetch` for HTTP and think twice before adding a dependency; a new one needs a reason in the pull request.

## The gate

Everything below must pass before you open a pull request, and CI runs the same checks:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm format` fixes formatting. A Husky hook runs lint-staged and commitlint on commit.

## Screenshots

The README images come from a fixture mode of the web app, captured with [`@noctcore/showcase-kit`](https://www.npmjs.com/package/@noctcore/showcase-kit). Regenerate them after a UI change:

```sh
pnpm exec playwright install chromium   # once
pnpm showcase                           # dark, light and phone sets, then the hero
pnpm showcase dark phone                # only some sets
pnpm showcase readme                    # print the README table of the dark set
```

The kit runs `vite build --mode fixtures` and serves it on `localhost:15190`, so no server, token or network access is needed. Framed images land in `assets/showcase` (commit them); raw captures go to `showcase-out/`, which is ignored. Two runs on the same machine give the same bytes.

Fixture mode lives in `apps/web/src/fixtures`: `dataset.ts` is the invented instance (the `kestrel-co` organization, `example.dev` hosts, made up packages and advisories) on a clock frozen at 5 November 2026, 10:00 UTC (dates are formatted in UTC whatever the machine's time zone), and `routes.ts` answers every `/api` read from it. Writes are refused. Only the `fixtures` Vite mode boots through it, so a normal build never contains it and there is no flag to turn it on in production. To click around it yourself, run `pnpm --filter @hinomi/web dev:fixtures` (add `?fixture=setup` to the URL for the first run).

## Commits

Small commits, one logical change each, written as conventional commits with a scope:

```
type(scope): lowercase summary
```

Types are the usual ones (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`). The scope is required and must be one of:

`repo`, `server`, `web`, `shared`, `sources`, `infra`, `ci`, `deps`, `docs`, `spec`

Pull request titles follow the same shape.

## Pull requests and history

I merge with rebase, so every commit on your branch lands on `main` exactly as written. Please keep the history clean:

- each commit builds and passes tests on its own,
- no "fix lint" or "address review" commits: fold them into the commit they belong to (`git commit --fixup`, then `git rebase -i --autosquash`),
- rebase onto `main`, do not merge `main` into your branch.

Fill in the pull request template, link the issue with `Closes #123`, and include screenshots for UI changes. I review every pull request myself, usually within a few days.

## No AI attribution lines

Please leave `Co-Authored-By` trailers and "generated with" footers out of commits and pull request descriptions. You are welcome to use any tools you like, but you are responsible for the change and I review it as yours.

## Public repository hygiene

Never put real hostnames, IP addresses, tokens or names of private servers in code, fixtures, tests, docs or screenshots. Use invented data such as the `kestrel-co` organization, domains under `example.dev` and servers like `edge-1`.

## License

Hinomi is licensed under [AGPL-3.0](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.

Please also follow the [Code of Conduct](CODE_OF_CONDUCT.md).
