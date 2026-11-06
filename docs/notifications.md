# Notifications

Hinomi can post to a Discord channel, to any HTTP endpoint (a generic webhook) or send email over SMTP.

## What is sent, and when

**Immediately**, after a scan finishes:

- a new or reopened `critical` or `high` advisory finding on a repo that is deployed
- a new or reopened blind spot on something that is deployed

Items go out most urgent first (highest exposure rank: criticals on public apps lead).

**One summary instead of a flood.** A channel's first scan, and any scan with more than 10 items for a channel, sends one summary instead of a message per item: counts per tier and per severity, the 5 most urgent items in full, and a link to the exposure view (`<base>/`, when a public base URL is set). Every item the summary stands for counts as announced, so neither the next scan nor the digest repeats it. A channel has been through its first scan once any scan finished while it was enabled, even one with nothing to announce.

Coverage notes (a deployment with no git source, covered by the image scan later) are never sent, right away or in the digest.

**Daily digest**, once a day at the configured hour (server local time, default 08:00), only if something changed since the last digest: new and reopened findings that were not announced already, fixed findings, resolved blind spots and ended snoozes or acceptances. A digest carries at most 30 items (most severe first); the summary says how many were left out.

A finding is never announced twice. Each channel remembers which `opened` or `reopened` event it announced; the same event is never sent again, a new `reopened` event is. That record is written as soon as each message is delivered, so a send cut short (a restart, a failed delivery) keeps what already went out. If an immediate message could not be delivered, the finding is not marked as sent, so the next digest carries it.

Each channel has a minimum severity (`low`, `moderate`, `high`, `critical`). Blind spots count with the severity shown in the app (alerts disabled is `critical`, alerts unknown and archived but deployed are `high`, the rest `moderate`).

## Settings

| Key | Meaning |
| --- | --- |
| `notify.channels` | The channels. Webhook URLs and SMTP passwords inside are encrypted when `HINOMI_SECRET_KEY` is set. |
| `notify.publicBaseUrl` | Public address of this Hinomi, for example `https://hinomi.example.dev`. Messages link to `<base>/finding/<id>`. Without it there is no link. |
| `notify.digestHour` | Hour of the day, 0 to 23. |
| `notify.state` | What was already sent. Internal. |

A channel is `{ kind: 'discord' | 'webhook' | 'email', name, url, enabled, minSeverity }`. An email channel has no `url`; it carries `email` instead (see Email below).

## Webhook URLs are secrets

A Discord webhook URL lets anyone post to the channel. Hinomi stores it encrypted when `HINOMI_SECRET_KEY` is set (the same key and format as source tokens). Without the key it is stored in clear text and the channel reports `urlEncrypted: false`. The URL is never logged and never returned in full: the API shows the origin and the last four characters. Errors from a failed delivery have the URL removed.

## SMTP passwords are secrets

The password of an email channel is stored the same way as a webhook URL: encrypted with `HINOMI_SECRET_KEY` when it is set, in clear text otherwise (the channel then reports `urlEncrypted: false`). The API never returns it: it shows host, port, security, user, from, to and `passwordSet`. It is never logged, and errors from a failed send have it removed. A channel whose password cannot be decrypted (the key is gone or changed) is skipped until the password is saved again.

## Delivery

Discord and webhook messages are POSTed as JSON. Hinomi retries on HTTP 429, 5xx and network errors, up to 5 attempts. After a 429 it waits for Discord's `retry_after` but never less than an exponential backoff (1 s, 2 s, 4 s, 8 s). A `retry_after` longer than 2 minutes is not waited out. Other 4xx answers fail at once. Redirects are not followed.

## Discord

One embed per finding: title `[SEVERITY] package` (blind spots use their description), a link to the finding, and fields for repository, deployment, installed version, fixed-in version, sources and advisory ids. At most ten embeds and about 5000 characters of embeds per message (Discord refuses more than 6000). A summary puts its counts and link in the message text, above the embeds of the top items. Messages never ping anyone (`allowed_mentions` is empty).

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
- `event`: `opened`, `reopened`, `fixed`, `resolved` (blind spot cleared) or `expired` (snooze or acceptance ended).
- `kind`: `advisory` or `blind_spot`. For blind spots `blindSpotType` is one of `alerts_disabled`, `alerts_unknown`, `archived_deployed`, `no_repo_mapping`, `lockfile_missing`, `lockfile_unparseable`, and `title` is a readable description.
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
```
