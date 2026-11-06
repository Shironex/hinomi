# Access status

Hinomi has no login yet, so it must sit behind something that has one: Tailscale or Cloudflare Access. On every page load the SPA asks `GET /api/access` how the current request reached the server and shows the answer in the sidebar, in onboarding and under Settings, Access.

| State | Shown as | When |
|---|---|---|
| `cloudflare_access`, verified | Protected by Cloudflare Access (with the email) | The `Cf-Access-Jwt-Assertion` token passed the checks below |
| `tailscale` | Protected by Tailscale (with the login when known) | Identity headers from `tailscale serve`, or a client address in `100.64.0.0/10` or `fd7a:115c:a1e0::/48` |
| `cloudflare_access`, not verified | Amber: header seen, not verified | The token is there, but no team domain and audience are set, or the signing keys could not be fetched |
| `public` | Red, on every page | The client address is public and nothing above matched |
| `unknown` | Amber: the old warning, with the address Hinomi saw | Loopback, a LAN or Docker bridge address, or no address |

They are checked in that order. The answer is per request: two people on different paths can see different states.

## What Hinomi trusts

- The client address is the TCP peer of the socket. `X-Forwarded-For` and `CF-Connecting-IP` are ignored unless the peer is listed in `HINOMI_TRUSTED_PROXIES`, since anyone can send them.
- `Tailscale-User-Login` is believed only from loopback (where `tailscale serve` connects from) or a trusted proxy. A tailnet client that sends it itself still shows as Tailscale, without a login.
- A `Cf-Access-Jwt-Assertion` token that fails verification is ignored, so a forged token from a public address still shows as public. Without verification set up the header is reported as seen but not verified, never as protected.

## Behind a Docker port mapping

A common setup publishes the port only on the host's Tailscale address, for example `<tailscale-ip>:3000:3000` in compose or Coolify. What the app then sees as the client depends on how the connection enters the host. Tested on Docker Engine 29 with a dind host, a remote peer and a local client, with the userland proxy on and off:

| Connection | Container sees |
|---|---|
| A remote tailnet peer, Tailscale in its normal kernel mode | The peer's real `100.x` address (NAT keeps the source), so the state is `tailscale` |
| A process on the host itself, userland proxy on (the default) | The host address that was dialed, for example the host's own `100.x` address |
| A process on the host itself, userland proxy off | The bridge gateway, for example `172.17.0.1`: `unknown` |
| Another container through the published port | The bridge gateway or that container's address: `unknown` |

So on a host where Tailscale runs in its usual kernel mode, a browser on the tailnet is detected without any setting. Connections the host makes itself (Tailscale in userspace networking mode, `tailscale serve` on the host, or a reverse proxy on the host) can reach the container from a bridge address. Hinomi cannot tell those apart from any other container, so it reports `unknown` and keeps the warning rather than guessing.

## Behind a reverse proxy

When Traefik, Caddy, nginx or `cloudflared` sits in front, the socket peer is the proxy. Name it so its headers are believed:

```sh
# The proxy's address or its Docker network, comma separated
HINOMI_TRUSTED_PROXIES=172.20.0.0/16
```

From a trusted peer Hinomi takes the right most `X-Forwarded-For` entry that is not itself a trusted proxy (entries further left are written by the client), then `CF-Connecting-IP`, and believes `Tailscale-User-Login`. Only list addresses that nothing else can connect from: every client that can reach Hinomi from a listed address can choose its own forwarded headers.

With `tailscale serve` in front of a Docker port mapping, serve connects to the published port from the host, which the container sees as the bridge gateway. List that gateway in `HINOMI_TRUSTED_PROXIES` to get the login, and only when nothing else on the host talks to the port.

## Cloudflare Access

Cloudflare Access adds a signed application token to every request in the `Cf-Access-Jwt-Assertion` header. To verify it, set both:

```sh
HINOMI_CF_ACCESS_TEAM_DOMAIN=<your-team-name>        # or https://<your-team-name>.cloudflareaccess.com
HINOMI_CF_ACCESS_AUD=<Application Audience (AUD) tag>  # Access controls, Applications, your app, Basic information
```

Hinomi then fetches the public keys from `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs`, picks the key by the token's `kid`, checks the RS256 signature, that `iss` is the team domain, that `aud` contains the tag, and `exp` and `nbf` (with a minute of clock skew). Keys are cached for an hour and refetched when a token names a new `kid` after a rotation, at most once a minute. Setting only one of the two variables is a startup error.

Behind a `cloudflared` tunnel the socket peer is the tunnel container, a bridge address, so without verification the state stays at "header seen, not verified".
