# Built in login

Hinomi can require a login of its own, for setups that cannot put it behind Tailscale or Cloudflare Access. It is off by default: an install that does not set `HINOMI_AUTH` behaves exactly as before, and the network in front of it is the only protection (see [access.md](access.md)).

There are no passwords. You sign in with one of:

- **A passkey** (Touch ID, Windows Hello, a phone, a security key or a password manager). The first one is registered with a setup code from the container.
- **OpenID Connect**: Authentik, Authelia, Keycloak, Google, or any provider with discovery.
- **GitHub**, through an OAuth app.

Hinomi has a single admin: everyone who may sign in has the same rights. Who that is comes from the passkeys you registered and from the allow list for the providers.

## Turn it on

```sh
HINOMI_AUTH=1
HINOMI_AUTH_PUBLIC_URL=https://hinomi.example.dev
```

`HINOMI_AUTH_PUBLIC_URL` is the address people type into the browser, an origin with no path. It is used for three things: the only origin allowed to make changes, the relying party of passkeys (its host name), and the redirect URIs of the providers. Use https in production. Over plain http (for example `http://localhost:3000` while trying it out) the session cookie loses its `Secure` flag and the server warns at boot; passkeys work on http only on `localhost`.

Then register the first passkey:

1. Run this in the container. It prints a code that works once, for 15 minutes:

   ```sh
   docker exec -it <container> node apps/server/dist/cli.mjs setup-code
   ```

2. Open Hinomi, choose **Use a setup code**, enter the code and a name for the passkey, and confirm the browser prompt. You are signed in.

More passkeys (a second device, a security key as a backup) are added under Settings, Access, while signed in. With only passkeys and no provider, Hinomi refuses to remove the last one, so you cannot lock yourself out from the browser.

The code is printed to that terminal only and never written to the server log, so it is safe to run the command while logs are shipped elsewhere. A new code replaces the old one.

## OpenID Connect

Create an OAuth2 or OpenID Connect client (confidential, authorization code flow) with this redirect URI:

```
https://hinomi.example.dev/api/auth/oidc/callback
```

Then set:

```sh
HINOMI_AUTH_OIDC_ISSUER=https://id.example.dev/application/o/hinomi
HINOMI_AUTH_OIDC_CLIENT_ID=...
HINOMI_AUTH_OIDC_CLIENT_SECRET=...
HINOMI_AUTH_OIDC_NAME=Authentik            # the button says "Sign in with Authentik"
HINOMI_AUTH_ALLOWED=ops@example.dev,@kestrel.example.dev
```

The issuer is the URL whose `/.well-known/openid-configuration` answers (https, or http on `localhost` only). Hinomi asks for the `openid email profile` scopes, uses PKCE, state and nonce, and checks the ID token's signature (RS256 or ES256), issuer, audience, expiry and nonce. An email counts only when the provider says it is verified (`email_verified: true`).

- **Authentik**: Applications, Providers, OAuth2/OpenID Provider. The issuer is `https://<authentik>/application/o/<slug>`.
- **Authelia**: add a client under `identity_providers.oidc.clients` with `redirect_uris` set to the callback above and `token_endpoint_auth_method: client_secret_basic`. The issuer is Authelia's own URL.
- **Google**: Google Cloud console, APIs and Services, Credentials, OAuth client ID of type Web application. The issuer is `https://accounts.google.com`.

## GitHub

Create an OAuth app (Settings, Developer settings, OAuth Apps) with the callback URL:

```
https://hinomi.example.dev/api/auth/github/callback
```

```sh
HINOMI_AUTH_GITHUB_CLIENT_ID=...
HINOMI_AUTH_GITHUB_CLIENT_SECRET=...
HINOMI_AUTH_ALLOWED=github:kestrel-ops
```

Hinomi asks for `read:user user:email`, reads the login and the verified emails, and then forgets the GitHub token: it is never stored and never used for anything else. This app is separate from the GitHub source that scans your repos.

`github:<login>` matches a GitHub login. A login can be renamed, and a released login can be taken by someone else, so prefer a verified email of the account (`ops@example.dev`) when you can.

## Who may sign in

`HINOMI_AUTH_ALLOWED` is a comma separated list, required as soon as a provider is set (without it anyone with an account at the provider could sign in):

| Entry | Matches |
|---|---|
| `ops@example.dev` | That verified email, from either provider |
| `@kestrel.example.dev` | Any verified email at that domain (not its subdomains) |
| `github:kestrel-ops` | That GitHub login |
| `oidc:3f2a...` | That `sub` claim from your OpenID Connect provider |

A refused login is recorded in the audit log, with what the provider said, and the browser is told only that the account is not on the list. Removing someone from the list ends their provider sessions at the next restart; to end them right away, run `revoke-sessions` (below) or end them under Settings, Access.

Passkeys do not go through the list: whoever holds a registered passkey may sign in.

## Lost access

All of these run in the container and print to that terminal only:

| Command | What it does |
|---|---|
| `node apps/server/dist/cli.mjs setup-code` | A new one time code, to register a passkey on the login page. Existing passkeys keep working. |
| `node apps/server/dist/cli.mjs reset` | Removes every passkey and ends every session, then prints a setup code. For a lost or stolen passkey. |
| `node apps/server/dist/cli.mjs revoke-sessions` | Ends every session; everyone signs in again. |

With docker compose: `docker compose exec hinomi node apps/server/dist/cli.mjs reset`. In Coolify, use the Terminal tab of the application. Each command is recorded in the audit log.

Turning the login off (`HINOMI_AUTH` unset) and restarting also gets you back in, and ends every session; turning it on again brings the passkeys back.

## Sessions

- A session is a random token in an HttpOnly cookie, `__Host-hinomi_session` on https (`hinomi_session` on http), with `SameSite=Lax` and `Path=/`. The database keeps only its SHA-256, so a copy of `hinomi.db` holds no usable session.
- A session ends after 12 hours without a request, and after 7 days in any case. Signing in again replaces the old session of that browser.
- Signing out, ending a session under Settings, Access, removing the passkey that started it, or running `revoke-sessions` ends it on the server at once.
- Every change (any method but GET and HEAD) needs the session's CSRF token in the `x-hinomi-csrf` header, and an `Origin` equal to `HINOMI_AUTH_PUBLIC_URL` (or, without `Origin`, `Sec-Fetch-Site: same-origin`). The web app does this for you.
- Failed sign ins back off per client address and per account: five are free, then each waits twice as long as the last, up to 15 minutes. The answer is `429` with a `Retry-After` header.

## What stays public

With the login on, every route under `/api` answers `401` without a session, unknown ones too, except:

- `GET /api/health`, which then answers `{"status":"ok"}` only, without the version.
- The login routes themselves (`/api/auth/session`, the provider redirects and callbacks, the passkey and setup code steps, logout).
- `POST /api/github/webhook` and `POST /api/runner/callback`, which check their own signatures (see [github-webhook.md](github-webhook.md) and [runners.md](runners.md)).

The web app's files (HTML, scripts, styles) are served to anyone, as on any site; they hold no data.

## Behind a reverse proxy

- Set `HINOMI_AUTH_PUBLIC_URL` to the address the proxy serves, not the container's. A mismatch shows as changes refused with `403 forbidden` and passkey prompts that fail.
- The proxy must pass the `Host`, `Origin` and `Sec-Fetch-*` headers through unchanged (Caddy, Traefik and nginx do by default).
- Terminate https at the proxy. Hinomi decides on the `Secure` cookie from the public URL, not from the request, so http between the proxy and the container is fine.
- List the proxy in `HINOMI_TRUSTED_PROXIES`, or every request seems to come from the proxy's address: the backoff would then lock everyone out together, and the audit log would show the proxy instead of the client. Do not list it when anything else can reach the container directly, since a trusted peer can claim any address in `X-Forwarded-For`.
- Tailscale or Cloudflare Access in front still help: they keep the login page itself off the internet.

## Audit log

Settings, Audit log lists, newest first:

- sign ins, with the method and who; refused sign ins, with the reason;
- sign outs, passkeys added and removed, sessions ended, setup codes used and resets from the container;
- every change made through the API: the method, the path, the status and who made it.

It never holds a request body, a token or a code. It keeps the newest 10,000 entries. Changes are recorded with the login off too, without a name.

## Outbound calls

With OpenID Connect set, Hinomi calls your issuer (discovery, its signing keys and the token endpoint) when someone signs in. With GitHub set, it calls `github.com` (the token exchange) and `api.github.com` (the user and their emails). Nothing is called while nobody signs in. See [Outbound connections](self-hosting.md#outbound-connections).
