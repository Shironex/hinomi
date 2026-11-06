# Hinomi

**火の見** (hinomi): the fire lookout tower of Edo towns. The watchman did not watch every house; he looked for real smoke and rang the bell.

Hinomi is a small self-hosted app that answers one question: **is anything that is actually deployed and reachable right now exposed to a serious vulnerability?**

It joins your deployments (Coolify first) with advisories (GitHub Dependabot and OSV.dev), so thousands of alerts collapse to the handful that matter, and blind spots (repos with alerts switched off) show up instead of staying silent.

> Early development. Not ready to run yet. See [docs/spec.md](docs/spec.md) for what is being built.

## Development

Requires Node 22 and pnpm (via `corepack enable`).

```sh
pnpm install
pnpm dev        # server on :3000, web on :5173 (proxies /api to the server)
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Run with Docker

```sh
docker compose up -d --build
curl localhost:3000/api/health
```

The container runs as uid 10001 and keeps its SQLite database in the `hinomi-data` volume at `/data`. Migrations run on boot.

## Configuration

No environment variables are required; see [.env.example](.env.example).

| Variable | Default | What it does |
|---|---|---|
| `HOST` | `0.0.0.0` | Address the server listens on. |
| `PORT` | `3000` | Port the server listens on. |
| `HINOMI_DATA_DIR` | `/data` in the container, `./data` in dev | Folder that holds `hinomi.db`. |
| `HINOMI_SECRET_KEY` | unset | Key material for encrypting source tokens at rest (AES-256-GCM). At least 16 characters, for example `openssl rand -base64 32`. Without it Hinomi runs, but sources cannot be connected. Keep it stable: a new key makes stored tokens unreadable. |

Tokens are never logged and never sent to the browser; the API only says whether one is set.
