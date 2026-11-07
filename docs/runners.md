# Fix runners

A fix runner applies a repo's fix plan, pushes the branch `hinomi/fix-plan` (or `hinomi/majors`), and Hinomi then opens the PR itself with the shared renderer. Hinomi never merges. Each repo picks where its plans run, under Repos, Runner, or `PATCH /api/repos/:id/runner` with `kind`:

| Kind | Where the plan runs | Set up |
|---|---|---|
| `github_actions` (default) | A workflow in the repo's own Actions | [github.md](github.md#fix-runner) |
| `webhook` | An external runner Hinomi posts the plan to | [below](#the-webhook-runner) |

Every kind is off until the runner is turned on for the repo. After the branch is pushed every kind is the same: the PR, its checks, the deploy and the verification rescan are tracked as described in [api.md](api.md#fix-runner-and-fix-runs). The design and its trade offs are in [design/fix-runner.md](design/fix-runner.md#21-65-webhook-and-local-runners).

## The webhook runner

For plans that should run on your own CI, a build box or a queue. Hinomi posts the plan, the external runner applies it, pushes the fix branch with its own credential and reports back on the callback path. Hinomi never sends its GitHub credential to it.

### Set it up

1. Settings, Webhook runner (or `PATCH /api/settings/webhook-runner`): set the **URL** the plans go to. It must be https, carry no user or password, and resolve to public addresses only. For a runner on Hinomi's own network, turn on **Allow private addresses**, which also allows plain http.
2. **Generate a secret** (`POST /api/settings/webhook-runner/secret`). It is shown once; store it in the external runner. Generating a new one replaces the old one at once. It needs `HINOMI_SECRET_KEY`, since it is stored encrypted.
3. Optional: set the **callback URL**, the address under which the external runner reaches Hinomi's callback path, for example `https://hooks.example.dev/api/runner/callback`. It is sent with every plan. Expose only that path, like the [GitHub webhook](github-webhook.md#expose-only-the-webhook-path): `HINOMI_WEBHOOK_PORT` serves both webhook paths and nothing else.
4. Set the repo's runner kind to `webhook` and turn the runner on.

### What Hinomi posts

`POST <url>` with `Content-Type: application/json` and:

```json
{
  "schema": "hinomi.webhook-dispatch/1",
  "runId": "8c3f5d2e-1b7a-4c9e-9f00-2d6a1e4b7c11",
  "kind": "fix",
  "repo": "kestrel-co/harbor",
  "branch": "hinomi/fix-plan",
  "encoding": "json",
  "plan": "{\"schema\":\"hinomi.fix-dispatch/1\", ...}",
  "callbackUrl": "https://hooks.example.dev/api/runner/callback"
}
```

`plan` and `encoding` are exactly the inputs the GitHub Actions caller workflow receives (`encoding` is `json` or `gzip-base64`), so the external runner can hand them to the fix runner action (`Shironex/hinomi/actions/fix-runner`) or decode them with `decodeFixDispatch` from `packages/shared`. `kind: "majors"` asks for the coding agent hand off and names `hinomi/majors`.

Headers: `X-Hinomi-Event: dispatch`, `X-Hinomi-Delivery: <uuid>`, `X-Hinomi-Signature: t=<unix seconds>,v1=<hex>`. Any 2xx answer means accepted; the run moves to `dispatched`. Anything else, no answer within 15 seconds, or a redirect fails the run with the reason. Hinomi never follows redirects, so the signed plan never reaches a second host: put the final URL in the settings.

### The signature

`v1` is the HMAC SHA-256, in hex, of the timestamp, a dot and the raw body, keyed with the shared secret. Check it in constant time and refuse timestamps more than 5 minutes off. The same scheme signs the callbacks. In Node:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

function sign(secret: string, body: string, at = new Date()): string {
  const t = Math.floor(at.getTime() / 1000)
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

function verify(secret: string, body: string, header: string): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
  if (!match) return false
  const expected = createHmac('sha256', secret).update(`${match[1]}.${body}`).digest()
  const sent = Buffer.from(match[2], 'hex')
  const fresh = Math.abs(Date.now() / 1000 - Number(match[1])) <= 300
  return fresh && timingSafeEqual(sent, expected)
}
```

### Reporting back

`POST <callbackUrl>` (the path is `/api/runner/callback`) with `Content-Type: application/json`, a fresh `X-Hinomi-Delivery` id per report (8 to 72 letters, digits or dashes) and `X-Hinomi-Signature` over the body:

```json
{ "schema": "hinomi.runner-callback/1", "runId": "8c3f5d2e-...", "status": "running" }
```

| `status` | Also send | Hinomi does |
|---|---|---|
| `queued` | | `queued` |
| `running` | | `running` |
| `completed` | `result`, the `hinomi-result.json` the action wrote; with a patch also `headSha`, the head of the pushed branch | Without a patch: `nothing_to_do` (a majors run: `failed` with the agent's reason). With one: reads the branch on GitHub, and when its head is `headSha` records `branch_pushed` and opens the PR at once |
| `failed` | `reason` (shown as is, cut to 500 characters), optionally `result` | `failed` |
| `cancelled` | | `cancelled` |

The result must be for the same run id and repo and pass the fix result schema. Answers: 200 `{ "status": "applied" | "unchanged", "state" }`, 200 `{ "status": "duplicate" }` for a delivery id sent before, 401 for a bad or stale signature, 404 for an unknown run id, 409 when the run cannot take the report (it ended, or the branch is not at `headSha` yet), 422 for a malformed body, 503 when GitHub could not be asked (send the same report again, with the same delivery id). The callback body is capped at 1 MiB.

A run that sends no result within 2 hours of the dispatch is marked `lost`.

### Trust and limits

- The external runner pushes to the repo with its own credential and is trusted as much as the repo's CI. Hinomi still opens the PR, renders its body from the validated result, and a person reviews it.
- Whoever holds the secret can report on runs whose id they know. Run ids are random and sent only to the configured URL. Rotate the secret if it leaks.
- With private addresses allowed, the URL may point anywhere on Hinomi's network. Leave the switch off unless the runner really lives there.
- Without private addresses allowed, the address check runs when the connection resolves the name, so a name cannot resolve to a public address for the check and a private one for the request.
