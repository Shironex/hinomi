# Self-hosting

This guide takes you from nothing to a protected Hinomi that scans on its own. Hinomi is one container with a SQLite database in `/data`. It has no login yet, so decide how people reach it (see [Protect access](#protect-access)) before you connect any token.

Contents: [Image or source](#get-the-image) | [Docker compose](#plain-docker-compose) | [Coolify](#coolify) | [Protect access](#protect-access) | [Tokens](#tokens) | [Operations](#operations) | [Troubleshooting](#troubleshooting)

## Get the image

There are two ways to run it:

- **The published image**, `ghcr.io/shironex/hinomi`. Images for `linux/amd64` and `linux/arm64` are published on every release, tagged `X.Y.Z`, `X.Y` and `latest`, with an SBOM and build provenance. Pin a version tag in production rather than following `latest`. Until the first release is tagged there is nothing to pull; build from source meanwhile.
- **Build from source**. The repo has a `Dockerfile` (Node 26 on Alpine, runs as uid 10001) and a `docker-compose.yml` with the build lines commented in the file.

```sh
git clone https://github.com/Shironex/hinomi.git
cd hinomi
docker build -t hinomi:local .
```

## Configuration in short

Nothing is required to boot, but one value is needed before you can connect a source:

| Variable | Why you set it |
|---|---|
| `HINOMI_SECRET_KEY` | Encrypts source tokens at rest. Without it sources cannot be connected. |
| `HINOMI_SHUTDOWN_TIMEOUT_SECONDS` | Keep it below your stop grace period (default `25`). |
| `HINOMI_TRUSTED_PROXIES`, `HINOMI_CF_ACCESS_TEAM_DOMAIN`, `HINOMI_CF_ACCESS_AUD` | Only for the access setups below. |

The full table is in the [README](../README.md#configuration) and [.env.example](../.env.example).

Generate the secret key once:

```sh
openssl rand -base64 32
```

Store it in a password manager. Treat it as shown once: you cannot read it back from Hinomi, and a new key makes every stored token unreadable (see [Rotating the secret key](#rotating-the-secret-key)).

## Plain docker compose

Create a `.env` next to `docker-compose.yml` (compose reads it when present):

```sh
HINOMI_SECRET_KEY=<output of openssl rand -base64 32>
```

Then, next to the `docker-compose.yml` from the repo (or a clone of it):

```sh
docker compose up -d   # HINOMI_VERSION=0.1.0 docker compose up -d pins a release
curl http://127.0.0.1:3000/api/health   # {"status":"ok"}
```

The bundled compose file pulls `ghcr.io/shironex/hinomi` (`latest` unless `HINOMI_VERSION` is set), keeps the database in the `hinomi-data` volume at `/data`, and sets `stop_grace_period: 30s`.

To build from source instead, switch to the commented `build: .` lines in the compose file and run `docker compose up -d --build`. To customise the published image, for example to bind only to a tailnet address, use a compose file like this:

```yaml
services:
  hinomi:
    image: ghcr.io/shironex/hinomi:<version>
    # Only on the tailnet address, never on 0.0.0.0 of a public host.
    ports:
      - '<tailnet-ip>:3000:3000'
    environment:
      HINOMI_SECRET_KEY: ${HINOMI_SECRET_KEY}
    volumes:
      - hinomi-data:/data
    restart: unless-stopped
    stop_grace_period: 30s

volumes:
  hinomi-data:
```

The bundled file publishes `3000:3000` on all interfaces. On a server with a public address, change it to `<tailnet-ip>:3000:3000` (or `127.0.0.1:3000:3000` with `tailscale serve` or a reverse proxy in front).

## Coolify

This is the setup Hinomi was first deployed with.

1. **Create the application.** New resource, either a Docker image (`ghcr.io/shironex/hinomi:<version>`) or a public repository `Shironex/hinomi` with the Dockerfile build pack. Port `3000`.
2. **Publish the port on the tailnet only.** In the application's port mappings use:

   ```
   <tailnet-ip>:3000:3000
   ```

   Set no domain. Coolify can generate one when the application is created: clear it, or the app is reachable from the internet through the proxy.
3. **Persistent storage.** Add a volume mounted at `/data`. Without it the database is lost on every redeploy.
4. **Environment.** Add `HINOMI_SECRET_KEY` (from `openssl rand -base64 32`, stored shown once) and `HINOMI_SHUTDOWN_TIMEOUT_SECONDS=25`.
5. **Health check.** Under Healthcheck: path `/api/health`, host `127.0.0.1`, port `3000`. Use the IP, not `localhost`: the image has no `curl`, and busybox `wget` resolves `localhost` to IPv6 while the server listens on IPv4, so the check fails and the app is marked unhealthy.
6. **Stop grace period.** Under Advanced, "Stop Grace Period (seconds)": `30`. It must stay above `HINOMI_SHUTDOWN_TIMEOUT_SECONDS`, or the container is killed while a scan is finishing.
7. **Deploy**, then open `http://<tailnet-ip>:3000` from a device on the tailnet. Onboarding starts there.

When the app was created from a public repository there is no webhook, so redeploys are manual: press Deploy after a new version. See [Upgrades](#upgrades).

### Coolify behind a firewall

Hinomi calls Coolify's API (`/api/v1/...`) from the container. If the panel's public address is firewalled (or only reachable by browser through a tunnel), point the Coolify source at the panel over the tailnet instead:

```
http://<panel-tailnet-ip>:8000
```

The server running Hinomi must be on the tailnet too, or able to reach that address.

## Protect access

Hinomi has no login. Pick one of these, then check Settings, Access (or the sidebar): it must say "Protected by Tailscale" or "Protected by Cloudflare Access". Details and every state are in [access.md](access.md).

### Tailscale

Publish the port on the host's tailnet address (`<tailnet-ip>:3000:3000`), as above. With Tailscale in its normal kernel mode, a remote tailnet device reaches the container with its real `100.x` source address through the Docker port mapping, so Hinomi shows "Protected by Tailscale" with no setting.

Connections the host makes itself (Tailscale in userspace networking mode, `tailscale serve` on the host, a reverse proxy on the host) arrive from a bridge address and show as "unknown". For `tailscale serve`, list the bridge gateway so the login is believed, and only when nothing else on the host uses the port:

```sh
HINOMI_TRUSTED_PROXIES=<bridge-gateway>   # for example the docker0 gateway
```

### Cloudflare Access

Put a Cloudflare Access application in front of the hostname (for example through a `cloudflared` tunnel), then give Hinomi the team name and the application's AUD tag so it verifies the signed token:

```sh
HINOMI_CF_ACCESS_TEAM_DOMAIN=<your-team-name>
HINOMI_CF_ACCESS_AUD=<Application Audience (AUD) tag>
```

Set both or neither; one alone is a startup error. The AUD tag is under Access controls, Applications, your app, Basic information. Without these the header is only reported as "seen, not verified". Behind a `cloudflared` tunnel the peer is the tunnel container, so also list its network in `HINOMI_TRUSTED_PROXIES` if you want the client address.

## Install as an app

The web app is an installable PWA: it gets its own window or home screen icon, and it keeps the app shell (not your data) cached so it opens when the server is unreachable. It shows an offline notice then, and loads live data again when the connection is back.

Installing needs HTTPS (or `localhost`). Browsers only offer to install, and only run the service worker, on a secure origin. A plain `http://100.x.y.z:3000` tailnet address is not one, so it cannot install; it still works as a normal web page. Put an HTTPS address in front of Hinomi first:

- `tailscale serve` on the host gives the tailnet a `https://<machine>.<tailnet>.ts.net` address with a real certificate.
- A Cloudflare Tunnel with an Access application gives a public `https://` hostname behind login.

Then, from that HTTPS address:

- **iOS (Safari):** Share, Add to Home Screen.
- **Android (Chrome):** menu, Install app (or Add to Home screen).
- **Desktop (Chrome, Edge):** the install icon in the address bar, or menu, Install Hinomi.

When a new version is deployed, an open app shows "New version available" with a Reload button. It never reloads on its own, so a triage in progress is not lost; a closed app picks the update up the next time it opens. The data endpoints under `/api` are never cached.

## Tokens

All tokens are entered in the UI (onboarding or Settings, Sources) and stored encrypted under `HINOMI_SECRET_KEY`. Hinomi only reads.

### Coolify

Create an API token in Coolify (Keys and Tokens, API tokens) with the **read** permission only. That is enough to list applications, services and servers. Use the panel URL reachable from the Hinomi container.

### GitHub

| Option | Covers | Permissions |
|---|---|---|
| Classic token | Every owner you can see, in one source | `repo` and `security_events` |
| Fine-grained token | One owner per token | Dependabot alerts (read), Metadata (read), Contents (read), Administration (read) |
| GitHub App | One installation, so one owner | Read-only Dependabot alerts, Contents, Metadata, Administration |

What each permission is for:

- **Dependabot alerts**: the alerts themselves.
- **Contents**: lockfiles for the OSV.dev scan of private repos.
- **Metadata**: repo names, archived state, default branch.
- **Administration**: whether Dependabot alerts are switched on. Without it every repo shows the "alerts unknown" blind spot.

A classic token with `repo` and `security_events` covers several owners in one source, which makes it the least work. Fine-grained tokens and GitHub Apps are per owner: add one source per owner. For an organization with SAML SSO, authorize the token for it (Configure SSO on the token page) or its repos stay hidden. Step by step setup of the App, including the private key, is in [github.md](github.md).

## Operations

### Upgrades

Migrations run on boot, so an upgrade is a redeploy of a newer image.

- Image: change the tag, then pull and recreate (`docker compose pull && docker compose up -d`, or Deploy in Coolify).
- Source: `git pull`, then `docker compose up -d --build`.
- Coolify with a public repository and no webhook: redeploys are manual. Press Deploy.

Take a backup first; migrations only go forward. The container stops cleanly on SIGTERM, waiting for a running scan (see [Shutdown grace](#shutdown-grace)).

### Backups

Everything lives in `/data` (`hinomi.db`, plus `-wal` and `-shm` files while running, since the database is in WAL mode). Back up the whole volume, and keep the `HINOMI_SECRET_KEY` with the backup: a restored database without its key has unreadable tokens.

The safest copy is taken while the app is stopped:

```sh
docker compose stop hinomi
docker run --rm -v hinomi-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/hinomi-data-$(date +%F).tgz -C /data .
docker compose start hinomi
```

On Coolify, stop the application, then use the server's volume path or a scheduled backup of the volume. To restore, stop Hinomi, empty the volume, extract the archive into it, and start. Files must be owned by uid 10001:

```sh
docker run --rm -v hinomi-data:/data -v "$PWD":/backup alpine \
  sh -c 'tar xzf /backup/hinomi-data-<date>.tgz -C /data && chown -R 10001:10001 /data'
```

### Rotating the secret key

Do this only when you must (the key leaked, say). Stored tokens, GitHub App private keys and notification URLs are encrypted with the key, and Hinomi cannot decrypt them with a new one. After changing `HINOMI_SECRET_KEY`, open every source and channel and enter the token, private key or URL again. Until then those sources fail. Keep a backup of the old key and database until everything works again.

### Shutdown grace

On SIGTERM Hinomi waits up to `HINOMI_SHUTDOWN_TIMEOUT_SECONDS` (25) for a running scan, then marks it interrupted. Docker's default grace is 10 s, so set the platform grace higher than the variable: `stop_grace_period: 30s` in compose, "Stop Grace Period" 30 in Coolify, Advanced. If you raise one, raise the other.

### Scan schedule

Scans run every 6 hours by default and on demand. Change the interval (15 minutes to 7 days) under Settings.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Coolify marks the app unhealthy, `/api/health` works by hand | The check uses `localhost`. Set the host to `127.0.0.1` (IPv6 vs IPv4, no `curl` in the image). |
| Container is killed during a stop, scan marked interrupted | Grace period shorter than `HINOMI_SHUTDOWN_TIMEOUT_SECONDS`. Raise the grace to 30 s or lower the variable. |
| Cannot connect a source, sources cannot be saved | `HINOMI_SECRET_KEY` is not set (or shorter than 16 characters). Set it and redeploy. |
| Sources worked, now fail after a redeploy | The key changed, or the volume at `/data` is missing so the app started fresh. Restore the key or volume, or enter the tokens again. |
| Coolify test fails with a timeout or connection error | The panel's public API is firewalled. Use `http://<panel-tailnet-ip>:8000` and make sure the Hinomi host can reach it. |
| Coolify test fails with 401 or 403 | The token is wrong or has no read permission. Create a new read token. |
| GitHub shows few repos | Classic token missing `repo`, an owner not covered (fine-grained tokens and Apps are per owner), or SSO not authorized for the token. |
| Every repo shows "alerts unknown" | The token or App lacks Administration (read). |
| Sidebar says the address is "unknown" | Request came from a bridge address (host-side proxy, `tailscale serve`, userspace Tailscale). See [access.md](access.md#behind-a-docker-port-mapping). |
| Sidebar says "public" in red | The app is reachable from the internet. Remove the domain and public port mapping, or put Access in front. |
| "Header seen, not verified" | Cloudflare Access variables not set, or the signing keys could not be fetched. Check both variables and outbound access to `<team>.cloudflareaccess.com`. |
| Scans fail with rate limit errors | Raise the scan interval under Settings. GitHub allows more requests with a token; OSV.dev lookups retry on their own after a 429. |
| New version not running on Coolify | No webhook on a public-repository app: press Deploy. |
| `permission denied` on `/data` | The volume is not owned by uid 10001. Run `chown -R 10001:10001` on it. |
