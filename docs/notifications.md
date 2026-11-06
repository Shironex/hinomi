# Notifications

Hinomi can post to a Discord channel or to any HTTP endpoint (a generic webhook).

## What is sent, and when

**Immediately**, after a scan finishes:

- a new or reopened `critical` or `high` advisory finding on a repo that is deployed
- a new or reopened blind spot on something that is deployed

**Daily digest**, once a day at the configured hour (server local time, default 08:00), only if something changed since the last digest: new and reopened findings that were not announced already, fixed findings, resolved blind spots and ended snoozes or acceptances. A digest carries at most 30 items (most severe first); the summary says how many were left out.

A finding is never announced twice. Each channel remembers which `opened` or `reopened` event it announced; the same event is never sent again, a new `reopened` event is. If an immediate message could not be delivered, the finding is not marked as sent, so the next digest carries it.

Each channel has a minimum severity (`low`, `moderate`, `high`, `critical`). Blind spots count with the severity shown in the app (alerts disabled is `critical`, alerts unknown and archived but deployed are `high`, the rest `moderate`).

## Settings

| Key | Meaning |
| --- | --- |
| `notify.channels` | The channels. Webhook URLs inside are encrypted when `HINOMI_SECRET_KEY` is set. |
| `notify.publicBaseUrl` | Public address of this Hinomi, for example `https://hinomi.example.dev`. Messages link to `<base>/finding/<id>`. Without it there is no link. |
| `notify.digestHour` | Hour of the day, 0 to 23. |
| `notify.state` | What was already sent. Internal. |

A channel is `{ kind: 'discord' | 'webhook', name, url, enabled, minSeverity }`.

## Webhook URLs are secrets

A Discord webhook URL lets anyone post to the channel. Hinomi stores it encrypted when `HINOMI_SECRET_KEY` is set (the same key and format as source tokens). Without the key it is stored in clear text and the channel reports `urlEncrypted: false`. The URL is never logged and never returned in full: the API shows the origin and the last four characters. Errors from a failed delivery have the URL removed.

## Delivery

Messages are POSTed as JSON. Hinomi retries on HTTP 429, 5xx and network errors, up to 5 attempts. After a 429 it waits for Discord's `retry_after` but never less than an exponential backoff (1 s, 2 s, 4 s, 8 s). A `retry_after` longer than 2 minutes is not waited out. Other 4xx answers fail at once. Redirects are not followed.

## Discord

One embed per finding: title `[SEVERITY] package` (blind spots use their description), a link to the finding, and fields for repository, deployment, installed version, fixed-in version, sources and advisory ids. Ten embeds per message. Messages never ping anyone (`allowed_mentions` is empty).

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

- `type`: `immediate`, `digest` or `test`.
- `omitted`: items cut from a digest by the limit, otherwise 0.
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
