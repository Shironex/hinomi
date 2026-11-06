import type * as React from 'react'
import { useRef, useState } from 'react'
import {
  createNotifyChannelRequestSchema,
  type NotifyChannel,
  type Severity,
  type UpdateNotifyChannelRequest,
} from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconBrandDiscord, IconLoader2, IconWebhook } from '@tabler/icons-react'
import { Field, FieldError } from '@/components/form/field'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { checkField, isInputError, mutationMessage } from '@/lib/form'
import { createChannel, settingsKeys, updateChannel } from '@/lib/settings-api'
import { cn } from '@/lib/utils'
import { SEVERITY_OPTIONS } from './severity-options'

type ChannelKind = NotifyChannel['kind']

const KIND_COPY: Record<
  ChannelKind,
  { label: string; icon: typeof IconWebhook; placeholder: string; help: string; name: string }
> = {
  discord: {
    label: 'Discord',
    icon: IconBrandDiscord,
    placeholder: 'https://discord.com/api/webhooks/...',
    help: 'Channel settings, Integrations, Webhooks, Copy webhook URL.',
    name: 'Discord',
  },
  webhook: {
    label: 'Webhook',
    icon: IconWebhook,
    placeholder: 'https://hooks.example.dev/hinomi',
    help: 'Hinomi sends a JSON POST. See docs/notifications.md for the payload.',
    name: 'Webhook',
  },
}

const nameSchema = createNotifyChannelRequestSchema.shape.name
const urlSchema = createNotifyChannelRequestSchema.shape.url

interface ChannelFormProps {
  /** Edit this channel; omit to add one. */
  channel?: NotifyChannel
  onDone: (channel: NotifyChannel) => void
  onCancel?: () => void
  submitLabel?: string
}

/**
 * Add or edit a Discord or generic webhook channel. The stored URL is never
 * sent back, so editing leaves the URL empty to keep it.
 */
export function ChannelForm({ channel, onDone, onCancel, submitLabel }: ChannelFormProps) {
  const queryClient = useQueryClient()
  const editing = channel !== undefined
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? 'discord')
  const [name, setName] = useState(channel?.name ?? '')
  const [url, setUrl] = useState('')
  const [minSeverity, setMinSeverity] = useState<Severity>(channel?.minSeverity ?? 'high')
  const [nameError, setNameError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const copy = KIND_COPY[kind]

  const mutation = useMutation({
    mutationFn: () => {
      const trimmedName = name.trim() || copy.name
      if (channel) {
        const patch: UpdateNotifyChannelRequest = {}
        if (trimmedName !== channel.name) patch.name = trimmedName
        if (url.trim()) patch.url = url.trim()
        // PATCH needs at least one field, so an unchanged save resends the severity.
        if (minSeverity !== channel.minSeverity || Object.keys(patch).length === 0) {
          patch.minSeverity = minSeverity
        }
        return updateChannel(channel.id, patch)
      }
      return createChannel({ kind, name: trimmedName, url: url.trim(), minSeverity })
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: settingsKeys.channels })
      onDone(saved)
    },
    onError: (error) => {
      // The server checks the URL shape (Discord host, http or https); put that by the URL field.
      if (isInputError(error) && /url/i.test(error.message)) {
        setUrlError(mutationMessage(error))
        urlRef.current?.focus()
      }
    },
  })

  const generalError =
    mutation.error && !(isInputError(mutation.error) && /url/i.test(mutation.error.message))
      ? mutation.error
      : null

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    const nextNameError = name.trim() ? checkField(nameSchema, name) : null
    const nextUrlError =
      editing && !url.trim()
        ? null
        : (checkField(urlSchema, url, 'Paste the webhook URL.') ??
          (/^https?:\/\//i.test(url.trim()) ? null : 'Must be an http or https URL.'))
    setNameError(nextNameError)
    setUrlError(nextUrlError)
    if (nextNameError) return nameRef.current?.focus()
    if (nextUrlError) return urlRef.current?.focus()
    mutation.mutate()
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-3.5"
      aria-busy={mutation.isPending}
    >
      {editing ? null : (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">Type</legend>
          <div className="inline-flex w-fit gap-0.5 rounded-md bg-muted p-0.5">
            {(Object.keys(KIND_COPY) as ChannelKind[]).map((k) => {
              const KindIcon = KIND_COPY[k].icon
              return (
                <label
                  key={k}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs text-foreground-2 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-ring hover:text-foreground',
                    kind === k &&
                      'bg-card text-foreground shadow-[0_1px_2px_oklch(0.2_0.02_265/0.12)]',
                  )}
                >
                  <input
                    type="radio"
                    name="channel-kind"
                    value={k}
                    checked={kind === k}
                    onChange={() => {
                      setKind(k)
                      setUrlError(null)
                    }}
                    className="sr-only"
                  />
                  <KindIcon aria-hidden="true" className="size-3.5" stroke={1.75} />
                  {KIND_COPY[k].label}
                </label>
              )
            })}
          </div>
        </fieldset>
      )}
      <div className="grid gap-3.5 tab:grid-cols-2">
        <Field
          label="Name"
          help={`Optional, shown in this list. Defaults to ${copy.name}.`}
          error={nameError}
        >
          {(control) => (
            <Input
              {...control}
              ref={nameRef}
              placeholder={copy.name === 'Discord' ? 'Discord #ops' : 'Incident bot'}
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value)
                if (nameError) setNameError(null)
              }}
            />
          )}
        </Field>
        <Field label="Alert on" help="Least severe exposed finding that alerts right away.">
          {(control) => (
            <NativeSelect
              {...control}
              value={minSeverity}
              onChange={(e) => setMinSeverity(e.target.value as Severity)}
            >
              {SEVERITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <Field
        label={`${copy.label} webhook URL`}
        help={editing ? `Stored as ${channel.url}. Leave empty to keep it.` : copy.help}
        error={urlError}
      >
        {(control) => (
          <Input
            {...control}
            ref={urlRef}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder={copy.placeholder}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              if (urlError) setUrlError(null)
            }}
          />
        )}
      </Field>
      {generalError ? (
        <div role="alert">
          <FieldError>{mutationMessage(generalError)}</FieldError>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
          {submitLabel ?? (editing ? 'Save changes' : 'Add channel')}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={mutation.isPending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  )
}
