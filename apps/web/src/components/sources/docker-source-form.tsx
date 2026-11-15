import type * as React from 'react'
import { useState } from 'react'
import {
  DOCKER_DEFAULT_SOCKET,
  DOCKER_OPT_IN_LABEL,
  dockerSourceConfigSchema,
  type DockerSourceInput,
  type DockerTransport,
  type SourceDto,
} from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconLoader2,
  IconLock,
  IconPlugConnected,
  IconPlug,
} from '@tabler/icons-react'
import { Field, FieldError } from '@/components/form/field'
import { SegmentedChoice, type SegmentedOption } from '@/components/form/segmented-choice'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input, inputClass } from '@/components/ui/input'
import { checkField, hostOf, isSecretKeyMissing, mutationMessage } from '@/lib/form'
import { createSource, testSourceCredentials, updateSource } from '@/lib/settings-api'
import { cn } from '@/lib/utils'
import {
  ConnectionTestFailed,
  newSourceName,
  refreshAfterConnect,
  sentence,
  type ConnectResult,
} from './connect-shared'
import { SecretKeyCallout } from './secret-key-callout'

// The Docker host source (docs/sources.md, design Q21): a Unix socket, best behind a GET only
// socket proxy, or an https endpoint with TLS client certificates. Plain http is refused by the
// server; the form says so before sending. The client key never comes back, so it starts empty.

const TRANSPORTS: readonly SegmentedOption<DockerTransport>[] = [
  { value: 'socket', label: 'Socket', icon: IconPlug },
  { value: 'tls', label: 'TLS endpoint', icon: IconLock },
]

/** What a Docker host can tell, shown next to the form (design: "container user: yes / no"). */
const CAPABILITIES: readonly [string, boolean][] = [
  ['Container user', true],
  ['Mounts and the Docker socket', true],
  ['Networks', true],
  ['Domains, from labels', true],
  ['Watch paths', false],
  ['Deploy history', false],
]

const socketSchema = dockerSourceConfigSchema.shape.socketPath.unwrap()
const certSchema = dockerSourceConfigSchema.shape.cert.unwrap()

type Errors = Partial<Record<'socketPath' | 'url' | 'ca' | 'cert' | 'key', string | null>>

export interface DockerSourceFormProps {
  /** A saved Docker source to edit. Omit to create one. */
  source?: SourceDto
  /** The name of a new source. Empty: the socket's host name or the endpoint's host. */
  name?: string
  onConnected: (result: ConnectResult) => void
  onCancel?: () => void
}

export function DockerSourceForm({ source, name, onConnected, onCancel }: DockerSourceFormProps) {
  const queryClient = useQueryClient()
  const saved = source?.docker ?? null
  const [transport, setTransport] = useState<DockerTransport>(saved?.transport ?? 'socket')
  const [socketPath, setSocketPath] = useState(saved?.socketPath ?? DOCKER_DEFAULT_SOCKET)
  const [url, setUrl] = useState(source?.baseUrl ?? '')
  const [ca, setCa] = useState(saved?.ca ?? '')
  const [cert, setCert] = useState(saved?.cert ?? '')
  const [key, setKey] = useState('')
  const [optIn, setOptIn] = useState(saved?.optIn ?? true)
  const [errors, setErrors] = useState<Errors>({})
  const [stage, setStage] = useState<'testing' | 'saving'>('testing')
  const keyStored = Boolean(source?.hasToken && saved?.cert)

  const mutation = useMutation({
    mutationFn: async ({
      docker,
      baseUrl,
    }: {
      docker: DockerSourceInput
      baseUrl: string | null
    }) => {
      setStage('testing')
      // A saved key is not sent back, so an unchanged key is tested from the saved source.
      const test =
        source && docker.key === undefined && keyStored
          ? null
          : await testSourceCredentials({ kind: 'docker', baseUrl, docker })
      if (test && !test.ok) throw new ConnectionTestFailed(test.code, test.message)
      setStage('saving')
      const result = source
        ? await updateSource(source.id, { baseUrl, docker })
        : await createSource({
            kind: 'docker',
            name: newSourceName(queryClient, 'docker', name, baseUrl ? hostOf(baseUrl) : 'Docker'),
            baseUrl,
            docker,
          })
      return {
        source: result,
        test: test ?? { ok: true as const, message: 'Connection settings saved' },
      }
    },
    onSuccess: async (result) => {
      setKey('')
      await refreshAfterConnect(queryClient)
      onConnected(result)
    },
  })

  const testError = mutation.error instanceof ConnectionTestFailed ? mutation.error : null
  const generalError = mutation.error && !testError ? mutation.error : null

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    const next: Errors = {}
    if (transport === 'socket') {
      next.socketPath = checkField(socketSchema, socketPath, 'Enter the socket path.')
    } else {
      const trimmed = url.trim()
      next.url = !trimmed
        ? 'Enter the https URL of the Docker endpoint.'
        : /^https:\/\/[^\s/]+/i.test(trimmed)
          ? null
          : 'Use https: plain TCP without TLS is refused, Docker access is root on the host.'
      next.ca = ca.trim() ? checkField(certSchema, ca) : null
      next.cert = cert.trim() ? checkField(certSchema, cert) : null
      next.key =
        cert.trim() && !key.trim() && !keyStored ? 'Paste the key of the client certificate.' : null
    }
    setErrors(next)
    if (Object.values(next).some(Boolean)) return
    const docker: DockerSourceInput =
      transport === 'socket'
        ? { transport, socketPath: socketPath.trim(), optIn }
        : {
            transport,
            ca: ca.trim() || null,
            cert: cert.trim() || null,
            ...(key.trim() ? { key: key.trim() } : !cert.trim() && keyStored ? { key: null } : {}),
            optIn,
          }
    mutation.mutate({
      docker,
      baseUrl: transport === 'tls' ? url.trim().replace(/\/+$/, '') : null,
    })
  }

  const clear = (field: keyof Errors) => setErrors((e) => ({ ...e, [field]: null }))

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-3.5"
      aria-busy={mutation.isPending}
      aria-label="Docker connection"
    >
      <SegmentedChoice
        legend="Connection"
        options={TRANSPORTS}
        value={transport}
        onChange={(next) => {
          setTransport(next)
          setErrors({})
          mutation.reset()
        }}
      />
      {transport === 'socket' ? (
        <Field
          label="Socket path"
          help="Best through a socket proxy that allows only GET on /containers, /version and /_ping. The raw socket works too, but it is root on the host."
          error={errors.socketPath}
          className="max-w-[460px]"
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={socketPath}
              onChange={(e) => {
                setSocketPath(e.target.value)
                clear('socketPath')
              }}
            />
          )}
        </Field>
      ) : (
        <div className="grid gap-3.5 tab:grid-cols-2">
          <Field
            label="Endpoint URL"
            help="https only. Docker's tcp://host:2376 is written https://host:2376."
            error={errors.url}
            className="tab:col-span-2 tab:max-w-[460px]"
          >
            {(control) => (
              <Input
                {...control}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="https://docker.example.com:2376"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  clear('url')
                }}
              />
            )}
          </Field>
          <PemField
            label="CA certificate"
            help="Optional. The CA that signed the daemon's certificate (ca.pem)."
            placeholder="-----BEGIN CERTIFICATE-----"
            value={ca}
            error={errors.ca}
            onChange={(v) => {
              setCa(v)
              clear('ca')
            }}
          />
          <PemField
            label="Client certificate"
            help="Optional. cert.pem, sent with its key."
            placeholder="-----BEGIN CERTIFICATE-----"
            value={cert}
            error={errors.cert}
            onChange={(v) => {
              setCert(v)
              clear('cert')
            }}
          />
          <PemField
            label={keyStored ? 'New client key' : 'Client key'}
            help={
              keyStored
                ? 'A key is stored and never shown again. Leave empty to keep it.'
                : 'key.pem. Encrypted before it is stored, never shown again.'
            }
            placeholder="-----BEGIN PRIVATE KEY-----"
            value={key}
            error={errors.key}
            onChange={(v) => {
              setKey(v)
              clear('key')
            }}
          />
        </div>
      )}
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground-2">
        <input
          type="checkbox"
          className="size-4 accent-(--primary)"
          checked={optIn}
          onChange={(e) => setOptIn(e.target.checked)}
        />
        <span>
          Only read containers labelled{' '}
          <code className="font-mono text-xs">{DOCKER_OPT_IN_LABEL}=true</code>
        </span>
      </label>
      <dl
        aria-label="What a Docker host tells"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      >
        {CAPABILITIES.map(([what, yes]) => (
          <div key={what} className="flex gap-1">
            <dt>{what}:</dt>
            <dd className={yes ? 'text-foreground-2' : undefined}>{yes ? 'yes' : 'no'}</dd>
          </div>
        ))}
      </dl>
      {testError ? (
        <Callout
          variant="danger"
          icon={IconAlertTriangle}
          title="The connection test failed"
          role="alert"
        >
          {sentence(testError.message)}
        </Callout>
      ) : null}
      {generalError ? (
        isSecretKeyMissing(generalError) ? (
          <SecretKeyCallout />
        ) : (
          <div role="alert">
            <FieldError>{mutationMessage(generalError)}</FieldError>
          </div>
        )
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? (
            <IconLoader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <IconPlugConnected aria-hidden="true" />
          )}
          {mutation.isPending
            ? stage === 'testing'
              ? 'Testing connection'
              : 'Saving'
            : source
              ? 'Test and save'
              : 'Test and connect'}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={mutation.isPending}>
            Cancel
          </Button>
        ) : null}
        <span aria-live="polite" className="sr-only">
          {mutation.isPending ? (stage === 'testing' ? 'Testing the connection' : 'Saving') : ''}
        </span>
      </div>
    </form>
  )
}

function PemField({
  label,
  help,
  placeholder,
  value,
  error,
  onChange,
}: {
  label: string
  help: string
  placeholder: string
  value: string
  error: string | null | undefined
  onChange: (value: string) => void
}) {
  return (
    <Field label={label} help={help} error={error}>
      {(control) => (
        <textarea
          {...control}
          rows={3}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          className={cn(inputClass, 'h-auto resize-y py-2 font-mono text-xs leading-relaxed')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  )
}
