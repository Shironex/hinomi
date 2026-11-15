import type * as React from 'react'
import { useRef, useState } from 'react'
import {
  createRegistryCredentialRequestSchema,
  normalizeRegistryHost,
  type RegistryCredentialDto,
} from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconKey, IconLoader2, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field, FieldError } from '@/components/form/field'
import { SecretKeyCallout } from '@/components/sources/secret-key-callout'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { describeError } from '@/lib/errors'
import { checkField, isInputError, mutationMessage } from '@/lib/form'
import { formatRelative } from '@/lib/format'
import {
  createRegistryCredential,
  registryCredentialsKey,
  registryCredentialsQuery,
  removeRegistryCredential,
  updateRegistryCredential,
} from '@/lib/registry-credentials-api'
import { Mono, Panel, SetBox, SetRow } from './settings-section'

const { username: usernameSchema, secret: secretSchema } =
  createRegistryCredentialRequestSchema.shape

/**
 * Logins for private registries, read by the SBOM image scan. Its own block under Scans, next to
 * the image scan control. The secret is never shown again once saved.
 */
export function RegistryCredentialsSection() {
  const credentials = useQuery(registryCredentialsQuery)
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState<string | null>(null)

  let body: React.ReactNode
  if (credentials.isPending) {
    body = (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-64" />
      </Panel>
    )
  } else if (credentials.isError) {
    body = (
      <ErrorState
        title="Registry credentials did not load"
        error={credentials.error}
        onRetry={() => void credentials.refetch()}
      />
    )
  } else {
    const { items, canStoreSecrets } = credentials.data
    body = (
      <>
        {canStoreSecrets ? null : <SecretKeyCallout />}
        {items.length > 0 ? (
          <SetBox as="ul" aria-label="Registry credentials">
            {items.map((credential) => (
              <CredentialRow key={credential.id} entry={credential} />
            ))}
          </SetBox>
        ) : adding ? null : (
          <Panel>
            <p className="text-sm text-foreground-2">
              No registry credentials. Public images need none; a private image shows up as{' '}
              <span className="font-medium text-foreground">unauthorized</span> in its coverage note
              until its registry has one.
            </p>
          </Panel>
        )}
        {adding ? (
          <Panel role="group" aria-labelledby="add-registry-credential-title">
            <h3 id="add-registry-credential-title" className="text-md">
              Add a registry credential
            </h3>
            <CredentialForm
              onCancel={() => setAdding(false)}
              onDone={(credential) => {
                setAdding(false)
                setAdded(`${credential.host} added. The next scan reads its private images.`)
              }}
            />
          </Panel>
        ) : canStoreSecrets ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => setAdding(true)}>
              <IconPlus aria-hidden="true" />
              Add registry credential
            </Button>
            <span aria-live="polite" className="text-sm text-success">
              {added}
            </span>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <section aria-labelledby="registry-credentials-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 id="registry-credentials-title" className="text-md">
            Registry credentials
          </h3>
          <span className="text-sm text-muted-foreground">For private images in the SBOM scan</span>
        </div>
        <p className="max-w-[70ch] text-sm text-pretty text-foreground-2">
          One login per registry host. Hinomi sends it to that host and its own token service only,
          to pull image manifests and SBOMs. It is stored encrypted and never shown again.
        </p>
      </div>
      {body}
    </section>
  )
}

function CredentialRow({ entry }: { entry: RegistryCredentialDto }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const remove = useMutation({
    mutationFn: () => removeRegistryCredential(entry.id),
    onSuccess: async () => {
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: registryCredentialsKey })
    },
  })

  return (
    <SetRow
      as="li"
      icon={<IconKey stroke={1.75} />}
      title={<span className="font-mono">{entry.host}</span>}
      sub={
        <>
          As <Mono>{entry.username}</Mono>, {entry.secretSet ? 'secret stored' : 'no secret'},
          changed {formatRelative(entry.updatedAt)}
        </>
      }
    >
      {editing ? (
        <div className="border-t border-border pt-3.5">
          <CredentialForm
            entry={entry}
            onCancel={() => setEditing(false)}
            onDone={() => {
              setEditing(false)
              setSaved('Saved.')
            }}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSaved(null)
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
          <span aria-live="polite" className="text-sm text-success">
            {saved}
          </span>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          if (!open) remove.reset()
        }}
        title={`Remove the credential for ${entry.host}?`}
        confirmLabel="Remove credential"
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        error={remove.error ? describeError(remove.error) : null}
      >
        Hinomi forgets the secret. Private images on this registry show up as unauthorized from the
        next scan.
      </ConfirmDialog>
    </SetRow>
  )
}

/** What the secret field asks for, by the host typed so far. */
function secretHelp(host: string): string {
  const normalized = normalizeRegistryHost(host)
  if (normalized === 'ghcr.io') {
    return 'A personal access token (classic) with the read:packages scope.'
  }
  if (normalized === 'registry-1.docker.io') {
    return 'A Docker Hub personal access token with read only access.'
  }
  return 'The password, or an access token that can pull images.'
}

interface CredentialFormProps {
  /** Editing this entry: the host stays, the user name can change, a new secret replaces. */
  entry?: RegistryCredentialDto
  onCancel: () => void
  onDone: (credential: RegistryCredentialDto) => void
}

function CredentialForm({ entry, onCancel, onDone }: CredentialFormProps) {
  const queryClient = useQueryClient()
  const editing = entry !== undefined
  const [host, setHost] = useState('')
  const [username, setUsername] = useState(entry?.username ?? '')
  const [secret, setSecret] = useState('')
  const [hostError, setHostError] = useState<string | null>(null)
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [secretError, setSecretError] = useState<string | null>(null)
  const hostRef = useRef<HTMLInputElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const secretRef = useRef<HTMLInputElement>(null)

  const mutation = useMutation({
    mutationFn: () => {
      if (entry) {
        const nextName = username.trim()
        return updateRegistryCredential(entry.id, {
          ...(nextName !== entry.username && { username: nextName }),
          ...(secret.trim() !== '' && { secret }),
        })
      }
      return createRegistryCredential({ host, username: username.trim(), secret })
    },
    onSuccess: async (saved) => {
      setSecret('')
      await queryClient.invalidateQueries({ queryKey: registryCredentialsKey })
      onDone(saved)
    },
    onError: (error) => {
      if (!isInputError(error)) return
      // A taken host is the host's problem; anything else names its field in the message.
      const message = mutationMessage(error)
      if (!editing && (error.code === 'conflict' || /host/i.test(error.message))) {
        setHostError(message)
        hostRef.current?.focus()
      } else if (/username/i.test(error.message)) {
        setUsernameError(message)
        usernameRef.current?.focus()
      } else {
        setSecretError(message)
        secretRef.current?.focus()
      }
    },
  })
  const generalError = mutation.error && !isInputError(mutation.error) ? mutation.error : null

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    const nextHostError = editing
      ? null
      : host.trim() === ''
        ? 'Enter the registry host, for example ghcr.io.'
        : normalizeRegistryHost(host) === null
          ? 'Must be a registry host such as ghcr.io or registry.example.com:5000, no path.'
          : null
    const nextUsernameError = checkField(usernameSchema, username, 'Enter the user name.')
    const nextSecretError =
      editing && secret.trim() === ''
        ? null
        : checkField(secretSchema, secret, 'Enter the password or token.')
    setHostError(nextHostError)
    setUsernameError(nextUsernameError)
    setSecretError(nextSecretError)
    if (nextHostError) return hostRef.current?.focus()
    if (nextUsernameError) return usernameRef.current?.focus()
    if (nextSecretError) return secretRef.current?.focus()
    if (entry && username.trim() === entry.username && secret.trim() === '') {
      return onCancel()
    }
    mutation.mutate()
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-3.5"
      aria-busy={mutation.isPending}
    >
      <div className="grid gap-3.5 tab:grid-cols-2">
        {editing ? null : (
          <Field
            label="Registry host"
            help="Exact host, with the port if it has one. docker.io stands for Docker Hub."
            error={hostError}
          >
            {(control) => (
              <Input
                {...control}
                ref={hostRef}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="ghcr.io"
                maxLength={260}
                value={host}
                onChange={(e) => {
                  setHost(e.target.value)
                  if (hostError) setHostError(null)
                }}
              />
            )}
          </Field>
        )}
        <Field label="User name" error={usernameError}>
          {(control) => (
            <Input
              {...control}
              ref={usernameRef}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              maxLength={200}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                if (usernameError) setUsernameError(null)
              }}
            />
          )}
        </Field>
        <Field
          label={editing ? 'New password or token' : 'Password or token'}
          help={editing ? 'Leave empty to keep the stored one.' : secretHelp(host)}
          error={secretError}
        >
          {(control) => (
            <Input
              {...control}
              ref={secretRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value)
                if (secretError) setSecretError(null)
              }}
            />
          )}
        </Field>
      </div>
      {generalError ? (
        <div role="alert">
          <FieldError>{describeError(generalError)}</FieldError>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
          {editing ? 'Save changes' : 'Add credential'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={mutation.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
