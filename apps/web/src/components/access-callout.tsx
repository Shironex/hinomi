import type { AccessStatus } from '@hinomi/shared'
import type * as React from 'react'
import { IconExternalLink, IconLock, IconShieldCheck, IconWorld } from '@tabler/icons-react'
import { Callout } from '@/components/ui/callout'
import { ACCESS_DOCS_URL, accessTone, useAccessStatus, useLoginEnabled } from '@/hooks/use-access'

const NO_LOGIN =
  'The built in login is off, so anyone who passes this layer can read your findings and change these settings.'
const LOGIN_ON = 'The built in login is on as well, so every request also needs a session.'

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[max(13px,0.92em)]">{children}</code>
}

function DocsLink() {
  return (
    <a
      href={ACCESS_DOCS_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="mt-1 inline-flex items-center gap-1 text-xs text-accent-ink underline-offset-2 hover:underline"
    >
      How Hinomi detects this
      <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
    </a>
  )
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p>{children}</p>
      <DocsLink />
    </div>
  )
}

function protectedTitle(status: AccessStatus): string {
  if (status.state === 'tailscale') {
    return status.login ? `Protected by Tailscale as ${status.login}` : 'Protected by Tailscale'
  }
  if (status.state === 'cloudflare_access' && status.email) {
    return `Protected by Cloudflare Access as ${status.email}`
  }
  return 'Protected by Cloudflare Access'
}

/** Why Hinomi could not tell, for the unknown state. */
function unknownDetail(status: Extract<AccessStatus, { state: 'unknown' }>) {
  if (status.reason === 'loopback') {
    return (
      <>
        This request came from this machine (<Mono>{status.address}</Mono>), for example a local
        reverse proxy.
      </>
    )
  }
  if (status.reason === 'private_address' && status.address) {
    return (
      <>
        This request came from <Mono>{status.address}</Mono>, a private or container address, so
        Hinomi cannot see where it started.
      </>
    )
  }
  return null
}

/**
 * How this browser reaches Hinomi, from GET /api/access: a calm note when Tailscale or a
 * verified Cloudflare Access token is in front, a red warning from a public address, and
 * the plain warning (with `title`) whenever Hinomi cannot confirm either.
 */
export function AccessCallout({ title = 'The built in login is off' }: { title?: string }) {
  const status = useAccessStatus()
  const loginOn = useLoginEnabled()
  const tone = accessTone(status, loginOn)
  const loginNote = loginOn ? LOGIN_ON : NO_LOGIN

  if (status && tone === 'ok') {
    const detail =
      status.state === 'tailscale' && status.via === 'address' && status.address ? (
        <>
          This request came from <Mono>{status.address}</Mono> on your tailnet. {loginNote}
        </>
      ) : (
        loginNote
      )
    return (
      <Callout variant="ok" icon={IconShieldCheck} title={protectedTitle(status)}>
        <Body>{detail}</Body>
      </Callout>
    )
  }

  if (status?.state === 'public' && loginOn) {
    return (
      <Callout variant="warn" icon={IconLock} title="Reachable from the internet, behind the login">
        <Body>
          This request came from <Mono>{status.address}</Mono>, a public address. The built in login
          stands between it and your findings. Tailscale or Cloudflare Access in front would keep
          the login page itself private too.
        </Body>
      </Callout>
    )
  }

  if (status?.state === 'public') {
    return (
      <Callout variant="danger" icon={IconWorld} title="Hinomi is reachable from the internet">
        <Body>
          This request came from <Mono>{status.address}</Mono>, a public address, with no Tailscale
          or Cloudflare Access in front. Anyone can read your findings and change these settings.
          Stop publishing the port on a public interface and put Hinomi behind Tailscale or
          Cloudflare Access.
        </Body>
      </Callout>
    )
  }

  if (status?.state === 'cloudflare_access') {
    return (
      <Callout variant="warn" icon={IconLock} title="Cloudflare Access header seen, not verified">
        <Body>
          {status.unverifiedReason === 'certs_unavailable' ? (
            <>Hinomi could not read the Access signing keys, so it could not check the token.</>
          ) : (
            <>
              Set <Mono>HINOMI_CF_ACCESS_TEAM_DOMAIN</Mono> and <Mono>HINOMI_CF_ACCESS_AUD</Mono> so
              Hinomi can verify the token. Until then anyone could send this header.
            </>
          )}
        </Body>
      </Callout>
    )
  }

  const detail = status?.state === 'unknown' ? unknownDetail(status) : null
  if (loginOn) {
    return (
      <Callout variant="ok" icon={IconShieldCheck} title="Protected by the built in login">
        <Body>
          {detail ? <>{detail} </> : null}
          Every request needs a session, whatever network it comes from.
        </Body>
      </Callout>
    )
  }
  return (
    <Callout variant="warn" icon={IconLock} title={title}>
      <Body>
        {detail ? <>{detail} </> : null}
        Anyone who can reach this address can read your findings and change these settings. Run
        Hinomi behind Tailscale or Cloudflare Access, or turn on the built in login, and do not
        publish its port on a public interface otherwise.
      </Body>
    </Callout>
  )
}
