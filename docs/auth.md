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

`HINOMI_AUTH_PUBLIC_URL` is the address people type into the browser, an origin with no path. It is used for three things: the only origin allowed to make changes, the relying party of passkeys (its host name), and the redirect URIs of the providers. Use https. Plain http is accepted only on `localhost`, `127.0.0.1` or `[::1]` while trying it out (the session cookie then loses its `Secure` flag and the server warns at boot); any other http host is a startup error unless you also set `HINOMI_AUTH_ALLOW_HTTP=1` and accept that the cookie crosses the network in the clear. Passkeys work on http only on `localhost`.

The server refuses to start when a `HINOMI_AUTH_*` variable is set but `HINOMI_AUTH` is not, since that looks like a protected install that is not. Set `HINOMI_AUTH=0` to keep such settings around with the login off on purpose.

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
- **Google**: Google Cloud console, APIs and Services, Credentials, OAuth client ID of type Web application. The issuer is `https://accounts.google.com`. Google's token endpoint is on another host, so also set `HINOMI_AUTH_OIDC_TOKEN_ORIGIN=https://oauth2.googleapis.com`.

The client secret is sent to the token endpoint the discovery document names. Hinomi refuses a token endpoint that is not on the issuer's own origin, unless that origin is named in `HINOMI_AUTH_OIDC_TOKEN_ORIGIN`. ID tokens must name the issuer exactly as the discovery document does, carry an `iat` no more than 10 minutes old, and not come from the future (one minute of clock skew is allowed).

## GitHub

Create an OAuth app (Settings, Developer settings, OAuth Apps) with the callback URL:

```
https://hinomi.example.dev/api/auth/github/callback
```

```sh
HINOMI_AUTH_GITHUB_CLIENT_ID=...
HINOMI_AUTH_GITHUB_CLIENT_SECRET=...
HINOMI_AUTH_ALLOWED=github:id:583231
```

Allow GitHub accounts by their numeric id, which never changes. Look it up with `curl -s https://api.github.com/users/<login>` (the `id` field).

Hinomi asks for `read:user user:email`, reads the account id, the login and the primary email (only when GitHub verified it), and then forgets the GitHub token: it is never stored and never used for anything else. Secondary emails are ignored, because anyone can add and verify an address at a domain where they can receive mail. This app is separate from the GitHub source that scans your repos.

`github:<login>` also works, but a login can be renamed and a released login can be registered by someone else. Hinomi pins such a rule to the account id that first signs in with it, refuses a later login with the same name and another id, and records that refusal in the audit log. After a rename the account needs the new login or a `github:id:` rule.

## Who may sign in

`HINOMI_AUTH_ALLOWED` is a comma separated list, required as soon as a provider is set (without it anyone with an account at the provider could sign in):

| Entry | Matches |
|---|---|
| `github:id:583231` | That GitHub account, by its numeric id (preferred for GitHub) |
| `ops@example.dev` | That verified email, from either provider |
| `@kestrel.example.dev` | Any verified email at that domain (not its subdomains) |
| `github:kestrel-ops` | That GitHub login, pinned to the first account id that uses it |
| `oidc:3f2a...` | That `sub` claim from your OpenID Connect provider |

Emails are matched only in plain ASCII form: one `@`, no quoted local part, no comments, and a host name domain, lowercased in ASCII. Addresses with non ASCII characters never match, so look alikes such as the KELVIN SIGN (U+212A, which some lowercasing turns into `k`) cannot slip in.

### Domain rules are only as strong as the provider's "verified"

An `@domain` rule trusts the provider to say that the person controls that address. Check that before you rely on one:

- **GitHub**: only the primary verified email counts. A person can still make any address they verified their primary one, so use `@domain` with GitHub only for a domain whose mailboxes you control, and prefer `github:id:` rules.
- **OpenID Connect**: Hinomi trusts `email_verified: true` in the ID token. Find out what your provider maps it from. Authentik and Keycloak can be set to report every email as verified, and some setups let users edit their own email. Sign in with a test account, change its email to one at your domain, and see whether it is still reported as verified. If it is, use `oidc:<sub>` or exact emails instead of a domain rule.

A refused login is recorded in the audit log, with what the provider said, and the browser is told only that the account is not on the list. Removing someone from the list ends their provider sessions at the next restart; to end them right away, run `revoke-sessions` (below) or end them under Settings, Access.

Passkeys belong to whoever registered them. A passkey added while signed in through a provider (directly, or through another passkey of that person) carries that provider subject, and Settings, Access shows it. When the subject leaves the list while its provider is configured, the passkey is refused at its next use and removed at the next restart, together with the sessions it started. While its provider is not configured (taken out for a while, say), the passkey is refused and its sessions end at the next restart, but it is kept, and it works again once the provider is back. Passkeys registered with a setup code belong to the admin and do not go through the list. A passkey session is signed in as its owner, not as the name the passkey was given.

## Lost access

All of these run in the container and print to that terminal only:

| Command | What it does |
|---|---|
| `node apps/server/dist/cli.mjs setup-code` | A new one time code, to register a passkey on the login page. Existing passkeys keep working. Wrong guesses lock only the address they came from (or its IPv6 /64), never the code, so nobody can lock you out of recovery. |
| `node apps/server/dist/cli.mjs reset` | Removes every passkey and ends every session, then prints a setup code. For a lost or stolen passkey. |
| `node apps/server/dist/cli.mjs revoke-sessions` | Ends every session; everyone signs in again. |

With docker compose: `docker compose exec hinomi node apps/server/dist/cli.mjs reset`. In Coolify, use the Terminal tab of the application. Each command is recorded in the audit log.

Turning the login off (`HINOMI_AUTH` unset) and restarting also gets you back in, and ends every session; turning it on again brings the passkeys back.

## Sessions

- A session is a random token in an HttpOnly cookie, `__Host-hinomi_session` on https (`hinomi_session` on http), with `SameSite=Lax` and `Path=/`. The database keeps only its SHA-256, so a copy of `hinomi.db` holds no usable session.
- A session ends after 12 hours without a request, and after 7 days in any case. Signing in again replaces the old session of that browser.
- Signing out, ending a session under Settings, Access, removing the passkey that started it, or running `revoke-sessions` ends it on the server at once.
- Every change (any method but GET and HEAD) needs the session's CSRF token in the `x-hinomi-csrf` header, and an `Origin` equal to `HINOMI_AUTH_PUBLIC_URL` (or, without `Origin`, `Sec-Fetch-Site: same-origin`). The web app does this for you.
- Failed sign ins back off per client: five are free, then each waits twice as long as the last, up to 15 minutes. The answer is `429` with a `Retry-After` header. A client is its IPv4 address, or its whole /64 for IPv6, since one host usually holds a /64 and could otherwise rotate through fresh addresses. Nothing locks a passkey or the setup code itself, so knowing a credential id or flooding the setup form cannot lock the owner out; guessing stays out of reach (a setup code carries about 59 bits and lives 15 minutes, a passkey needs its private key).
- Anonymous starts (passkey challenges, provider redirects) have their own budget per client (the same address or /64): 30 free, then the same doubling, up to 5 minutes; a successful sign in clears it. Each client may have at most 10 of them open at once, and they are kept apart from setup and add passkey challenges, so a flood cannot push those out.
- A sign in that cannot be written to the audit log fails, and no cookie is set.

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
- List the proxy in `HINOMI_TRUSTED_PROXIES`, or every request seems to come from the proxy's address: the backoff would then lock everyone out together, and the audit log would show the proxy instead of the client. The server logs one warning the first time `X-Forwarded-For` arrives from a peer that is not listed. Do not list it when anything else can reach the container directly, since a trusted peer can claim any address in `X-Forwarded-For`.
- Tailscale or Cloudflare Access in front still help: they keep the login page itself off the internet.

## Audit log

Settings, Audit log lists, newest first:

- sign ins, with the method and who; refused sign ins, with the reason;
- sign outs, passkeys added and removed (also when their owner left the allow list), sessions ended, setup codes issued (with their expiry only) and used, and resets from the container;
- every change made through the API: the method, the path, the status and who made it.

It never holds a request body, a token or a code. It keeps the newest 10,000 entries, and refused sign ins separately, the newest 2,000, so a flood of them cannot push out anything else. Changes are recorded with the login off too, without a name.

## Outbound calls

With OpenID Connect set, Hinomi calls your issuer (discovery, its signing keys and the token endpoint) when someone signs in. With GitHub set, it calls `github.com` (the token exchange) and `api.github.com` (the user and their emails). Nothing is called while nobody signs in. See [Outbound connections](self-hosting.md#outbound-connections).
