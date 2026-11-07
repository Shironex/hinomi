import type * as React from 'react'
import { useRef, useState } from 'react'
import { testGithubAppRequestSchema, type SourceAuth } from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  IconApps,
  IconExternalLink,
  IconKey,
  IconLoader2,
  IconPlugConnected,
  IconUpload,
} from '@tabler/icons-react'
import { Field, FieldError } from '@/components/form/field'
import { SegmentedChoice, type SegmentedOption } from '@/components/form/segmented-choice'
import { Button } from '@/components/ui/button'
import { Input, inputClass } from '@/components/ui/input'
import { checkField, hostOf, isSecretKeyMissing, mutationMessage } from '@/lib/form'
import { createSource, testSourceCredentials, updateSource } from '@/lib/settings-api'
import { cn } from '@/lib/utils'
import {
  ConnectionTestFailed,
  newSourceName,
  refreshAfterConnect,
  sentence,
  urlSchema,
  type ConnectFormProps,
} from './connect-shared'
import { SecretKeyCallout } from './secret-key-callout'

const AUTH_OPTIONS: readonly SegmentedOption<SourceAuth>[] = [
  { value: 'token', label: 'Personal access token', icon: IconKey },
  { value: 'github_app', label: 'GitHub App', icon: IconApps },
]

/** Token or GitHub App. */
export function GithubAuthChoice({
  value,
  onChange,
}: {
  value: SourceAuth
  onChange: (next: SourceAuth) => void
}) {
  return (
    <SegmentedChoice
      legend="Connect with"
      options={AUTH_OPTIONS}
      value={value}
      onChange={onChange}
    />
  )
}

const REGISTER_DOCS =
  'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app'

/** The short version of docs/github.md, next to the fields it fills. */
function SetupSteps() {
  return (
    <details className="group rounded-lg border border-border px-3.5 py-2.5 text-sm">
      <summary className="cursor-pointer font-medium marker:text-muted-foreground">
        How to create the app
      </summary>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-foreground-2">
        <li>
          In GitHub open Settings, Developer settings, GitHub Apps, New GitHub App (for an
          organization: the organization&apos;s settings). Any homepage URL works; switch the
          webhook off.
        </li>
        <li>
          Repository permissions, all read only: <b className="font-medium">Dependabot alerts</b>,{' '}
          <b className="font-medium">Contents</b> and <b className="font-medium">Metadata</b>. Add{' '}
          <b className="font-medium">Administration</b> (read) so Hinomi can tell whether Dependabot
          alerts are on.
        </li>
        <li>
          Create the app, note its App ID, and generate a private key. GitHub downloads a .pem file.
        </li>
        <li>
          Install the app on the account and pick the repos. The installation ID is the number at
          the end of the installation&apos;s settings URL.
        </li>
      </ol>
      <a
        href={REGISTER_DOCS}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-2 inline-flex items-center gap-1 text-xs text-accent-ink underline-offset-2 hover:underline"
      >
        GitHub docs: registering a GitHub App
        <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
      </a>
    </details>
  )
}

type FieldName = 'url' | 'appId' | 'installationId' | 'privateKey'
type Errors = Partial<Record<FieldName, string | null>>

// Where a failed test belongs: a rejected JWT points at the key, a missing installation at its ID.
const CODE_FIELD: Record<string, FieldName> = {
  auth: 'privateKey',
  not_found: 'installationId',
  permission: 'installationId',
}

const shape = testGithubAppRequestSchema.shape

/**
 * Tests GitHub App credentials with the server, then saves them. The private key never comes
 * back from the server, so its field always starts empty, also when replacing.
 */
export type GithubAppConnectFormProps = ConnectFormProps

export function GithubAppConnectForm({
  source,
  name,
  onConnected,
  onCancel,
}: GithubAppConnectFormProps) {
  const queryClient = useQueryClient()
  const replacing = source !== undefined
  const [url, setUrl] = useState(source?.baseUrl ?? '')
  const [enterprise, setEnterprise] = useState(Boolean(source?.baseUrl))
  const [appId, setAppId] = useState(source?.appId ?? '')
  const [installationId, setInstallationId] = useState(source?.installationId ?? '')
  const [privateKey, setPrivateKey] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [stage, setStage] = useState<'testing' | 'saving'>('testing')
  const refs = {
    url: useRef<HTMLInputElement>(null),
    appId: useRef<HTMLInputElement>(null),
    installationId: useRef<HTMLInputElement>(null),
    privateKey: useRef<HTMLTextAreaElement>(null),
  }

  const clear = (name: FieldName) => {
    if (errors[name]) setErrors((e) => ({ ...e, [name]: null }))
  }

  const mutation = useMutation({
    mutationFn: async (input: {
      baseUrl: string | null
      appId: string
      installationId: string
      privateKey: string
    }) => {
      setStage('testing')
      const test = await testSourceCredentials({ kind: 'github', auth: 'github_app', ...input })
      if (!test.ok) throw new ConnectionTestFailed(test.code, test.message)
      setStage('saving')
      const { baseUrl, ...app } = input
      const saved = source
        ? await updateSource(source.id, {
            auth: 'github_app',
            ...app,
            ...(baseUrl !== source.baseUrl && { baseUrl }),
          })
        : await createSource({
            kind: 'github',
            name: newSourceName(
              queryClient,
              'github',
              name,
              test.account ?? (baseUrl ? hostOf(baseUrl) : 'GitHub App'),
            ),
            baseUrl,
            auth: 'github_app',
            ...app,
          })
      return { source: saved, test }
    },
    onSuccess: async (result) => {
      setPrivateKey('')
      await refreshAfterConnect(queryClient)
      onConnected(result)
    },
    onError: (error) => {
      if (!(error instanceof ConnectionTestFailed)) return
      const field = CODE_FIELD[error.code] ?? (enterprise ? 'url' : 'privateKey')
      setErrors({ [field]: sentence(error.message) })
      refs[field].current?.focus()
    },
  })

  const generalError =
    mutation.error && !(mutation.error instanceof ConnectionTestFailed) ? mutation.error : null

  async function loadKeyFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPrivateKey((await file.text()).trim())
    clear('privateKey')
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    const next: Errors = {
      url: enterprise
        ? checkField(urlSchema, url, 'Enter the API URL, or switch back to github.com.')
        : null,
      appId: checkField(shape.appId, appId, 'Enter the App ID of the GitHub App.'),
      installationId: checkField(
        shape.installationId,
        installationId,
        'Enter the installation ID.',
      ),
      privateKey: checkField(
        shape.privateKey,
        privateKey,
        'Paste the private key or load the .pem file.',
      ),
    }
    setErrors(next)
    const first = (['url', 'appId', 'installationId', 'privateKey'] as const).find((f) => next[f])
    if (first) return refs[first].current?.focus()
    mutation.mutate({
      baseUrl: enterprise ? url.trim().replace(/\/+$/, '') : null,
      appId: appId.trim(),
      installationId: installationId.trim(),
      privateKey: privateKey.trim(),
    })
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-3.5"
      aria-busy={mutation.isPending}
    >
      <SetupSteps />
      {enterprise ? (
        <Field
          label="GitHub Enterprise API URL"
          help="Leave the box below unticked for github.com."
          error={errors.url}
        >
          {(control) => (
            <Input
              {...control}
              ref={refs.url}
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              className="font-mono"
              placeholder="https://github.example.dev/api/v3"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                clear('url')
              }}
            />
          )}
        </Field>
      ) : null}
      <div className="grid gap-3.5 tab:grid-cols-2">
        <Field
          label="App ID"
          help="On the app's settings page. The Client ID works too."
          error={errors.appId}
        >
          {(control) => (
            <Input
              {...control}
              ref={refs.appId}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="123456"
              value={appId}
              onChange={(e) => {
                setAppId(e.target.value)
                clear('appId')
              }}
            />
          )}
        </Field>
        <Field
          label="Installation ID"
          help="The number at the end of the installation's settings URL."
          error={errors.installationId}
        >
          {(control) => (
            <Input
              {...control}
              ref={refs.installationId}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="51234567"
              value={installationId}
              onChange={(e) => {
                setInstallationId(e.target.value)
                clear('installationId')
              }}
            />
          )}
        </Field>
      </div>
      <Field
        label={replacing ? 'Private key (enter it again)' : 'Private key'}
        help="The .pem file GitHub generated. Stored encrypted and never shown again."
        error={errors.privateKey}
      >
        {(control) => (
          <div className="flex flex-col gap-2">
            <textarea
              {...control}
              ref={refs.privateKey}
              rows={4}
              autoComplete="off"
              spellCheck={false}
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
              className={cn(inputClass, 'h-auto resize-y py-2 font-mono text-xs leading-relaxed')}
              value={privateKey}
              onChange={(e) => {
                setPrivateKey(e.target.value)
                clear('privateKey')
              }}
            />
            <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs text-foreground-2 has-focus-visible:outline-2 has-focus-visible:outline-ring hover:text-foreground">
              <IconUpload aria-hidden="true" className="size-3.5" stroke={1.75} />
              Load .pem file
              <input
                type="file"
                accept=".pem,application/x-pem-file"
                className="sr-only"
                onChange={(e) => void loadKeyFile(e)}
              />
            </label>
          </div>
        )}
      </Field>
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground-2">
        <input
          type="checkbox"
          className="size-4 accent-(--primary)"
          checked={enterprise}
          onChange={(e) => {
            setEnterprise(e.target.checked)
            clear('url')
          }}
        />
        I use GitHub Enterprise Server
      </label>
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
              ? 'Test and save app'
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
