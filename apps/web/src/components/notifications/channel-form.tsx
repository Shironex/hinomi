import type * as React from 'react'
import { useRef, useState } from 'react'
import {
  CHANNEL_KIND_FIELDS,
  TELEGRAM_CHAT_ID,
  createNotifyChannelRequestSchema,
  type CreateNotifyChannelRequest,
  type NotifyChannel,
  type NotifyChannelKind,
  type Severity,
  type UpdateNotifyChannelRequest,
} from '@hinomi/shared'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'
import { Field, FieldError } from '@/components/form/field'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { checkField, isInputError, mutationMessage } from '@/lib/form'
import { createChannel, getWebPushKey, settingsKeys, updateChannel } from '@/lib/settings-api'
import { cn } from '@/lib/utils'
import { subscribeThisBrowser, webPushProblem } from '@/lib/web-push'
import { KIND_COPY, KIND_ORDER } from './channel-kinds'
import { EmailFields } from './email-fields'
import { SEVERITY_OPTIONS } from './severity-options'
import { useEmailFields } from './use-email-fields'

type ChannelKind = NotifyChannelKind
type FieldName = 'url' | 'secret' | 'chatId'

const nameSchema = createNotifyChannelRequestSchema.shape.name
const urlSchema = z.string().trim().min(1).max(1000)

/** Which field a server error belongs by: the token, the chat or the URL. */
function fieldOfError(message: string): FieldName | null {
  if (/token|secret/i.test(message)) return 'secret'
  if (/chat/i.test(message)) return 'chatId'
  if (/url|address|private|topic/i.test(message)) return 'url'
  return null
}

interface ChannelFormProps {
  /** Edit this channel; omit to add one. */
  channel?: NotifyChannel
  onDone: (channel: NotifyChannel) => void
  onCancel?: () => void
  submitLabel?: string
}

/**
 * Add or edit a channel of any kind. The stored URL, token and SMTP password
 * are never sent back, so editing leaves them empty to keep them.
 */
export function ChannelForm({ channel, onDone, onCancel, submitLabel }: ChannelFormProps) {
  const queryClient = useQueryClient()
  const editing = channel !== undefined
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? 'discord')
  const [name, setName] = useState(channel?.name ?? '')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [chatId, setChatId] = useState(channel?.chatId ?? '')
  const [allowPrivate, setAllowPrivate] = useState(channel?.allowPrivate ?? false)
  const [minSeverity, setMinSeverity] = useState<Severity>(channel?.minSeverity ?? 'high')
  const [nameError, setNameError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const nameRef = useRef<HTMLInputElement>(null)
  const refs = {
    url: useRef<HTMLInputElement>(null),
    secret: useRef<HTMLInputElement>(null),
    chatId: useRef<HTMLInputElement>(null),
  }
  const emailRefs = {
    host: useRef<HTMLInputElement>(null),
    port: useRef<HTMLInputElement>(null),
    from: useRef<HTMLInputElement>(null),
    to: useRef<HTMLInputElement>(null),
  }
  const emailFields = useEmailFields(channel?.email)
  const copy = KIND_COPY[kind]
  // A browser push channel is made by subscribing, not by typing a URL and keys.
  const browserPush = kind === 'webpush'
  const fields = kind === 'email' || browserPush ? null : CHANNEL_KIND_FIELDS[kind]
  const pushProblem = browserPush && !editing ? webPushProblem() : null

  function clearError(field: FieldName) {
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  function editPatch(current: NotifyChannel, trimmedName: string): UpdateNotifyChannelRequest {
    const patch: UpdateNotifyChannelRequest = {}
    if (trimmedName !== current.name) patch.name = trimmedName
    if (current.kind === 'email') {
      const emailPatch = current.email && emailFields.toPatch(current.email)
      if (emailPatch) patch.email = emailPatch
    } else {
      if (url.trim()) patch.url = url.trim()
      if (secret.trim()) patch.secret = secret.trim()
      if (fields?.chatId && chatId.trim() !== (current.chatId ?? '')) patch.chatId = chatId.trim()
      if (fields?.allowPrivate && allowPrivate !== current.allowPrivate) {
        patch.allowPrivate = allowPrivate
      }
    }
    // PATCH needs at least one field, so an unchanged save resends the severity.
    if (minSeverity !== current.minSeverity || Object.keys(patch).length === 0) {
      patch.minSeverity = minSeverity
    }
    return patch
  }

  function createBody(trimmedName: string): CreateNotifyChannelRequest {
    if (kind === 'email') {
      return { kind, name: trimmedName, email: emailFields.toInput(), minSeverity }
    }
    return {
      kind,
      name: trimmedName,
      minSeverity,
      ...(fields?.url === 'required' && { url: url.trim() }),
      ...(fields?.secret !== 'none' && secret.trim() && { secret: secret.trim() }),
      ...(fields?.chatId && { chatId: chatId.trim() }),
      ...(fields?.allowPrivate && allowPrivate && { allowPrivate }),
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim() || copy.name
      if (channel) return updateChannel(channel.id, editPatch(channel, trimmedName))
      if (browserPush) {
        const { publicKey } = await getWebPushKey()
        const subscription = await subscribeThisBrowser(publicKey)
        return createChannel({ kind, name: trimmedName, minSeverity, ...subscription })
      }
      return createChannel(createBody(trimmedName))
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: settingsKeys.channels })
      onDone(saved)
    },
    onError: (error) => {
      // The server checks the URL, token and chat; put its answer by the field it is about.
      if (kind === 'email' || !isInputError(error)) return
      const field = fieldOfError(error.message)
      if (!field) return
      setErrors((prev) => ({ ...prev, [field]: mutationMessage(error) }))
      refs[field].current?.focus()
    },
  })

  const generalError =
    mutation.error &&
    !(kind !== 'email' && isInputError(mutation.error) && fieldOfError(mutation.error.message))
      ? mutation.error
      : null

  function validateFields(): Partial<Record<FieldName, string>> {
    const next: Partial<Record<FieldName, string>> = {}
    if (fields?.url === 'required' && !(editing && !url.trim())) {
      const urlError =
        checkField(urlSchema, url, 'Paste the URL.') ??
        (/^https?:\/\//i.test(url.trim()) ? null : 'Must be an http or https URL.')
      if (urlError) next.url = urlError
    }
    if (fields?.secret === 'required' && !editing && !secret.trim()) {
      next.secret = `Paste the ${copy.secretLabel.replace(/^./, (c) => c.toLowerCase())}.`
    }
    if (fields?.chatId && !TELEGRAM_CHAT_ID.test(chatId.trim())) {
      next.chatId = 'A chat id is a number like -1001234567890, or @channelname.'
    }
    return next
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    const nextNameError = name.trim() ? checkField(nameSchema, name) : null
    setNameError(nextNameError)
    if (kind === 'email') {
      const firstBad = emailFields.validate()
      if (nextNameError) return nameRef.current?.focus()
      if (firstBad && firstBad !== 'user' && firstBad !== 'password') {
        return emailRefs[firstBad].current?.focus()
      }
      return mutation.mutate()
    }
    const next = validateFields()
    setErrors(next)
    if (nextNameError) return nameRef.current?.focus()
    const firstBad = (['url', 'secret', 'chatId'] as const).find((f) => next[f])
    if (firstBad) return refs[firstBad].current?.focus()
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
          <div className="inline-flex w-fit flex-wrap gap-0.5 rounded-md bg-muted p-0.5">
            {KIND_ORDER.map((k) => {
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
                      setErrors({})
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
              placeholder={copy.namePlaceholder}
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
      {kind === 'email' ? (
        <EmailFields controller={emailFields} stored={channel?.email} fieldRefs={emailRefs} />
      ) : browserPush ? (
        <p className={cn('text-sm', pushProblem ? 'text-wait' : 'text-muted-foreground')}>
          {editing
            ? 'Notifications go to the browser that was added. Remove the channel to stop them.'
            : (pushProblem ??
              'Your browser asks to allow notifications, then alerts arrive here even with Hinomi closed.')}
        </p>
      ) : (
        <>
          {fields?.url === 'required' ? (
            <Field
              label={copy.urlLabel}
              help={editing ? `Stored as ${channel.url}. Leave empty to keep it.` : copy.urlHelp}
              error={errors.url}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={refs.url}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder={copy.urlPlaceholder}
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value)
                    clearError('url')
                  }}
                />
              )}
            </Field>
          ) : null}
          {fields && fields.secret !== 'none' ? (
            <Field
              label={copy.secretLabel}
              help={
                editing && channel.secretSet
                  ? 'One is stored. Leave empty to keep it.'
                  : `${copy.secretHelp} Stored encrypted, never shown again.`
              }
              error={errors.secret}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={refs.secret}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  className="font-mono"
                  value={secret}
                  onChange={(e) => {
                    setSecret(e.target.value)
                    clearError('secret')
                  }}
                />
              )}
            </Field>
          ) : null}
          {fields?.chatId ? (
            <Field
              label="Chat id"
              help="Add the bot to the chat first. A group id starts with -100, a public channel is @name."
              error={errors.chatId}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={refs.chatId}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="-1001234567890"
                  value={chatId}
                  onChange={(e) => {
                    setChatId(e.target.value)
                    clearError('chatId')
                  }}
                />
              )}
            </Field>
          ) : null}
          {fields?.allowPrivate ? (
            <label className="flex w-fit cursor-pointer items-start gap-2 text-sm text-foreground-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-(--primary)"
                checked={allowPrivate}
                onChange={(e) => {
                  setAllowPrivate(e.target.checked)
                  clearError('url')
                }}
              />
              <span>
                Allow private addresses
                <span className="block text-xs text-muted-foreground">
                  For a server on your own network (10.x, 192.168.x, localhost). Leave off for
                  anything on the internet.
                </span>
              </span>
            </label>
          ) : null}
        </>
      )}
      {generalError ? (
        <div role="alert">
          <FieldError>{mutationMessage(generalError)}</FieldError>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={mutation.isPending || pushProblem !== null}>
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
