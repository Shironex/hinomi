# Notifications

Hinomi can post to Discord, Slack, Telegram, ntfy, Gotify, any HTTP endpoint (a generic webhook), push to the installed app in a browser (web push) or send email over SMTP. Every channel gets the same messages under the same rules: the batching, ranking, first scan summary, digest and "never twice" below apply to each one.

## What is sent, and when

**Immediately**, after a scan finishes:

- a new or reopened `critical` or `high` advisory finding on a repo that is deployed
- a new or reopened blind spot on something that is deployed
- a guard finding that opens or reopens at `fail` on a running deployment, and a guard escalation to `fail` (event `escalated`, sent once)
- a new or reopened `critical` advisory in the runtime dependencies of a released desktop app (the latest release of a repo nothing deploys, see [api.md](api.md#desktop-release-tier)); every other desktop release finding goes to the daily digest only

Items go out most urgent first (highest exposure rank: criticals on public apps lead).

**One summary instead of a flood.** A channel's first scan, and any scan with more than 10 items for a channel, sends one summary instead of a message per item: counts per tier and per severity, the 5 most urgent items in full, and a link to the exposure view (`<base>/`, when a public base URL is set). Every item the summary stands for counts as announced, so neither the next scan nor the digest repeats it. A channel has been through its first scan once any scan finished while it was enabled, even one with nothing to announce.

Coverage notes (a deployment with no git source, covered by the image scan later) are never sent, right away or in the digest. Guard findings at level `unknown` (the source cannot give the signal) are never sent either. A guard that opens at `warn` goes to the digest only. A better level (`level_changed`) and a scan that finds the same level send nothing. A guard or blind spot whose check is turned off (see [guards.md](guards.md)) is never sent.

**Daily digest**, once a day at the configured hour (server local time, default 08:00), only if something changed since the last digest: new and reopened findings that were not announced already, guard escalations that were not announced already, fixed findings, resolved blind spots and guards, and ended snoozes or acceptances. A digest carries at most 30 items (most severe first); the summary says how many were left out.

A finding is never announced twice. Each channel remembers which `opened`, `reopened` or `escalated` event it announced; the same event is never sent again, a new `reopened` event is. That record is written as soon as each message is delivered, so a send cut short (a restart, a failed delivery) keeps what already went out. If an immediate message could not be delivered, the finding is not marked as sent, so the next digest carries it.

Each channel has a minimum severity (`low`, `moderate`, `high`, `critical`). Blind spots count with the severity shown in the app (alerts disabled is `critical`, alerts unknown and archived but deployed are `high`, the rest `moderate`). Guards count with the severity of their check and level (see [guards.md](guards.md), for example a mounted Docker socket is `critical`, a root container at `fail` is `high`).

## Fix run events

The same channels announce what happens to a fix run (the fix PR flow, see [design/fix-runner.md](design/fix-runner.md)). These go out **right away**, on every enabled channel: they are rare, someone is waiting on them, and they skip the scan batching, the first scan summary and the daily digest. The channel's minimum severity does not apply (a fix run has no severity).

| Setting | Sent when | Default |
| --- | --- | --- |
| `prOpened` | The fix PR is open. Says if it is a draft and why (the checks are failing, the install failed, a step failed). | on |
| `checksFailing` | The checks on the fix PR are failing. | on |
| `verified` | The verification rescan found every targeted finding gone, with the cleared count. | on |
| `notCleared` | The rescan left some findings open: targeted, cleared, still open and new counts. | on |
| `failed` | The run failed (dispatch refused, result unreadable, PR could not be opened) or was lost, with the reason. | on |
| `warnings` | A merged run got a `watch_paths_skip` or `deploy_not_seen` warning, one message per code. | on |

Not announced: intermediate states (queued, running, checks pending, merged, deployed), cancelled runs and superseded runs. A run first seen after its PR merged does not announce the PR.

Each (run, event, channel) is sent once. The record lives in the `notify.fixRunState` setting, so it survives a restart, and it is written as soon as a message is delivered. A delivery that failed is not recorded: the next change of that run tries that channel again. A PR that opened as a draft because its checks fail goes out as one message (the draft one), with both events recorded. An event that is switched off is skipped and not recorded. Records of runs that no longer exist are dropped.

**Links.** The message links to the PR on GitHub. It links to the run in Hinomi (`<base>/fix-runs?sel=<run id>`) only for private repos with a public base URL, the same rule as the fix PR body, so a message in a shared channel never shows the address of the instance for a public repo. (Scan messages always link to the finding when a base URL is set; fix messages follow the stricter fix PR rule.)

**Per channel.** Discord gets one embed (title is the headline, linked to the PR, fields for repository, run, plan, PR, draft reason, reason, counts and warnings). Email gets the headline as the subject and the same rows as text and a simple HTML body. Slack and Telegram get the headline and the same rows, with links to the PR and the run. ntfy, Gotify and web push get the headline as the title, the rows as the body, and open the PR when tapped; failed runs and failing checks go out at high priority. A generic webhook gets this JSON:

```json
{
  "schema": "hinomi.fix-run.v1",
  "sentAt": "2026-11-07T08:00:00.000Z",
  "event": "pr_opened",
  "summary": "Hinomi: draft fix PR opened for kestrel-co/storefront",
  "repo": "kestrel-co/storefront",
  "runId": 12,
  "runKind": "fix",
  "state": "pr_open",
  "plan": { "scanRunId": 7, "version": 2, "steps": { "applied": 2, "skipped": 1, "failed": 0 } },
  "pr": { "number": 42, "url": "https://github.com/kestrel-co/storefront/pull/42", "draft": true },
  "draftReason": "a check failed in the runner",
  "reason": null,
  "counts": null,
  "warnings": [],
  "hinomiUrl": null
}
```

- `event`: `pr_opened`, `checks_failing`, `verified`, `not_cleared`, `failed`, `warning:watch_paths_skip` or `warning:deploy_not_seen`.
- `counts` is `{ targeted, cleared, stillOpen, new }` on `verified` and `not_cleared`, otherwise `null`. `reason` is set on `failed`. `warnings` lists the messages of that code on a warning event.
- `plan.steps` is `null` until the runner's result was read. Fields are only ever added within `hinomi.fix-run.v1`.

## Settings

| Key | Meaning |
| --- | --- |
| `notify.channels` | The channels. URLs, tokens, secrets and SMTP passwords inside are encrypted when `HINOMI_SECRET_KEY` is set. |
| `notify.publicBaseUrl` | Public address of this Hinomi, for example `https://hinomi.example.dev`. Messages link to `<base>/finding/<id>`. Without it there is no link. |
| `notify.digestHour` | Hour of the day, 0 to 23. |
| `notify.state` | What was already sent. Internal. |
| `notify.fixRunEvents` | The six fix run switches (see above). Missing switches are on. |
| `notify.fixRunState` | Fix run events already sent, per run and channel. Internal. |
| `notify.vapid` | The web push key pair, made the first time a browser subscribes. The private key is encrypted when `HINOMI_SECRET_KEY` is set. Internal. |

A channel is `{ kind, name, url, secret, chatId, allowPrivate, enabled, minSeverity }`, where what a kind takes is:

| Kind | `url` | `secret` | Other |
| --- | --- | --- | --- |
| `discord` | Webhook URL (`https://discord.com/api/webhooks/...`) | none | |
| `slack` | Incoming webhook URL (`https://hooks.slack.com/...`) | none | |
| `telegram` | none | Bot token (required) | `chatId` (required) |
| `ntfy` | Topic URL (`https://ntfy.sh/<topic>`) | Access token (optional) | `allowPrivate` |
| `gotify` | Server URL | App token (required) | `allowPrivate` |
| `webhook` | Any http or https URL | Signing secret (optional) | `allowPrivate` |
| `webpush` | The browser's push endpoint | The subscription keys (required) | Added from the browser, see Web push below |
| `email` | none | none | `email` (see Email below) |

## URLs and tokens are secrets

A Discord or Slack webhook URL lets anyone post to the channel, an ntfy topic lets anyone read it, and a bot or app token lets anyone send as that bot. Hinomi stores every URL, token and signing secret encrypted when `HINOMI_SECRET_KEY` is set (the same key and format as source tokens). Without the key they are stored in clear text and the channel reports `urlEncrypted: false`. They are never logged and never returned: the API shows the origin and the last four characters of a URL, `secretSet: true` for a token, and a Telegram channel shows only its chat. Errors from a failed delivery have the URL and the token removed. A channel whose URL or token cannot be decrypted (the key is gone or changed) is skipped until it is saved again.

## SMTP passwords are secrets

The password of an email channel is stored the same way as a webhook URL: encrypted with `HINOMI_SECRET_KEY` when it is set, in clear text otherwise (the channel then reports `urlEncrypted: false`). The API never returns it: it shows host, port, security, user, from, to and `passwordSet`. It is never logged, and errors from a failed send have it removed. A channel whose password cannot be decrypted (the key is gone or changed) is skipped until the password is saved again.

## Delivery

Every channel but email is POSTed over HTTP: JSON, or an encrypted body for web push. Each request times out after 10 s. Hinomi retries on HTTP 429, 5xx and network errors, up to 5 attempts. After a 429 it waits for the `retry_after` of Discord or Telegram (or a `Retry-After` header) but never less than an exponential backoff (1 s, 2 s, 4 s, 8 s). A `retry_after` longer than 2 minutes is not waited out. Other 4xx answers fail at once. Redirects are not followed.

The test button on each channel sends a sample message through the real path, even while the channel is off.

## Private addresses

Hinomi usually sits on a private network next to databases, admin panels and the cloud metadata endpoint (`169.254.169.254`). So a channel only posts to public addresses: a URL whose host is a private, loopback, link-local or other non public address (or `localhost`) is refused when it is saved, and a host name is checked again at connection time, against every address it resolves to, so a name that resolves to a private address is refused too (the same guard as the webhook runner). IPv6 forms that carry an IPv4 address (IPv4 mapped, compatible and translated, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) count as that IPv4 address, and Teredo is refused. A refused name is reported without the address it resolved to, and is not retried.

These requests never go through a proxy from the environment: with `NODE_USE_ENV_PROXY` set, `HTTP_PROXY` and `HTTPS_PROXY` are ignored for them, because the proxy would resolve the host and the address check would never run. Channels that allow private addresses use the normal `fetch` and follow the proxy settings.

A generic webhook, ntfy or Gotify channel can be set to **allow private addresses**, for a server on your own network (`http://gotify.lan`, `http://10.0.0.8:8080`). Only turn it on for such a server. Discord, Slack, Telegram and web push always post to their public service. A generic webhook saved before this setting existed keeps reaching private addresses (it always could); turn the setting off on it once its URL is public.

## Discord

One embed per finding: title `[SEVERITY] package` (blind spots use their description), a link to the finding, and fields for repository, deployment, installed version, fixed-in version, sources and advisory ids. At most ten embeds and about 5000 characters of embeds per message (Discord refuses more than 6000). A summary puts its counts and link in the message text, above the embeds of the top items. Messages never ping anyone (`allowed_mentions` is empty).

## Slack

Create a Slack app with **Incoming Webhooks** turned on, add a webhook to the channel and paste its URL (`https://hooks.slack.com/services/...`). One message per batch: the headline, the summary counts, then a section per finding (`[CRITICAL] example-lib` linked to the finding, then the same rows as email) and a line for what was left out. Finding text is escaped, so nothing in it can mention `@channel` or add a link. Links are not unfurled.

## Telegram

Ask [@BotFather](https://t.me/BotFather) for a bot and its token, add the bot to the group or channel, and give Hinomi the token and the chat id: a number such as `-1001234567890` for a group or channel, or `@channelname` for a public channel. Messages are HTML with the finding text escaped and link previews off. A batch longer than Telegram's 4096 character limit is split into several messages, each finding whole, and each message is recorded as sent as soon as it is delivered. The bot token is part of the API URL, so it is treated like a webhook URL: encrypted, never shown, removed from errors.

## ntfy

Give the topic URL, for example `https://ntfy.sh/hinomi-alerts` or your own server with its topic. On ntfy.sh anyone who knows a topic can read it, so pick a long, random topic or protect it with an access token (`tk_...`), which Hinomi sends as `Authorization: Bearer`. A token must be one line of printable characters without spaces (it goes into a header), for Gotify too. One message per batch, published as JSON to the server: the headline is the title, the findings are the plain text body (cut at about 3500 characters, saying so), tapping it opens the finding (or the exposure view for a summary). The priority follows the most severe finding: `5` for critical, `4` high, `3` moderate, `2` low; digests and tests are `3`.

## Gotify

Create an application in Gotify, then give Hinomi the server URL (without `/message`) and the application's token, which is sent in the `X-Gotify-Key` header. One message per batch, shown as plain text (never Markdown), with a click URL to the finding. The priority follows the most severe finding: `8` for critical, `6` high, `4` moderate, `2` low; digests and tests are `4`.

## Web push

Web push sends alerts to Hinomi installed or open in a browser, even while no tab is open. Pick **This browser** in Add a channel and allow notifications when the browser asks: the browser subscribes with this Hinomi's key and the subscription becomes a channel of its own (name it after the device). Add each browser or device you want alerts on.

- It needs the built app served over HTTPS (or on `localhost`), where the service worker runs. It does not work in `pnpm dev`.
- The message is encrypted for that browser (RFC 8291) and signed with this Hinomi's VAPID key (RFC 8292); the push service in between (Google, Mozilla, Apple) cannot read it. The key pair is made on first use and kept in `notify.vapid`. If `HINOMI_SECRET_KEY` changes, the stored key no longer decrypts: Hinomi makes a new key pair, turns every web push channel off with the reason shown in the list, and a browser added again subscribes under the new key (the settings page drops a subscription made under the old key first, and the server refuses a subscription that names an old key). Remove the old channels once the browsers are added again. If `HINOMI_SECRET_KEY` is missing instead, nothing is replaced: web push fails with that reason, adding a browser answers 409 `secret_key_missing`, and everything works again once the key is set.
- A notification shows the headline and the first lines, and opens the finding when clicked.
- When the push service answers that the subscription is gone (HTTP 404 or 410, for example after notifications were turned off in the browser) or refuses this server's key (HTTP 403), the channel is turned off, with the reason shown in the list.
- The message is cut by bytes after it is encoded (title, body and link), so the encrypted message stays under the 4096 bytes push services take.

## Email

An email channel has these settings:

| Setting | Meaning |
| --- | --- |
| `host`, `port` | The SMTP server, for example `smtp.example.dev` and `587`. |
| `security` | `tls` (implicit TLS, usually port 465), `starttls` (the server must offer STARTTLS, usually port 587) or `none` (no encryption is required: only for a trusted local relay). |
| `user`, `password` | Login. Leave both empty when the server needs none. |
| `from` | The sender address. |
| `to` | One to 20 recipient addresses. Everyone gets the same message. |

One email per batch: an immediate message covers every new item for that channel, a summary carries its counts and the 5 most urgent items, a digest covers its items (at most 30). The subject is the summary line (`Hinomi: 2 new items need attention`, `Hinomi first scan: 40 items need attention`, `Hinomi daily digest: 5 changes`). The body is plain text with a simple HTML alternative: a heading per finding (`[CRITICAL] example-lib`, with an event label in digests) with a link to the finding when a public base URL is set, then repository, deployment, installed and fixed-in versions, sources and advisory ids. There are no remote images, no scripts and no tracking; all finding text is HTML escaped.

Sending is tried up to 3 times with a backoff of 2 s and 4 s on network errors and 4xx replies. A 5xx reply (wrong login, rejected recipient) fails at once. Each connection times out after 15 s. The test button sends a sample message to every recipient.

## Generic webhook payload

`POST` with `content-type: application/json`. The shape is versioned: fields are only ever added within `hinomi.notification.v1`.

**Signature.** With a signing secret set, every request carries `X-Hinomi-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC SHA-256 of `<t>.<raw body>` with the secret (the same scheme as the webhook runner, see [runners.md](runners.md)). Check it on the raw body, compare in constant time, and refuse a `t` more than a few minutes from your clock, so an old delivery cannot be replayed.

```json
{
  "schema": "hinomi.notification.v1",
  "type": "immediate",
  "sentAt": "2026-11-06T10:00:00.000Z",
  "summary": "Hinomi: 1 new item needs attention",
  "omitted": 0,
  "items": [
    {
      "event": "opened",
      "findingId": 42,
      "kind": "advisory",
      "severity": "critical",
      "title": "example-lib",
      "blindSpotType": null,
      "guardCheck": null,
      "guardLevel": null,
      "repo": "kestrel-co/harbor-web",
      "package": "example-lib",
      "ecosystem": "npm",
      "advisory": "GHSA-0000-0000-0000",
      "cves": [],
      "summary": "Prototype pollution in example-lib",
      "installedVersion": "1.2.3",
      "fixedIn": "1.2.4",
      "deployments": [{ "name": "harbor-web", "reach": "public", "server": "edge-1" }],
      "sources": ["github"],
      "url": "https://hinomi.example.dev/finding/42"
    }
  ]
}
```

- `type`: `immediate`, `summary`, `digest` or `test`.
- `omitted`: items cut from a digest or a summary by the limit, otherwise 0.
- `counts` and `link`, only on a `summary`: `{ total, byTier, bySeverity }` over every item the summary stands for (`byTier` keys are the tiers of the alerts list, only those with items), and the exposure view URL (`null` without a public base URL). `items` holds the 5 most urgent.
- `event`: `opened`, `reopened`, `fixed`, `resolved` (blind spot or guard cleared), `expired` (snooze or acceptance ended) or `escalated` (a guard's level got worse).
- `kind`: `advisory`, `blind_spot` or `guard`. For blind spots `blindSpotType` is one of `alerts_disabled`, `alerts_unknown`, `archived_deployed`, `no_repo_mapping`, `lockfile_missing`, `lockfile_unparseable`, and `title` is a readable description. For guards `guardCheck` is the check (see [guards.md](guards.md)), `guardLevel` is `warn` or `fail`, `title` is the check's title and `summary` its explanation for that level.
- `severity`: `critical`, `high`, `moderate` or `low`.
- Fields that do not apply are `null` (or an empty array); `url` is `null` without a public base URL.
- `reach` is `public`, `internal` or `unknown`.

## Using it from code

`apps/server/src/notify/` is self-contained.

```ts
const notifier = createNotifier({ repositories, secretBox })
scheduler.onScanFinished((summary) => notifier.handleScanFinished(summary))
// once a day: setTimeout(run, msUntilNextDigest(new Date(), readNotifySettings(repositories.settings).digestHour))
await notifier.sendDigest()
await notifier.sendTest(channelId)
notifier.channels.add({ kind: 'discord', name: 'alerts', url })
notifier.channels.add({ kind: 'ntfy', name: 'phone', url: 'https://ntfy.sh/hinomi-alerts', secret: token })
```
