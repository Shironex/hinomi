import type { AccessStatus } from '@hinomi/shared'
import type { CfAccessVerifier } from './cf-access.js'
import { isLoopback, isPrivate, isTailscale, parseIp, type ParsedIp } from './ip.js'

/** What detection reads from one request. Header names are matched case insensitively. */
export interface AccessRequest {
  /** The TCP peer address of the socket (getConnInfo), never a header. */
  remoteAddress: string | undefined
  header(name: string): string | undefined
}

export interface AccessOptions {
  /**
   * Peers whose X-Forwarded-For, CF-Connecting-IP and Tailscale identity headers are
   * believed (HINOMI_TRUSTED_PROXIES). Without it every forwarded header is ignored.
   */
  isTrustedProxy?: (ip: ParsedIp) => boolean
  /** Set when HINOMI_CF_ACCESS_TEAM_DOMAIN and HINOMI_CF_ACCESS_AUD are. */
  cfAccess?: CfAccessVerifier
}

interface ClientAddress {
  ip: ParsedIp | null
  forwarded: boolean
  /** The peer is loopback or a trusted proxy, so headers it adds can be believed. */
  trustedPeer: boolean
}

/**
 * The client address: the socket peer, unless the peer is a trusted proxy. Then the
 * right most X-Forwarded-For entry that is not itself a trusted proxy (entries further
 * left were written by the client and can be anything), or else CF-Connecting-IP.
 */
export function clientAddress(req: AccessRequest, options: AccessOptions): ClientAddress {
  const peer = parseIp(req.remoteAddress)
  const trusted = options.isTrustedProxy
  if (!peer || !trusted?.(peer)) {
    return { ip: peer, forwarded: false, trustedPeer: peer !== null && isLoopback(peer) }
  }
  const chain = (req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => parseIp(entry))
    .filter((ip): ip is ParsedIp => ip !== null)
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i] as ParsedIp
    if (!trusted(hop) || i === 0) return { ip: hop, forwarded: true, trustedPeer: true }
  }
  const cf = parseIp(req.header('cf-connecting-ip'))
  if (cf) return { ip: cf, forwarded: true, trustedPeer: true }
  return { ip: peer, forwarded: false, trustedPeer: true }
}

/**
 * Decodes RFC 2047 "Q" encoded words, which `tailscale serve` uses for non ASCII
 * values (`=?utf-8?q?Ferris_B=C3=BCller?=`). Anything else is returned as is.
 */
export function decodeHeaderWord(value: string): string {
  const match = /^=\?utf-8\?q\?(.*)\?=$/i.exec(value.trim())
  if (!match?.[1]) return value.trim()
  const bytes: number[] = []
  const text = match[1]
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    const hex = text.slice(i + 1, i + 3)
    if (ch === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      i += 2
    } else {
      bytes.push(...Buffer.from(ch === '_' ? ' ' : ch, 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Works out how this request reached Hinomi. In order:
 * 1. A Cloudflare Access token that verifies.
 * 2. Tailscale: identity headers from `tailscale serve` (only from loopback or a trusted
 *    proxy, since anyone can send them), or a client address in a Tailscale range.
 * 3. A Cloudflare Access token that could not be checked (no team domain and audience
 *    set, or the certs could not be read). A token that fails the check is ignored.
 * 4. A public client address.
 * 5. Unknown: loopback, a private or bridge address, or no address.
 */
export async function detectAccess(
  req: AccessRequest,
  options: AccessOptions = {},
): Promise<AccessStatus> {
  const client = clientAddress(req, options)
  const base = { address: client.ip?.address ?? null, forwarded: client.forwarded }

  const token = req.header('cf-access-jwt-assertion')?.trim()
  let cfUnverified: 'not_configured' | 'certs_unavailable' | null = null
  if (token) {
    if (!options.cfAccess) {
      cfUnverified = 'not_configured'
    } else {
      const result = await options.cfAccess.verify(token)
      if (result.status === 'valid') {
        return {
          state: 'cloudflare_access',
          ...base,
          verified: true,
          unverifiedReason: null,
          email: result.email,
        }
      }
      if (result.status === 'unavailable') cfUnverified = 'certs_unavailable'
    }
  }

  const loginHeader = client.trustedPeer ? req.header('tailscale-user-login') : undefined
  const login = loginHeader ? decodeHeaderWord(loginHeader) || null : null
  if (login) return { state: 'tailscale', ...base, via: 'serve', login }
  if (client.ip && isTailscale(client.ip)) {
    return { state: 'tailscale', ...base, via: 'address', login: null }
  }

  if (cfUnverified) {
    return {
      state: 'cloudflare_access',
      ...base,
      verified: false,
      unverifiedReason: cfUnverified,
      email: null,
    }
  }

  if (!client.ip) return { state: 'unknown', ...base, reason: 'no_address' }
  if (isLoopback(client.ip)) return { state: 'unknown', ...base, reason: 'loopback' }
  if (isPrivate(client.ip)) return { state: 'unknown', ...base, reason: 'private_address' }
  return { state: 'public', ...base, address: client.ip.address }
}
