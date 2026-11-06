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
| `HINOMI_TRUSTED_PROXIES` | unset | Comma separated IPs or CIDR ranges of reverse proxies whose `X-Forwarded-For`, `CF-Connecting-IP` and Tailscale identity headers are believed. Unset, they are all ignored. See [docs/access.md](docs/access.md). |
| `HINOMI_CF_ACCESS_TEAM_DOMAIN` | unset | Cloudflare Access team name or `https://<team>.cloudflareaccess.com`. With `HINOMI_CF_ACCESS_AUD`, Hinomi verifies the Access token and shows "Protected by Cloudflare Access". |
| `HINOMI_CF_ACCESS_AUD` | unset | Application Audience (AUD) tag of the Access application. Set both Cloudflare variables or neither. |
| `HINOMI_SHUTDOWN_TIMEOUT_SECONDS` | `25` | How long a stop (SIGTERM or SIGINT) waits for a running scan before it is marked interrupted. Whole seconds from 0 to 3600. Keep it below the stop grace of your platform, or the container is killed first. |

Tokens and GitHub App private keys are never logged and never sent to the browser; the API only says whether one is set. GitHub connects with a personal access token or a GitHub App, see [docs/github.md](docs/github.md).

### Stopping while a scan runs

On a stop the server waits for the running scan (up to `HINOMI_SHUTDOWN_TIMEOUT_SECONDS`) so it can finish and be saved. Docker kills the container after its stop grace period, 10 s by default, so the bundled `docker-compose.yml` sets `stop_grace_period: 30s`. If you raise the variable, raise the grace period above it. On Coolify, set the same in the application under Advanced, "Stop Grace Period (seconds)" (empty means 30 s, accepted values 1 to 3600).
