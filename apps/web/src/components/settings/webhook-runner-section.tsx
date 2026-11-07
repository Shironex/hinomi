import { useState } from 'react'
import type { WebhookRunnerSettingsDto } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleDashed,
  IconExternalLink,
  IconKey,
  IconLink,
  IconLoader2,
  IconNetwork,
  IconRefresh,
  IconSend,
} from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyCommand } from '@/components/copy-command'
import { Field } from '@/components/form/field'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { describeError } from '@/lib/errors'
import { RUNNERS_DOCS_URL } from '@/lib/fix-run-meta'
import { formatRelative } from '@/lib/format'
import {
  rotateWebhookRunnerSecret,
  settingsKeys,
  updateWebhookRunner,
  webhookRunnerQuery,
} from '@/lib/settings-api'
import { SecretReveal } from './secret-reveal'
import { Mono, Panel, SetBox, SetRow, SubHeading } from './settings-section'

/** The optional webhook runner: where plans go, the private address switch and the secret. */
export function WebhookRunnerSection() {
  const settings = useQuery(webhookRunnerQuery)
  if (settings.isPending) {
    return (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-64" />
      </Panel>
    )
  }
  if (settings.isError) {
    return (
      <ErrorState
        title="Webhook runner settings did not load"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    )
  }
  return <WebhookRunnerPanels settings={settings.data} />
}

type UrlField = 'url' | 'callbackUrl'

/** The URL and the callback URL as one form. An empty field clears the setting. */
function UrlForm({ settings }: { settings: WebhookRunnerSettingsDto }) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState(settings.url ?? '')
  const [callbackUrl, setCallbackUrl] = useState(settings.callbackUrl ?? '')
  const [failed, setFailed] = useState<UrlField>('url')
  const save = useMutation({
    mutationFn: updateWebhookRunner,
    onSuccess: (data) => queryClient.setQueryData(settingsKeys.webhookRunner, data),
  })
  const urlChanged = url.trim() !== (settings.url ?? '')
  const callbackChanged = callbackUrl.trim() !== (settings.callbackUrl ?? '')
  const message = save.error ? describeError(save.error) : null
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!urlChanged && !callbackChanged) return
        setFailed(urlChanged ? 'url' : 'callbackUrl')
        save.mutate({
          ...(urlChanged && { url: url.trim() || null }),
          ...(callbackChanged && { callbackUrl: callbackUrl.trim() || null }),
        })
      }}
    >
      <Field
        label="Runner URL"
        help="Where Hinomi posts the plan. https only, no user or password, public addresses only unless private addresses are allowed below."
        error={failed === 'url' ? message : null}
      >
        {(control) => (
          <Input
            {...control}
            type="text"
            inputMode="url"
            value={url}
            placeholder="https://runner.example.dev/hinomi"
            onChange={(event) => setUrl(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
        )}
      </Field>
      <Field
        label="Callback URL (optional)"
        help={
          <>
            The address under which the runner reaches the callback path, for example{' '}
            <Mono>{`https://hooks.example.dev${settings.callbackPath}`}</Mono>. It is sent with
            every plan.
          </>
        }
        error={failed === 'callbackUrl' ? message : null}
      >
        {(control) => (
          <Input
            {...control}
            type="text"
            inputMode="url"
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={save.isPending || (!urlChanged && !callbackChanged)}
        >
          {save.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
          Save
        </Button>
        {save.isSuccess && !urlChanged && !callbackChanged ? (
          <span role="status" className="text-xs text-muted-foreground">
            Saved
          </span>
        ) : null}
      </div>
    </form>
  )
}

function WebhookRunnerPanels({ settings }: { settings: WebhookRunnerSettingsDto }) {
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const save = (data: WebhookRunnerSettingsDto) =>
    queryClient.setQueryData(settingsKeys.webhookRunner, data)
  const toggle = useMutation({ mutationFn: updateWebhookRunner, onSuccess: save })
  const rotate = useMutation({
    mutationFn: rotateWebhookRunnerSecret,
    onSuccess: (data) => {
      setConfirming(false)
      setSecret(data.secret)
      save(data.settings)
    },
  })

  const { canStoreSecret, secretSet, allowPrivate } = settings
  const shownPrivate = toggle.isPending
    ? (toggle.variables?.allowPrivate ?? allowPrivate)
    : allowPrivate

  return (
    <>
      {canStoreSecret ? null : (
        <Callout variant="warn" icon={IconAlertTriangle} title="Secret key missing">
          Set <Mono>HINOMI_SECRET_KEY</Mono> and restart Hinomi. The runner secret is stored
          encrypted with it, so none can be made without it.
        </Callout>
      )}

      <SetBox>
        <SetRow
          icon={<IconSend stroke={1.75} />}
          title="Status"
          sub={settings.message}
          aside={
            settings.configured ? (
              <Badge variant="success">
                <IconCheck aria-hidden="true" />
                Configured
              </Badge>
            ) : (
              <Badge>
                <IconCircleDashed aria-hidden="true" />
                Not configured
              </Badge>
            )
          }
        >
          <p className="text-sm text-foreground-2">
            {settings.lastCallbackAt
              ? `Last callback ${formatRelative(settings.lastCallbackAt)}`
              : 'No callback has arrived yet'}
          </p>
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
          icon={<IconLink stroke={1.75} />}
          title="Where plans go"
          sub="Plans are posted here, signed with the secret"
        >
          <UrlForm key={`${settings.url}|${settings.callbackUrl}`} settings={settings} />
        </SetRow>

        <SetRow
          icon={<IconNetwork stroke={1.75} />}
          title="Allow private addresses"
          sub="Lets the URL be plain http and point at addresses on your own network"
          aside={
            <Switch
              aria-label="Allow private addresses for the webhook runner"
              aria-describedby="runner-private-risk"
              checked={shownPrivate}
              disabled={toggle.isPending}
              onCheckedChange={(next) => toggle.mutate({ allowPrivate: next })}
            />
          }
        >
          <p id="runner-private-risk" className="text-xs text-muted-foreground">
            With this on, the URL may point anywhere on Hinomi&apos;s network, internal services
            included. Leave it off unless the runner really lives there.
          </p>
          {toggle.error ? (
            <p role="alert" className="text-sm text-sev-critical">
              {describeError(toggle.error)}
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
          {secret ? (
            <SecretReveal
              secret={secret}
              testId="runner-secret"
              where="the external runner, which checks every plan against it"
              onDone={() => setSecret(null)}
            />
          ) : null}
        </SetRow>
      </SetBox>

      <SubHeading title="Set up the external runner" note="Where it reports back" />
      <Panel>
        <dl className="grid gap-x-4 gap-y-3 text-sm tab:grid-cols-[140px_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Callback path</dt>
          <dd className="flex min-w-0 flex-col gap-1.5">
            <CopyCommand command={settings.callbackPath} />
            <span className="text-xs text-muted-foreground">
              The runner posts its signed reports here. Put the public address of this Hinomi in
              front and expose this path only.
            </span>
          </dd>
          <dt className="text-muted-foreground">Webhook only port</dt>
          <dd className="text-foreground-2">
            {settings.dedicatedPort === null ? (
              <>
                Not set. <Mono>HINOMI_WEBHOOK_PORT</Mono> adds a listener that serves only the
                webhook paths. Point the public route at it.
              </>
            ) : (
              <>
                Listening on port <Mono>{String(settings.dedicatedPort)}</Mono>
                {'. '}It serves only the webhook paths. Point the public route here.
              </>
            )}
          </dd>
          {settings.dedicatedPort === null ? null : (
            <>
              <dt className="text-muted-foreground">Port</dt>
              <dd>
                <CopyCommand command={String(settings.dedicatedPort)} />
              </dd>
            </>
          )}
        </dl>
        <a
          href={RUNNERS_DOCS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 self-start text-sm text-accent-ink underline-offset-2 hover:underline"
        >
          Fix runners guide on GitHub
          <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </Panel>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          if (!open) rotate.reset()
        }}
        title="Rotate the runner secret?"
        confirmLabel="Rotate secret"
        onConfirm={() => rotate.mutate()}
        pending={rotate.isPending}
        error={rotate.error ? describeError(rotate.error) : null}
      >
        The old secret stops working at once. Plans are signed with the new one and callbacks signed
        with the old one are refused until you paste the new secret into the external runner.
      </ConfirmDialog>
    </>
  )
}
