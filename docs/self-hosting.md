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

A hand built image reports itself as `dev`. To record the commit, add `--build-arg HINOMI_BUILD_COMMIT=$(git rev-parse HEAD)`; it then shows as `dev 3f9a1c7`.

## Version and update check

The rail footer shows the running version (hover for the build commit), and Settings, About lists the version, commit, build date, release notes link and image tag. The release workflow bakes these in through the `HINOMI_BUILD_VERSION`, `HINOMI_BUILD_COMMIT` and `HINOMI_BUILD_DATE` build args; `GET /api/version` serves them.

Once a day (and shortly after boot) Hinomi reads the latest final release from the GitHub releases API: one unauthenticated GET with an ETag and nothing else, no version, no instance id. When a newer release exists, the rail and About say so and link its notes; upgrade with `HINOMI_VERSION=<version> docker compose up -d` or by pulling the image tag. Pre-releases are ignored unless the running build is itself a pre-release. A dev build never checks. Settings, About, "Check for new releases" turns it off. Offline or rate limited, it fails quietly. It is one of several outbound calls, all listed under [Outbound connections](#outbound-connections).

## Outbound connections

Hinomi makes outbound calls only for the jobs below. It sends no telemetry and no instance id, and it never calls a host that is not in this list or that you did not enter. If the container may only reach some hosts, allow these.

| Host | Why | What triggers it | How to turn it off |
|---|---|---|---|
| `api.github.com`, or the API URL of your GitHub source (GitHub Enterprise) | The latest Hinomi release, read without a token (one GET with an ETag, nothing sent about you). | Daily, and shortly after boot. A dev build never asks. | Settings, About, "Check for new releases". |
| `endoflife.date` (`/api/v1/products/full`, one conditional GET) | Support windows for runtimes and frameworks (the `runtime_support` and `framework_support` guards). | Daily, once at least one repo is known. The last good copy is stored and used when the call fails. | No switch. Block the host and those two guards say `unknown`. |
| `api.osv.dev` | Advisories for the packages of your lockfiles. Sends package names and versions only. | Every scan, when there are lockfiles to check. | Settings, Sources, "OSV.dev lockfile scan". Without it, no advisories are matched, and neither are image SBOMs. |
| `api.github.com`, or your GitHub source's API URL | Repo health, Dependabot alerts, lockfiles and pin files, your account's repos, latest releases of your repos. Uses the token you connected. | Every scan. | Disable or remove the GitHub source. |
| Your Coolify, Dokploy or Docker host (the URL or socket you entered) | The inventory: resources, their facts and, with the `coolify` image scan, Coolify's vulnerability results. GET only. | Every scan. | Disable or remove the source. Set `imageScan` to `off` to stop only the Coolify vulnerability reads. |
| The registry host an image names (`registry-1.docker.io` and `auth.docker.io` for Docker Hub, `ghcr.io`, or a private registry), plus the redirect targets it names (blob storage, https only) | The SBOM an image carries, for image only deployments. Stored registry credentials go only to the exact host they were saved for. | Every scan, for image only deployments, and only with the image scan set to `sbom`. | Set the image scan to `coolify` or `off` (Settings, Scans, Image scan). |
| `api.github.com`, for the repository that holds the fix runner (`Shironex/hinomi`) | The commit to pin in the fix runner workflow, from the latest release. Falls back to a built in value when it fails. | When you open a repo's fix runner status or create its setup PR. | Do not use the fix runner. There is no separate switch. |
| `api.github.com` and GitHub's artifact storage | Fix runs on the `github_actions` runner: dispatch the workflow, follow the run and read its result, open the PR. Uses your GitHub token. | When a fix run is dispatched, and while it runs. | Do not dispatch fix runs. |
| The runner URL you entered | The `webhook` runner: a signed POST of the fix plan. | When a fix run is dispatched. | Clear the URL under Settings, Webhook runner. |
| Each notification channel you added: a Discord webhook URL, a webhook URL of your own, or your SMTP server | The notifications you asked for. | When a finding or fix run event reaches the channel's severity. | Disable or remove the channel (Settings, Notifications). |
| `<team>.cloudflareaccess.com` (`/cdn-cgi/access/certs`) | The keys that verify the Cloudflare Access token. | On the first request, and again when a token names an unknown key (rate limited). | Unset `HINOMI_CF_ACCESS_TEAM_DOMAIN`. |

A manual list source makes no call. Inbound webhooks (the optional GitHub webhook and the runner callback) are connections to Hinomi, not from it.

## Configuration in short

Nothing is required to boot, but one value is needed before you can connect a source:

| Variable | Why you set it |
|---|---|
| `HINOMI_SECRET_KEY` | Encrypts source tokens at rest. Without it sources cannot be connected. |
| `HINOMI_SHUTDOWN_TIMEOUT_SECONDS` | Keep it below your stop grace period (default `25`). |
| `HINOMI_TRUSTED_PROXIES`, `HINOMI_CF_ACCESS_TEAM_DOMAIN`, `HINOMI_CF_ACCESS_AUD` | Only for the access setups below. |
| `HINOMI_WEBHOOK_PORT` | Only for the optional [GitHub webhook](github-webhook.md) and the [webhook runner](runners.md#the-webhook-runner) callback: a second port that serves those two paths alone, the one thing safe to expose. |
| `HINOMI_LOCAL_RUNNER` | `1` allows the [local runner](runners.md#the-local-runner), which applies fix plans on this host. Off by default; read its risks first. |
| `HINOMI_LOCAL_RUNNER_CHECKS` | `1` also runs install scripts and checks on the host during a local run. Off by default. |

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

### Docker host source

To read containers from a Docker host, give Hinomi a GET only socket proxy instead of the Docker socket itself. The image and the bundled compose file mount nothing for this; it is an opt in you add yourself.

- **Socket (recommended).** Run a socket proxy that allows only `GET` on `/containers`, `/networks`, `/version` and `/_ping` and listens on a Unix socket, put that socket in a volume shared with Hinomi, and add a Docker host source with the socket path as Hinomi sees it inside its container:

  ```yaml
  services:
    hinomi:
      # as above, plus:
      volumes:
        - hinomi-data:/data
        - docker-proxy:/run/docker-proxy:ro   # the proxy writes its socket here
  ```

  Mounting the raw `/var/run/docker.sock` into Hinomi works too (the image runs as a non root user, so it also needs the socket's group), but it is full control of the daemon, which is root on the host, even read only. The connection test warns when the connection allows more than Hinomi needs.
- **TLS endpoint.** Hinomi refuses plain TCP, also inside a compose network, so a proxy that only listens on `tcp://...:2375` needs TLS in front of it (or the daemon's own TLS on `2376`). Enter it as `https://host:2376` with the CA, client certificate and key.

Mark the containers to read with the label `hinomi.enable=true` (or turn off "only labelled containers"), and add `hinomi.repo` and `hinomi.domains` labels where the image and the proxy labels do not say. See [sources.md](sources.md#docker-hosts).

The proxy container mounts the socket, so the Docker socket check flags it when it is in the inventory: leave it unlabelled, or turn the check off for it with a reason.

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

All tokens are entered in the UI (onboarding or Settings, Sources) and stored encrypted under `HINOMI_SECRET_KEY`. Hinomi only reads. Registry credentials for the image scan are under Settings, Scans; see [Registry credentials](#registry-credentials) for the scopes (a GHCR personal access token needs `read:packages`).

### Coolify

Create an API token in Coolify (Keys and Tokens, API tokens) with the **read** permission only. That is enough to list applications, services and servers, and to read Coolify's image scan results when the [image scan](#image-scan) is on. Use the panel URL reachable from the Hinomi container.

Give the token access to the whole team if you want the server column. Coolify returns server data on applications, services and databases only to a token that covers the whole team; with a narrower token Hinomi still lists every deployment it can read, and the server stays empty.

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

Do this only when you must (the key leaked, say). Stored tokens, GitHub App private keys, registry credentials and notification URLs are encrypted with the key, and Hinomi cannot decrypt them with a new one. After changing `HINOMI_SECRET_KEY`, open every source, registry credential and channel and enter the token, private key, secret or URL again. Until then those sources fail. Keep a backup of the old key and database until everything works again.

### Shutdown grace

On SIGTERM Hinomi waits up to `HINOMI_SHUTDOWN_TIMEOUT_SECONDS` (25) for a running scan, then marks it interrupted. Docker's default grace is 10 s, so set the platform grace higher than the variable: `stop_grace_period: 30s` in compose, "Stop Grace Period" 30 in Coolify, Advanced. If you raise one, raise the other.

### Scan schedule

Scans run every 6 hours by default and on demand. Change the interval (15 minutes to 7 days) under Settings.

### Image scan

Deployments that run an image with no git source (a service from a template, an app deployed from a registry image) have no lockfile to read, so they carry an "image only" coverage note. The image scan covers them. It is off by default; turn it on under Settings, Scans, Image scan, or with the `imageScan` setting (`PATCH /api/settings` with `{ "imageScan": "coolify" }` or `{ "imageScan": "sbom" }`, see [api.md](api.md#settings-and-scans)). `coolify` reads Coolify's own results; `sbom` does the same and, for the deployments Coolify does not cover, reads the SBOM the image carries in its registry.

`coolify` reads the scan results Coolify already computed for the image that actually runs: Hinomi asks `GET /api/v1/vulnerabilities` once per instance and scan, then `GET /api/v1/{applications,services,databases}/{uuid}/vulnerabilities` for each image only deployment. Nothing is installed and no image is pulled. What you need:

- Coolify v4.7.0 (2026-11-09) or newer. Older versions do not have those endpoints. The reader follows the v4.7.0 OpenAPI file; it has not yet been compared with a running instance.
- Image scanning turned on in Coolify for each server (and for the applications you want scanned) (Coolify pulls its scanner onto the server and scans the images there).
- The same read token as for the rest. A token that cannot read the results gets a 403: the scan run and the source show "The Coolify token may not read image scan results (403)", once per instance, and the coverage notes stay.

How it behaves:

- A Coolify without the endpoint (404) is not an error: its deployments keep their "image only" note, and the scan run's Coolify result counts `imageScanUnavailable`. The same holds when image scanning is switched off: Coolify 4.7.0 has no flag for it, so Hinomi treats an instance where no resource has a security status other than `not_checked` as switched off.
- A deployment Coolify does not scan (off for its server or for the resource) keeps its note. While its first scan is still queued or running, the note is left as it is.
- Coolify counts failed requests per token or IP (30 a minute) and then answers `429` with a `Retry-After` header. Hinomi stops asking an instance after the first `403` of a scan, and after the first `429` (error code `rate_limited`): the source shows how long Coolify asked to wait, and the next scan tries again. Nothing is retried in a loop.
- Results are read again only when Coolify reports a newer scan than the one stored (`image_scanned_at` on the deployment, compared with Coolify's `checked_at`), so unchanged images cost one request per instance.
- Advisories become findings reported by `image`, ranked like lockfile advisories on that deployment. A finding ignored in Coolify starts as accepted with the reason "ignored in Coolify". A capped result (Coolify truncated an image's list, more than 2000 findings, or an image whose scan failed in Coolify) gets a "partial image scan" note and never marks anything fixed; the note names the failed images with Coolify's error code.
- Coolify's verdict on the deployment is kept as well: its security status, how many findings are known exploited, its recommended version actions and the end of life OS an image runs on. `GET /api/deployments` returns them as `imageSecurity`.
- Turning the setting off reopens the "image only" notes. Image findings already stored stay as they were until the setting is on again.

#### Registry SBOMs (`sbom`)

With `sbom`, Coolify's results are read first, exactly as above, and win whenever they exist for a deployment. Every other image only deployment (an instance without the endpoint, scanning off for it, a token without access) is looked up in its registry: Hinomi reads the SBOM attestation published with the image and matches its packages on OSV. Nothing is installed and no image layer is pulled.

- It works for images built with an SBOM attestation, the way BuildKit stores one: `docker buildx build --sbom=true`, or `sbom: true` in `docker/build-push-action`. Docker Official Images carry one. Most images do not (many publish provenance only), and each of those says why in a "No image SBOM" note.
- Public images work with no setup, on Docker Hub, ghcr.io and other registries that hand out anonymous pull tokens. A private image is reported as `unauthorized` until its registry has a credential (see [Registry credentials](#registry-credentials) below).
- Matching needs OSV. With OSV switched off, every image says `osv_off` and no registry is asked.
- Per image: one HEAD for the digest the tag points at (Docker Hub does not count HEAD requests against its pull limit). Only when that digest changed are the image index, the attestation manifest and the SBOM read again; what an SBOM said (or that there is none) is kept per image in the database. The packages are matched on OSV every scan, so new advisories show up without a new image.
- The platform read is `linux/amd64`, else `linux/arm64`, else the first image in the index.
- Requests go only to the registry host the image names. Its token service must be on that host or a sibling under its parent domain (Docker Hub: `registry-1.docker.io` and `auth.docker.io`), over https, and resolve to public addresses when it is another host. Redirects (blob storage on a CDN) are followed by hand, at most three, https only, never with the token, and only to hosts that resolve to public addresses. Manifests are capped at 4 MiB and checked against their digest, the SBOM at 32 MiB, every request times out after 20 s. Registries on plain http are not read.
- Distribution packages are matched under their source package (`glibc`, not `libc6`), which OSV indexes. Syft (BuildKit's default SBOM generator) records it; Docker Scout SBOMs (Docker Official Images) do not, so binary packages whose name differs from their source package are missed there. Language packages (Go modules in a binary, `node_modules`) get the same version check as lockfile findings; distribution versions are left to OSV. Supported: Debian, Ubuntu, Alpine, Wolfi, Chainguard, Rocky Linux and AlmaLinux packages, and npm, PyPI, Go, crates.io, RubyGems, Packagist, Maven, NuGet, Pub and Hex packages. Others are skipped.
- Bounds: at most 10 images per deployment, 5000 packages per image, 500 vulnerable packages asked for full records and 2000 findings per image. Past a bound, or when an SBOM entry does not parse, the result is partial: the "partial image scan" note opens and nothing is marked fixed. An image of a service that has no SBOM this time leaves the advisories already stored for that deployment alone.
- A failed read (network, timeout, rate limit) leaves the findings and the "image only" note as they are, says `error` in the note and is tried again next scan. An OSV outage shows on the scan run once.

#### Registry credentials

For private images, add a login per registry under Settings, Scans, Registry credentials (or with the [API](api.md#registry-credentials)). The secret is stored encrypted under `HINOMI_SECRET_KEY` like source tokens, so the key must be set; it is never shown again, logged or returned by the API.

| Registry | Host | User name | Secret |
|---|---|---|---|
| GitHub Container Registry | `ghcr.io` | your GitHub user name | a personal access token (classic) with the `read:packages` scope only. Fine-grained tokens cannot read packages yet. For an organization with SAML SSO, authorize the token for it |
| Docker Hub | `docker.io` (stored as `registry-1.docker.io`) | your Docker Hub user name | a personal access token with the **Read-only** access permission |
| Any other OCI registry | its host, with the port if it has one (`registry.example.com:5000`) | the registry user | its password, or an access token that can pull |

How a credential is used:

- It is matched on the exact host the image names, port included; there are no wildcards. `docker.io`, `index.docker.io` and `registry-1.docker.io` are one host, and `:443` is dropped. An image on another host never gets it.
- It is read only when the registry answers 401. For a registry that names a token service (the OCI token flow: `WWW-Authenticate: Bearer realm, service`), Hinomi asks that service for a pull token scoped to the one repository (`repository:<name>:pull`), sending the login as Basic auth, and uses the token for the reads. For a registry that answers a `Basic` challenge, the login goes to the registry itself.
- The login goes to the token service only when it is on the registry host itself, or a known auth host of it: `auth.docker.io` for Docker Hub and `gitlab.com` for `registry.gitlab.com`. A token service on any other host (even a sibling the anonymous rule allows) is asked without the login, and the image says so in its note. Token requests follow no redirects; redirects of the registry (blob storage on a CDN) never carry the token or the login.
- Wrong credentials or a token without pull access show as `unauthorized` in the image's note, with what was refused. A credential that cannot be decrypted (the key changed) shows the same way: enter it again.

Only image only deployments are scanned; apps built from a repo are covered by their lockfiles and alerts. A scanner sidecar (Trivy or Grype as a second container that pulls and scans every image) is documented only, and Hinomi does not ship it: it needs a vulnerability database of hundreds of MB, registry credentials and image pulls, and on Coolify it would duplicate what Coolify already does.

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
