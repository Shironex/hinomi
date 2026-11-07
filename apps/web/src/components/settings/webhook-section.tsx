import { useEffect, useState } from 'react'
import type { GithubWebhookEvent, GithubWebhookSettingsDto } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconKey,
  IconLoader2,
  IconPower,
  IconRefresh,
  IconWebhook,
  IconGitCommit,
} from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyCommand } from '@/components/copy-command'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { describeError } from '@/lib/errors'
import { formatRelative } from '@/lib/format'
import {
  githubWebhookQuery,
  rotateGithubWebhookSecret,
  settingsKeys,
  updateGithubWebhook,
} from '@/lib/settings-api'
import { Panel, SetBox, SetRow, SubHeading } from './settings-section'

export const WEBHOOK_DOCS_URL =
  'https://github.com/Shironex/hinomi/blob/main/docs/github-webhook.md'

/** What to tick under "Let me select individual events" in GitHub, per event the receiver reads. */
const EVENT_LABELS: Record<GithubWebhookEvent, string> = {
  workflow_run: 'Workflow runs',
  pull_request: 'Pull requests',
  check_suite: 'Check suites',
  check_run: 'Check runs',
  status: 'Statuses',
  push: 'Pushes',
  ping: 'Ping',
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <code className="font-mono text-[max(13px,0.92em)] text-foreground">{children}</code>
)

/** The optional GitHub webhook: secret, the two switches and what to enter in GitHub. */
export function WebhookSection() {
  const webhook = useQuery(githubWebhookQuery)
  if (webhook.isPending) {
    return (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-64" />
      </Panel>
    )
  }
  if (webhook.isError) {
    return (
      <ErrorState
        title="Webhook settings did not load"
        error={webhook.error}
        onRetry={() => void webhook.refetch()}
      />
    )
  }
  return <WebhookPanels settings={webhook.data} />
}

function WebhookPanels({ settings }: { settings: GithubWebhookSettingsDto }) {
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const save = (data: GithubWebhookSettingsDto) =>
    queryClient.setQueryData(settingsKeys.githubWebhook, data)
  const toggle = useMutation({ mutationFn: updateGithubWebhook, onSuccess: save })
  const rotate = useMutation({
    mutationFn: rotateGithubWebhookSecret,
    onSuccess: (data) => {
      setConfirming(false)
      setSecret(data.secret)
      save(data.settings)
    },
  })

  const { canStoreSecret, secretSet, enabled, includePush } = settings
  const canEnable = canStoreSecret && secretSet
  const pending = (key: 'enabled' | 'includePush') =>
    toggle.isPending && toggle.variables !== undefined && key in toggle.variables
  const shownEnabled = pending('enabled') ? (toggle.variables?.enabled ?? enabled) : enabled
  const shownPush = pending('includePush')
    ? (toggle.variables?.includePush ?? includePush)
    : includePush

  const enableSub = !canStoreSecret
    ? 'Needs HINOMI_SECRET_KEY, so the secret can be stored'
    : !secretSet
      ? 'Generate a secret first. Deliveries are checked against it.'
      : enabled
        ? 'A verified delivery makes Hinomi poll the fix runs it names at once'
        : 'While off, the webhook path answers 404 like any unknown route'

  return (
    <>
      {canStoreSecret ? null : (
        <Callout variant="warn" icon={IconAlertTriangle} title="Secret key missing">
          Set <Mono>HINOMI_SECRET_KEY</Mono> and restart Hinomi. The webhook secret is stored
          encrypted with it, so none can be made without it.
        </Callout>
      )}

      <SetBox>
        <SetRow
          icon={<IconWebhook stroke={1.75} />}
          title="Status"
          sub={<DeliveryLine settings={settings} />}
          aside={
            enabled ? (
              <Badge variant="success">
                <IconCheck aria-hidden="true" />
                On
              </Badge>
            ) : (
              <Badge>
                <IconPower aria-hidden="true" />
                Off
              </Badge>
            )
          }
        >
          {settings.lastError && settings.lastErrorAt ? (
            <p className="flex items-start gap-2 text-sm text-sev-critical">
              <IconAlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
                stroke={1.75}
              />
              <span className="min-w-0 break-words">
                Last error {formatRelative(settings.lastErrorAt)}: {settings.lastError}
              </span>
            </p>
          ) : null}
        </SetRow>

        <SetRow
          icon={<IconKey stroke={1.75} />}
          title="Secret"
          sub={
            secretSet && settings.secretCreatedAt
              ? `Set ${formatRelative(settings.secretCreatedAt)}. It is stored encrypted and never shown again.`
              : 'No secret yet'
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canStoreSecret || rotate.isPending}
              onClick={() => {
                rotate.reset()
                if (secretSet) setConfirming(true)
                else rotate.mutate()
              }}
            >
              {rotate.isPending && !confirming ? (
                <IconLoader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <IconRefresh aria-hidden="true" />
              )}
              {secretSet ? 'Rotate secret' : 'Generate secret'}
            </Button>
          </div>
          {rotate.error && !confirming ? (
            <p role="alert" className="text-sm text-sev-critical">
              {describeError(rotate.error)}
            </p>
          ) : null}
          {secret ? <SecretReveal secret={secret} onDone={() => setSecret(null)} /> : null}
        </SetRow>

        <SetRow
          icon={<IconPower stroke={1.75} />}
          title="Receive deliveries"
          sub={enableSub}
          aside={
            <Switch
              aria-label="Receive GitHub webhook deliveries"
              checked={shownEnabled}
              disabled={!canEnable || toggle.isPending}
              onCheckedChange={(next) => toggle.mutate({ enabled: next })}
            />
          }
        />

        <SetRow
          icon={<IconGitCommit stroke={1.75} />}
          title="Include pushes"
          sub="Also poll when a fix branch or the default branch is pushed. Adds the push event."
          aside={
            <Switch
              aria-label="Include push events"
              checked={shownPush}
              disabled={!canStoreSecret || toggle.isPending}
              onCheckedChange={(next) => toggle.mutate({ includePush: next })}
            />
          }
        />
      </SetBox>
      {toggle.error ? (
        <p role="alert" className="text-sm text-sev-critical">
          {describeError(toggle.error)}
        </p>
      ) : null}

      <SubHeading title="Add it in GitHub" note="Repository or organization, Settings, Webhooks" />
      <Panel>
        <dl className="grid gap-x-4 gap-y-3 text-sm tab:grid-cols-[140px_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Payload URL</dt>
          <dd className="flex min-w-0 flex-col gap-1.5">
            <CopyCommand command={settings.path} />
            <span className="text-xs text-muted-foreground">
              Put the public address of this Hinomi in front, for example{' '}
              <Mono>{`https://hooks.example.dev${settings.path}`}</Mono>. Expose this path only.
            </span>
          </dd>
          <dt className="text-muted-foreground">Webhook only port</dt>
          <dd className="text-foreground-2">
            {settings.dedicatedPort === null ? (
              <>
                Not set. <Mono>HINOMI_WEBHOOK_PORT</Mono> adds a listener that serves only the
                webhook path. Point the public route at it.
              </>
            ) : (
              <>
                Listening on port <Mono>{String(settings.dedicatedPort)}</Mono>. It serves only the
                webhook path. Point the public route here.
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">Content type</dt>
          <dd>
            <Mono>application/json</Mono>
          </dd>
          <dt className="text-muted-foreground">Secret</dt>
          <dd className="text-foreground-2">The one generated above.</dd>
          <dt className="text-muted-foreground">Events</dt>
          <dd className="flex min-w-0 flex-col gap-2">
            <span className="text-foreground-2">
              Choose &ldquo;Let me select individual events&rdquo; and tick:
            </span>
            <ul aria-label="Events to tick in GitHub" className="flex flex-wrap gap-1.5">
              {settings.events
                .filter((event) => event !== 'ping')
                .map((event) => (
                  <li key={event}>
                    <Badge variant="outline" className="font-mono">
                      {EVENT_LABELS[event]}
                    </Badge>
                  </li>
                ))}
            </ul>
            <span className="text-xs text-muted-foreground">
              GitHub sends a ping when the webhook is saved. It shows above as the last delivery.
            </span>
          </dd>
        </dl>
        <a
          href={WEBHOOK_DOCS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 self-start text-sm text-accent-ink underline-offset-2 hover:underline"
        >
          Webhook guide on GitHub
          <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
        </a>
      </Panel>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          if (!open) rotate.reset()
        }}
        title="Rotate the webhook secret?"
        confirmLabel="Rotate secret"
        onConfirm={() => rotate.mutate()}
        pending={rotate.isPending}
        error={rotate.error ? describeError(rotate.error) : null}
      >
        The old secret stops working at once. GitHub deliveries signed with it are refused until you
        paste the new secret into the webhook in GitHub.
      </ConfirmDialog>
    </>
  )
}

/** "Last delivery: pull_request, 5 minutes ago", or why there is none. */
function DeliveryLine({ settings }: { settings: GithubWebhookSettingsDto }) {
  if (settings.lastDeliveryAt) {
    return (
      <>
        Last delivery: <span className="font-mono">{settings.lastDeliveryEvent ?? 'unknown'}</span>,{' '}
        {formatRelative(settings.lastDeliveryAt)}
      </>
    )
  }
  return settings.enabled ? 'On, no delivery has arrived yet' : 'Off, no delivery received'
}

/** The new secret, once. It lives only in this component's state and goes when it is dismissed. */
function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Callout variant="warn" icon={IconKey} title="Shown once. Copy it now.">
      <div className="flex flex-col gap-2.5 pt-1">
        <span>
          Hinomi keeps it encrypted and cannot show it again. Paste it into the webhook secret in
          GitHub, then close this.
        </span>
        <span className="flex max-w-full items-center gap-1 rounded-md border border-border bg-card py-0.5 pr-0.5 pl-2.5">
          <code
            data-testid="webhook-secret"
            className="min-w-0 overflow-x-auto font-mono text-sm whitespace-nowrap text-foreground select-all"
          >
            {secret}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? 'Copied' : 'Copy secret'}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(secret)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }}
          >
            {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
          </Button>
        </span>
        <div>
          <Button variant="outline" size="sm" onClick={onDone}>
            I copied it
          </Button>
        </div>
      </div>
    </Callout>
  )
}
