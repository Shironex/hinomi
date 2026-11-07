# GitHub webhook (optional)

Hinomi follows fix runs by polling GitHub (see [api.md](api.md#fix-runner-and-fix-runs)). The webhook is an optional speed up: when GitHub reports that a workflow run, a pull request or its checks changed, Hinomi polls the fix runs that delivery names at once instead of waiting for their next turn. Polling stays the source of truth. A delivery never moves a run by itself, so a lost, late or forged delivery cannot put a run in a wrong state; at worst it costs an early poll, and those polls still count against the tracker's request budget and wait out a GitHub rate limit pause.

It is off by default. Without it nothing changes: runs move at the polling cadence.

## Turn it on

1. Set `HINOMI_SECRET_KEY` if it is not set yet. The webhook secret is stored encrypted with it (AES-256-GCM, the same as source tokens), so no secret can be made without it.
2. Generate a secret: `POST /api/settings/github-webhook/secret`. The answer holds the secret. It is shown this once and never again; generating a new one replaces it and deliveries signed with the old one fail from then on.
3. Turn it on: `PATCH /api/settings/github-webhook` with `{ "enabled": true }`.
4. Make the webhook path reachable from GitHub, and only that path (below).
5. Add the webhook in GitHub (below).

`GET /api/settings/github-webhook` shows whether it is on, the path, the events to tick, the last delivery that verified and the last rejected request or failed delivery since the server started.

## Add it in GitHub

On a repository: Settings, Webhooks, Add webhook. For many repos, add it once on the organization (Settings, Webhooks) instead.

| Field | Value |
|---|---|
| Payload URL | `https://<public host>/api/github/webhook` |
| Content type | `application/json` (form encoded deliveries are refused) |
| Secret | The generated secret |
| SSL verification | Enabled |
| Events | "Let me select individual events": Workflow runs, Pull requests, Check suites, Check runs, Statuses. Pushes only when `includePush` is on. |

With a GitHub App, the webhook belongs to the App: in the App's settings tick Webhook, Active, set the URL and the secret there, then subscribe to the same events. GitHub offers an event only when the App has the matching read permission: Actions (workflow runs), Pull requests, Checks (check suites and runs), Commit statuses, Contents (pushes). The App setup in [github.md](github.md) asks for none of these, so add them as read only first; GitHub then asks each installation to accept the new permissions.

GitHub sends a `ping` right away. It shows as the last delivery once its signature verified.

What each event is used for:

| Event | Runs it names |
|---|---|
| `workflow_run` | The run with that workflow run id, or a run not linked yet whose run name is `hinomi fix <correlationId>` |
| `pull_request` | The run with that PR number, a run on the PR's branch whose PR is not known yet, or the run with that head commit |
| `check_suite`, `check_run` | The run with that head commit, PR or branch |
| `status` | The run with that commit, or on one of its branches |
| `push` (with `includePush`) | Runs on the pushed fix branch; on a push to the default branch, runs with a PR (it may just have merged) |
| `ping` | None |

Deliveries for repos Hinomi does not track, and events not listed, are acknowledged and ignored.

## Expose only the webhook path

Hinomi has no login and is meant to be reachable only over Tailscale or behind Cloudflare Access ([access.md](access.md)). GitHub can reach neither, so the webhook needs a public route to exactly one path, `POST /api/github/webhook`, with everything else still private. The receiver is built for that: it checks nothing else about the request before the signature verifies, does not depend on the access status, and answers 404 like any unknown route while the webhook is off.

### The webhook only port (recommended)

Set `HINOMI_WEBHOOK_PORT` (for example `3001`) and restart. Hinomi then also listens on that port, and that listener serves the webhook path and nothing else: the UI, the API and the health check all answer 404 there. Point the public route at this port instead of the main one, so even a path rule that is wrong cannot reach the rest of Hinomi. With Docker, publish that port next to the main one, or keep it on the Docker network the tunnel runs in. The webhook path keeps working on the main port too, for setups that prefer a path rule there.

### Cloudflare Tunnel

In a locally managed tunnel, give the public hostname a path rule and end with a catch all that refuses everything else (`config.yml`):

```yaml
ingress:
  - hostname: hooks.example.dev
    path: ^/api/github/webhook$
    service: http://hinomi:3001 # the webhook only port; or http://hinomi:3000
  - service: http_status:404
```

In a dashboard managed tunnel, add a public hostname with the path `^/api/github/webhook$` and the same service, and keep no other public hostname pointing at Hinomi. Do not put Cloudflare Access in front of this hostname: GitHub cannot log in, and the signature is the check here.

### Tailscale Funnel

Funnel publishes a path of the node to the internet. Mount only the webhook path, pointing at the same path on the webhook only port:

```sh
tailscale funnel --bg --set-path /api/github/webhook http://127.0.0.1:3001/api/github/webhook
tailscale funnel status
```

The Payload URL is then `https://<node>.<tailnet>.ts.net/api/github/webhook`. Check `tailscale funnel status` lists that one path and nothing at `/`. Keep using `tailscale serve` (tailnet only) for the UI.

### A reverse proxy

Forward only that method and path, and refuse the rest. Caddy:

```
hooks.example.dev {
	@webhook {
		method POST
		path /api/github/webhook
	}
	handle @webhook {
		reverse_proxy hinomi:3001
	}
	respond 404
}
```

nginx:

```nginx
location = /api/github/webhook {
    limit_except POST { deny all; }
    proxy_pass http://hinomi:3001;
}
location / {
    return 404;
}
```

### Check it

From outside your network: `curl -i -X POST https://hooks.example.dev/api/github/webhook` must answer `401` (no signature; `404` while the webhook is off), and `curl -i https://hooks.example.dev/` and `https://hooks.example.dev/api/health` must answer `404`. Then use Redeliver on the ping in GitHub's Recent Deliveries; a redelivery reuses the delivery id, so Hinomi answers it `200` with `duplicate`.

## How a delivery is checked

1. Webhook off, no secret, or a secret that cannot be decrypted (the key changed): `404`, the same answer as an unknown route.
2. A body over 1 MiB, declared or streamed: `413`. The raw body is read with that cap before anything is parsed.
3. `X-Hub-Signature-256` must be `sha256=` and the HMAC SHA-256 of the raw body with the secret, compared in constant time. Missing or wrong: `401` with an empty body.
4. Then `X-GitHub-Event` and `X-GitHub-Delivery` must be there (`400`) and the content type JSON (`415`).
5. A delivery id seen in the last 24 hours is a replay: `200` with `{ "status": "duplicate" }`, nothing done. The ids are kept in memory (at most 10,000), so a restart forgets them; a replay after that costs one early poll.
6. Otherwise `202` with `accepted` or `ignored` right away, and the runs are looked up after the answer.

Rejected requests update the last error shown in the settings and are logged at most once a minute, without the body or the signature. The secret is never logged or returned after its rotation.
