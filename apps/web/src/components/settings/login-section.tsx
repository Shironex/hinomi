import type * as React from 'react'
import { useState } from 'react'
import type { AuthSession, AuthSessionRow, Passkey } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  IconDeviceDesktop,
  IconExternalLink,
  IconFingerprint,
  IconLoader2,
  IconLock,
  IconLockOpen,
  IconLogout,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field } from '@/components/form/field'
import { ErrorState } from '@/components/states/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  addPasskey,
  authKeys,
  authSessionQuery,
  logout,
  passkeysQuery,
  removePasskey,
  revokeOtherSessions,
  revokeSession,
  sessionsQuery,
} from '@/lib/auth-api'
import { describeError } from '@/lib/errors'
import { formatRelative } from '@/lib/format'
import { passkeysSupported } from '@/lib/webauthn'
import { Mono, Panel, SetBox, SetRow, SubHeading } from './settings-section'

export const AUTH_DOCS_URL = 'https://github.com/Shironex/hinomi/blob/main/docs/auth.md'

const METHOD_WORD = { passkey: 'a passkey', oidc: 'single sign on', github: 'GitHub' } as const

/**
 * The built in login under Settings, Access: whether it is on, who is signed in, the passkeys and
 * the sessions. While it is off, how to turn it on.
 */
export function LoginSection() {
  const auth = useQuery(authSessionQuery)
  if (auth.isPending) {
    return (
      <Panel aria-hidden="true">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-64" />
      </Panel>
    )
  }
  if (auth.isError) {
    return (
      <ErrorState
        title="The login state did not load"
        error={auth.error}
        onRetry={() => void auth.refetch()}
      />
    )
  }
  if (!auth.data.enabled) return <LoginOff />
  return <LoginOn auth={auth.data} />
}

function DocsLink({ children }: { children: React.ReactNode }) {
  return (
    <a
      href={AUTH_DOCS_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-accent-ink underline-offset-2 hover:underline"
    >
      {children}
      <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
    </a>
  )
}

function LoginOff() {
  return (
    <SetBox>
      <SetRow
        icon={<IconLockOpen stroke={1.75} />}
        title="Built in login is off"
        sub={
          <>
            Set <Mono>HINOMI_AUTH=1</Mono> and <Mono>HINOMI_AUTH_PUBLIC_URL</Mono> to require
            passkeys, single sign on or GitHub. <DocsLink>How to turn it on</DocsLink>
          </>
        }
        aside={<Badge variant="outline">Off</Badge>}
        stackAside
      />
    </SetBox>
  )
}

function LoginOn({ auth }: { auth: AuthSession }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const session = auth.session
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      queryClient.clear()
      await navigate({ to: '/login', replace: true })
    },
  })
  const ways = [
    auth.methods.oidc ? auth.methods.oidc.name : null,
    auth.methods.github ? 'GitHub' : null,
    'passkeys',
  ].filter(Boolean)

  return (
    <>
      <SetBox>
        <SetRow
          icon={<IconLock stroke={1.75} />}
          title="Built in login is on"
          sub={
            <>
              Sign in with {ways.join(', ')}. <DocsLink>About the login</DocsLink>
            </>
          }
          aside={<Badge variant="success">On</Badge>}
          stackAside
        />
        {session ? (
          <SetRow
            icon={<IconFingerprint stroke={1.75} />}
            title={`Signed in as ${session.subject}`}
            sub={`With ${METHOD_WORD[session.method]}; this session ends ${formatRelative(session.expiresAt)} at the latest`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={signOut.isPending}
                onClick={() => signOut.mutate()}
              >
                <IconLogout aria-hidden="true" />
                Sign out
              </Button>
              {signOut.error ? (
                <span role="alert" className="text-sm text-sev-critical">
                  {describeError(signOut.error)}
                </span>
              ) : null}
            </div>
          </SetRow>
        ) : null}
      </SetBox>
      <PasskeysBlock />
      <SessionsBlock />
    </>
  )
}

function PasskeysBlock() {
  const passkeys = useQuery(passkeysQuery)
  const [adding, setAdding] = useState(false)
  return (
    <section aria-labelledby="passkeys-title" className="flex flex-col gap-3">
      <span id="passkeys-title">
        <SubHeading title="Passkeys" note="Any of them signs in" />
      </span>
      {passkeys.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : passkeys.isError ? (
        <ErrorState
          title="Passkeys did not load"
          error={passkeys.error}
          onRetry={() => void passkeys.refetch()}
        />
      ) : passkeys.data.passkeys.length === 0 ? (
        <Panel>
          <p className="text-sm text-foreground-2">No passkeys yet.</p>
        </Panel>
      ) : (
        <SetBox as="ul" aria-label="Passkeys">
          {passkeys.data.passkeys.map((p) => (
            <PasskeyRow key={p.id} passkey={p} />
          ))}
        </SetBox>
      )}
      {adding ? (
        <AddPasskeyForm onDone={() => setAdding(false)} />
      ) : (
        <Button
          variant="outline"
          className="self-start"
          disabled={!passkeysSupported()}
          onClick={() => setAdding(true)}
        >
          <IconPlus aria-hidden="true" />
          Add a passkey
        </Button>
      )}
    </section>
  )
}

function PasskeyRow({ passkey }: { passkey: Passkey }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () => removePasskey(passkey.id),
    onSuccess: async () => {
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: authKeys.passkeys })
      await queryClient.invalidateQueries({ queryKey: authKeys.sessions })
      await queryClient.invalidateQueries({ queryKey: authKeys.session })
    },
  })
  return (
    <SetRow
      as="li"
      icon={<IconFingerprint stroke={1.75} />}
      title={passkey.name}
      sub={`Added ${formatRelative(passkey.createdAt)}, ${passkey.lastUsedAt ? `last used ${formatRelative(passkey.lastUsedAt)}` : 'never used to sign in'}`}
      aside={
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${passkey.name}`}
          onClick={() => setConfirming(true)}
        >
          <IconTrash aria-hidden="true" />
          Remove
        </Button>
      }
    >
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open)
          if (!open) remove.reset()
        }}
        title={`Remove the passkey ${passkey.name}?`}
        confirmLabel="Remove passkey"
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        error={remove.error ? describeError(remove.error) : null}
      >
        It can no longer sign in, and sessions it started end now.
      </ConfirmDialog>
    </SetRow>
  )
}

function AddPasskeyForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const add = useMutation({
    mutationFn: () => addPasskey(name.trim() || 'Passkey'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authKeys.passkeys })
      onDone()
    },
  })
  return (
    <Panel role="group" aria-labelledby="add-passkey-title">
      <h3 id="add-passkey-title" className="text-md">
        Add a passkey
      </h3>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate()
        }}
      >
        <Field label="Name" help="So you can tell your passkeys apart, for example YubiKey.">
          {(props) => (
            <Input
              {...props}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoFocus
            />
          )}
        </Field>
        {add.error ? (
          <span role="alert" className="text-sm text-sev-critical">
            {describeError(add.error)}
          </span>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
            Create passkey
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  )
}

function SessionsBlock() {
  const queryClient = useQueryClient()
  const sessions = useQuery(sessionsQuery)
  const others = useMutation({
    mutationFn: revokeOtherSessions,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.sessions }),
  })
  const count = sessions.data?.sessions.filter((s) => !s.current).length ?? 0
  return (
    <section aria-labelledby="sessions-title" className="flex flex-col gap-3">
      <span id="sessions-title">
        <SubHeading
          title="Sessions"
          note="A session ends after 12 idle hours, and after 7 days in any case"
        />
      </span>
      {sessions.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : sessions.isError ? (
        <ErrorState
          title="Sessions did not load"
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <SetBox as="ul" aria-label="Sessions">
          {sessions.data.sessions.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </SetBox>
      )}
      {count > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={others.isPending} onClick={() => others.mutate()}>
            <IconLogout aria-hidden="true" />
            Sign out the other {count === 1 ? 'session' : `${count} sessions`}
          </Button>
          {others.error ? (
            <span role="alert" className="text-sm text-sev-critical">
              {describeError(others.error)}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function SessionRow({ session }: { session: AuthSessionRow }) {
  const queryClient = useQueryClient()
  const revoke = useMutation({
    mutationFn: () => revokeSession(session.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.sessions }),
  })
  return (
    <SetRow
      as="li"
      icon={<IconDeviceDesktop stroke={1.75} />}
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{session.subject}</span>
          {session.current ? <Badge variant="outline">This browser</Badge> : null}
        </span>
      }
      sub={[
        `With ${METHOD_WORD[session.method]}`,
        `active ${formatRelative(session.lastSeenAt)}`,
        session.ip ? `from ${session.ip}` : null,
        session.userAgent,
      ]
        .filter(Boolean)
        .join(', ')}
      aside={
        session.current ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
            aria-label={`Sign out the session of ${session.subject}`}
          >
            <IconLogout aria-hidden="true" />
            Sign out
          </Button>
        )
      }
    />
  )
}
