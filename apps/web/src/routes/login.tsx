import type * as React from 'react'
import { useState } from 'react'
import type { LoginError } from '@hinomi/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, getRouteApi, useNavigate } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconFingerprint,
  IconKey,
  IconLoader2,
  IconLogin2,
} from '@tabler/icons-react'
import { Field } from '@/components/form/field'
import { BrandMark } from '@/components/shell/brand-mark'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  authKeys,
  authSessionQuery,
  enrollWithSetupCode,
  loginWithPasskey,
  providerLoginUrl,
} from '@/lib/auth-api'
import { describeError } from '@/lib/errors'
import { passkeysSupported } from '@/lib/webauthn'

const route = getRouteApi('/login')

/** What the provider callbacks put in `?error=`, said for people. */
const LOGIN_ERROR_TEXT: Record<LoginError, string> = {
  not_allowed:
    'That account is not on the allow list of this Hinomi. Ask whoever runs it to add it to HINOMI_AUTH_ALLOWED.',
  expired: 'The sign in took too long or was started in another browser. Try again.',
  failed: 'The provider did not confirm the sign in. Try again, or use another way in.',
  rate_limited: 'Too many failed attempts from this address. Wait a few minutes and try again.',
}

/** The login page, shown while the built in login is on and this browser has no session. */
export function LoginPage() {
  const { next = '/', error } = route.useSearch()
  const auth = useQuery(authSessionQuery)
  const [setupOpen, setSetupOpen] = useState(false)

  if (auth.isPending) {
    return (
      <LoginFrame>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </LoginFrame>
    )
  }
  if (auth.isError) {
    return (
      <LoginFrame>
        <ErrorState
          title="Hinomi did not answer"
          error={auth.error}
          onRetry={() => void auth.refetch()}
        />
      </LoginFrame>
    )
  }
  // Login off, or already signed in: nothing to do here.
  if (!auth.data.enabled || auth.data.session) return <Navigate to={next} replace />

  const { methods } = auth.data
  return (
    <LoginFrame>
      {error ? (
        <Callout variant="danger" icon={IconAlertTriangle} title="Not signed in" role="alert">
          {LOGIN_ERROR_TEXT[error]}
        </Callout>
      ) : null}
      <div className="flex flex-col gap-2.5">
        {methods.oidc ? (
          <Button asChild size="lg" className="w-full">
            <a href={providerLoginUrl('oidc', next)}>
              <IconLogin2 aria-hidden="true" />
              Sign in with {methods.oidc.name}
            </a>
          </Button>
        ) : null}
        {methods.github ? (
          <Button
            asChild
            size="lg"
            variant={methods.oidc ? 'outline' : 'default'}
            className="w-full"
          >
            <a href={providerLoginUrl('github', next)}>
              <IconBrandGithub aria-hidden="true" />
              Sign in with GitHub
            </a>
          </Button>
        ) : null}
        {methods.passkey ? (
          <PasskeyButton next={next} primary={!methods.oidc && !methods.github} />
        ) : null}
      </div>
      {setupOpen ? (
        <SetupCodeForm next={next} onCancel={() => setSetupOpen(false)} />
      ) : (
        <Button variant="link" className="self-center" onClick={() => setSetupOpen(true)}>
          <IconKey aria-hidden="true" />
          Use a setup code
        </Button>
      )}
    </LoginFrame>
  )
}

function LoginFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center px-4 py-10">
      <div className="flex w-full max-w-[400px] flex-col gap-5 rounded-lg border border-border bg-card p-6 tab:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark size={44} />
          <h1 className="text-xl">Sign in to Hinomi</h1>
        </div>
        {children}
      </div>
    </div>
  )
}

/** After a login: refresh the session (and its CSRF token), then go where the person was. */
function useFinishLogin(next: string) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    // Anything cached before the login belongs to no one; start clean.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== authKeys.session[0] })
    await queryClient.invalidateQueries({ queryKey: authKeys.session })
    await queryClient.fetchQuery(authSessionQuery)
    await navigate({ to: next, replace: true })
  }
}

function PasskeyButton({ next, primary }: { next: string; primary: boolean }) {
  const finish = useFinishLogin(next)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const supported = passkeysSupported()

  async function signIn() {
    setPending(true)
    setMessage(null)
    try {
      await loginWithPasskey()
      await finish()
    } catch (error) {
      setMessage(describeError(error))
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        size="lg"
        variant={primary ? 'default' : 'outline'}
        className="w-full"
        disabled={!supported || pending}
        onClick={() => void signIn()}
      >
        {pending ? (
          <IconLoader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <IconFingerprint aria-hidden="true" />
        )}
        Sign in with a passkey
      </Button>
      {supported ? null : (
        <span className="text-xs text-muted-foreground">
          Passkeys need https (or localhost) and a browser that supports them.
        </span>
      )}
      {message ? (
        <span role="alert" className="text-xs text-sev-critical">
          {message}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The first passkey, or a new one after a reset: the code printed by `cli.mjs setup-code` in the
 * container, a name for the passkey, then the browser prompt.
 */
function SetupCodeForm({ next, onCancel }: { next: string; onCancel: () => void }) {
  const finish = useFinishLogin(next)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setMessage(null)
    try {
      await enrollWithSetupCode(code, name.trim() || 'Passkey')
      await finish()
    } catch (error) {
      setMessage(describeError(error))
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-labelledby="setup-code-title"
      className="flex flex-col gap-3 border-t border-border pt-4"
    >
      <h2 id="setup-code-title" className="text-md">
        Register a passkey with a setup code
      </h2>
      <p className="text-sm text-foreground-2">
        Run{' '}
        <code className="font-mono text-[0.92em]">node apps/server/dist/cli.mjs setup-code</code> in
        the Hinomi container. The code works once, for 15 minutes.
      </p>
      <Field label="Setup code">
        {(props) => (
          <Input
            {...props}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX"
            className="font-mono"
            required
            autoFocus
          />
        )}
      </Field>
      <Field label="Passkey name" help="So you can tell your passkeys apart later.">
        {(props) => (
          <Input
            {...props}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="MacBook"
          />
        )}
      </Field>
      {message ? (
        <span role="alert" className="text-sm text-sev-critical">
          {message}
        </span>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || !passkeysSupported()}>
          {pending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
          Register and sign in
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
