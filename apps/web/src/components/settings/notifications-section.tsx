import type * as React from 'react'
import { useRef, useState } from 'react'
import { updateNotifySettingsRequestSchema, type NotifyChannel } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconBell,
  IconBrandDiscord,
  IconLoader2,
  IconMail,
  IconPencil,
  IconPlus,
  IconTrash,
  IconWebhook,
} from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field, FieldError } from '@/components/form/field'
import { ChannelForm } from '@/components/notifications/channel-form'
import { SEVERITY_OPTIONS } from '@/components/notifications/severity-options'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { describeError } from '@/lib/errors'
import { checkField, isInputError, mutationMessage } from '@/lib/form'
import {
  channelsQuery,
  notifySettingsQuery,
  removeChannel,
  settingsKeys,
  testChannel,
  updateChannel,
  updateNotifySettings,
} from '@/lib/settings-api'
import { cn } from '@/lib/utils'
import { Panel, SetBox, SetRow, SubHeading } from './settings-section'

export function NotificationsSection() {
  const channels = useQuery(channelsQuery)
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState<string | null>(null)

  let list: React.ReactNode
  if (channels.isPending) {
    list = (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-64" />
      </Panel>
    )
  } else if (channels.isError) {
    list = (
      <ErrorState
        title="Channels did not load"
        error={channels.error}
        onRetry={() => void channels.refetch()}
      />
    )
  } else if (channels.data.items.length === 0 && !adding) {
    list = (
      <EmptyState
        icon={IconBell}
        title="No channels yet"
        actions={
          <Button variant="outline" onClick={() => setAdding(true)}>
            <IconPlus aria-hidden="true" />
            Add channel
          </Button>
        }
      >
        Add a Discord, webhook or email channel to hear about new exposed findings as they appear.
      </EmptyState>
    )
  } else {
    list = (
      <SetBox as="ul" aria-label="Notification channels">
        {channels.data.items.map((channel) => (
          <ChannelRow key={channel.id} channel={channel} />
        ))}
      </SetBox>
    )
  }

  return (
    <>
      {list}
      {adding ? (
        <Panel>
          <h3 className="text-md">Add a channel</h3>
          <ChannelForm
            onCancel={() => setAdding(false)}
            onDone={(channel) => {
              setAdding(false)
              setAdded(`${channel.name} added. Send a test to check it.`)
            }}
          />
        </Panel>
      ) : channels.data && channels.data.items.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => setAdding(true)}>
            <IconPlus aria-hidden="true" />
            Add channel
          </Button>
          <span aria-live="polite" className="text-sm text-success">
            {added}
          </span>
        </div>
      ) : null}
      <DeliverySettings />
    </>
  )
}

const KIND_ICONS = { discord: IconBrandDiscord, webhook: IconWebhook, email: IconMail } as const
const KIND_LABELS = { discord: 'Discord', webhook: 'Webhook', email: 'Email' } as const

function ChannelRow({ channel }: { channel: NotifyChannel }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const KindIcon = KIND_ICONS[channel.kind]
  const severity = SEVERITY_OPTIONS.find((o) => o.value === channel.minSeverity)?.label

  const refresh = () => queryClient.invalidateQueries({ queryKey: settingsKeys.channels })
  const test = useMutation({ mutationFn: () => testChannel(channel.id) })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateChannel(channel.id, { enabled }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => removeChannel(channel.id),
    onSuccess: async () => {
      setConfirming(false)
      await refresh()
    },
  })
  const enabled = toggle.isPending ? (toggle.variables ?? channel.enabled) : channel.enabled

  let outcome: React.ReactNode = null
  if (test.data) {
    outcome = test.data.ok ? (
      <span className="text-success">Test message sent. Check the channel.</span>
    ) : (
      <span className="text-sev-critical">
        Test failed: {test.data.error ?? 'no reason given'}.
      </span>
    )
  } else if (test.error ?? toggle.error) {
    outcome = <span className="text-sev-critical">{describeError(test.error ?? toggle.error)}</span>
  }

  return (
    <SetRow
      as="li"
      icon={<KindIcon stroke={1.75} />}
      title={channel.name}
      sub={
        <>
          {KIND_LABELS[channel.kind]}
          {channel.email ? ` to ${channel.email.to.join(', ')}` : ''}, {severity?.toLowerCase()}
          <span className="block truncate font-mono">{channel.url}</span>
        </>
      }
      aside={
        <Switch
          aria-label={`Send to ${channel.name}`}
          checked={enabled}
          disabled={toggle.isPending}
          onCheckedChange={(next) => toggle.mutate(next)}
        />
      }
    >
      {channel.urlEncrypted ? null : (
        <p className="flex items-start gap-2 text-xs text-wait">
          <IconAlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0" stroke={1.75} />
          Stored without encryption because HINOMI_SECRET_KEY is not set. Set it and save the{' '}
          {channel.kind === 'email' ? 'password' : 'URL'} again.
        </p>
      )}
      {editing ? (
        <div className="border-t border-border pt-3.5">
          <ChannelForm
            channel={channel}
            onCancel={() => setEditing(false)}
            onDone={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => test.mutate()}
            disabled={test.isPending || !enabled}
            title={enabled ? undefined : 'Turn the channel on to send a test'}
          >
            {test.isPending ? (
              <IconLoader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <IconBell aria-hidden="true" />
            )}
            {test.isPending ? 'Sending' : 'Send test'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              test.reset()
              setEditing(true)
            }}
          >
            <IconPencil aria-hidden="true" />
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            <IconTrash aria-hidden="true" />
            Remove
          </Button>
        </div>
      )}
      <p aria-live="polite" className={cn('text-sm', !outcome && 'sr-only')}>
        {outcome}
      </p>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          if (!open) remove.reset()
        }}
        title={`Remove ${channel.name}?`}
        confirmLabel="Remove channel"
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        error={remove.error ? describeError(remove.error) : null}
      >
        Hinomi stops sending alerts and digests here and forgets the webhook URL.
      </ConfirmDialog>
    </SetRow>
  )
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const publicUrlSchema = updateNotifySettingsRequestSchema.shape.publicBaseUrl.unwrap()

/** Public base URL for links in messages and the digest hour. */
function DeliverySettings() {
  const queryClient = useQueryClient()
  const settings = useQuery(notifySettingsQuery)
  const [draft, setDraft] = useState<{ url: string; hour: number } | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const urlRef = useRef<HTMLInputElement>(null)

  const mutation = useMutation({
    mutationFn: updateNotifySettings,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.notifySettings, data)
      setDraft(null)
    },
    onError: (error) => {
      if (!isInputError(error)) return
      setUrlError(mutationMessage(error))
      urlRef.current?.focus()
    },
  })

  if (settings.isPending) {
    return (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-8 w-full" />
      </Panel>
    )
  }
  if (settings.isError) {
    return (
      <ErrorState
        title="Delivery settings did not load"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    )
  }

  const url = draft?.url ?? settings.data.publicBaseUrl ?? ''
  const hour = draft?.hour ?? settings.data.digestHour
  const dirty =
    draft !== null &&
    (url.trim() !== (settings.data.publicBaseUrl ?? '') || hour !== settings.data.digestHour)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending || !dirty) return
    const error = checkField(publicUrlSchema, url)
    setUrlError(error)
    if (error) return urlRef.current?.focus()
    mutation.mutate({ publicBaseUrl: url.trim().replace(/\/+$/, ''), digestHour: hour })
  }

  return (
    <>
      <SubHeading title="Delivery" note="Links in messages and the daily digest" />
      <Panel>
        <form
          noValidate
          onSubmit={submit}
          className="flex flex-col gap-3.5"
          aria-busy={mutation.isPending}
        >
          <div className="grid gap-3.5 tab:grid-cols-[minmax(0,1fr)_180px]">
            <Field
              label="Public address of this Hinomi"
              help="Used for links in messages, for example your Tailscale name. Empty sends no links."
              error={urlError}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={urlRef}
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="https://hinomi.example.dev"
                  value={url}
                  onChange={(e) => {
                    setDraft({ url: e.target.value, hour })
                    if (urlError) setUrlError(null)
                  }}
                />
              )}
            </Field>
            <Field label="Daily digest at" help="Server local time.">
              {(control) => (
                <NativeSelect
                  {...control}
                  value={hour}
                  onChange={(e) => setDraft({ url, hour: Number(e.target.value) })}
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          {mutation.error && !isInputError(mutation.error) ? (
            <div role="alert">
              <FieldError>{describeError(mutation.error)}</FieldError>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={mutation.isPending || !dirty}>
              {mutation.isPending ? (
                <IconLoader2 aria-hidden="true" className="animate-spin" />
              ) : null}
              Save delivery
            </Button>
            <span aria-live="polite" className="text-xs text-muted-foreground">
              {mutation.isSuccess && !dirty ? 'Saved' : ''}
            </span>
          </div>
        </form>
      </Panel>
    </>
  )
}
