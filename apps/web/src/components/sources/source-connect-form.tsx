import type * as React from 'react'
import { useRef, useState } from 'react'
import { testTokenRequestSchema, type SourceDto, type SourceTestResult } from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconLoader2, IconPlugConnected } from '@tabler/icons-react'
import { Field, FieldError } from '@/components/form/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { queryKeys } from '@/lib/queries'
import { checkField, hostOf, isSecretKeyMissing, mutationMessage } from '@/lib/form'
import { createSource, settingsKeys, testSourceCredentials, updateSource } from '@/lib/settings-api'
import { SecretKeyCallout } from './secret-key-callout'

export type ConnectableKind = 'coolify' | 'github'

type SuccessfulTest = Extract<SourceTestResult, { ok: true }>

export interface ConnectResult {
  source: SourceDto
  test: SuccessfulTest
}

interface SourceConnectFormProps {
  kind: ConnectableKind
  /** A saved source to give a new token (and for Coolify, maybe a new URL). Omit to create one. */
  source?: SourceDto
  onConnected: (result: ConnectResult) => void
  onCancel?: () => void
}

/** A failed connection test, carried through the mutation so it lands by the right field. */
class ConnectionTestFailed extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// Codes from the Coolify and GitHub testers that mean the token is the problem.
const TOKEN_CODES = new Set(['unauthorized', 'forbidden', 'auth', 'permission'])

const COPY = {
  coolify: {
    urlLabel: 'Instance URL',
    urlHelp: 'The address you open Coolify at. Hinomi adds /api/v1 itself.',
    urlPlaceholder: 'https://coolify.example.dev',
    tokenLabel: 'API token',
    tokenHelp: 'In Coolify: Keys and Tokens, API tokens. Read only is enough.',
    tokenEmpty: 'Paste the Coolify API token.',
  },
  github: {
    urlLabel: 'GitHub Enterprise API URL',
    urlHelp: 'Leave empty for github.com.',
    urlPlaceholder: 'https://github.example.dev/api/v3',
    tokenLabel: 'Personal access token',
    tokenHelp:
      'Fine-grained: Dependabot alerts (read) and Metadata (read) on the repos to watch. Classic: repo and security_events.',
    tokenEmpty: 'Paste a GitHub token.',
  },
} as const

const urlSchema = testTokenRequestSchema.shape.baseUrl.unwrap().unwrap()

/**
 * Tests Coolify or GitHub credentials with the server, then saves them. Used
 * by onboarding (create) and settings (replace the token). The token never
 * comes back from the server, so the field always starts empty.
 */
export function SourceConnectForm({ kind, source, onConnected, onCancel }: SourceConnectFormProps) {
  const copy = COPY[kind]
  const queryClient = useQueryClient()
  const replacing = source !== undefined
  const [url, setUrl] = useState(source?.baseUrl ?? '')
  const [token, setToken] = useState('')
  const [enterprise, setEnterprise] = useState(kind === 'github' && Boolean(source?.baseUrl))
  const [urlError, setUrlError] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [stage, setStage] = useState<'testing' | 'saving'>('testing')
  const urlRef = useRef<HTMLInputElement>(null)
  const tokenRef = useRef<HTMLInputElement>(null)

  const showUrl = kind === 'coolify' || enterprise

  const mutation = useMutation({
    mutationFn: async ({ baseUrl, token }: { baseUrl: string | null; token: string }) => {
      setStage('testing')
      const test = await testSourceCredentials({ kind, baseUrl, token })
      if (!test.ok) throw new ConnectionTestFailed(test.code, test.message)
      setStage('saving')
      const saved = source
        ? await updateSource(source.id, {
            token,
            ...(baseUrl !== source.baseUrl && { baseUrl }),
          })
        : await createSource({
            kind,
            name: kind === 'coolify' ? hostOf(baseUrl ?? '') : baseUrl ? hostOf(baseUrl) : 'GitHub',
            baseUrl,
            token,
          })
      return { source: saved, test }
    },
    onSuccess: async (result) => {
      setToken('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsKeys.sources }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scanStatus }),
      ])
      onConnected(result)
    },
    onError: (error) => {
      if (error instanceof ConnectionTestFailed) {
        const message = error.message.endsWith('.') ? error.message : `${error.message}.`
        if (TOKEN_CODES.has(error.code) || !showUrl) {
          setTokenError(message)
          tokenRef.current?.focus()
        } else {
          setUrlError(message)
          urlRef.current?.focus()
        }
      }
    },
  })

  // Errors that are about neither field: duplicate name, server down, missing key.
  const generalError =
    mutation.error && !(mutation.error instanceof ConnectionTestFailed) ? mutation.error : null

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    const nextUrlError = showUrl
      ? checkField(
          urlSchema,
          url,
          kind === 'coolify'
            ? 'Enter the Coolify URL.'
            : 'Enter the API URL, or switch back to github.com.',
        )
      : null
    const nextTokenError = checkField(testTokenRequestSchema.shape.token, token, copy.tokenEmpty)
    setUrlError(nextUrlError)
    setTokenError(nextTokenError)
    if (nextUrlError) return urlRef.current?.focus()
    if (nextTokenError) return tokenRef.current?.focus()
    mutation.mutate({
      baseUrl: showUrl ? url.trim().replace(/\/+$/, '') : null,
      token: token.trim(),
    })
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-3.5"
      aria-busy={mutation.isPending}
    >
      <div className={showUrl ? 'grid gap-3.5 tab:grid-cols-2' : 'grid gap-3.5'}>
        {showUrl ? (
          <Field label={copy.urlLabel} help={copy.urlHelp} error={urlError}>
            {(control) => (
              <Input
                {...control}
                ref={urlRef}
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                className="font-mono"
                placeholder={copy.urlPlaceholder}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  if (urlError) setUrlError(null)
                }}
                onBlur={() => {
                  if (url.trim()) setUrlError(checkField(urlSchema, url))
                }}
              />
            )}
          </Field>
        ) : null}
        <Field
          label={replacing ? `New ${copy.tokenLabel.toLowerCase()}` : copy.tokenLabel}
          help={copy.tokenHelp}
          error={tokenError}
        >
          {(control) => (
            <Input
              {...control}
              ref={tokenRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                if (tokenError) setTokenError(null)
              }}
            />
          )}
        </Field>
      </div>
      {kind === 'github' ? (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground-2">
          <input
            type="checkbox"
            className="size-4 accent-(--primary)"
            checked={enterprise}
            onChange={(e) => {
              setEnterprise(e.target.checked)
              setUrlError(null)
            }}
          />
          I use GitHub Enterprise Server
        </label>
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
            : replacing
              ? 'Test and save token'
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
