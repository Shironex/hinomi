import { isIP } from 'node:net'
import { isPublicAddress } from '../net/public-address.js'

// Where the webhook runner may post. Hinomi sits on a private network next to databases, admin
// panels and cloud metadata endpoints, so a configured URL must not become a way to reach them:
// https only, no credentials in the URL, and every address the host resolves to must be public,
// unless the user explicitly allows private addresses for a runner on the same network.

export { isPublicAddress }

export type RunnerUrlCheck = { ok: true; url: URL } | { ok: false; message: string }

/**
 * Checks a webhook runner URL before anything is sent: https (or http with `allowPrivate`), no
 * user or password, no fragment. A literal IP must be public unless `allowPrivate`; host names
 * are checked when they resolve, at connection time.
 */
export function checkRunnerUrl(raw: string, allowPrivate: boolean): RunnerUrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: 'The webhook runner URL is not a valid URL.' }
  }
  const httpAllowed = allowPrivate && url.protocol === 'http:'
  if (url.protocol !== 'https:' && !httpAllowed) {
    return {
      ok: false,
      message: allowPrivate
        ? 'The webhook runner URL must start with https:// or http://.'
        : 'The webhook runner URL must start with https:// (plain http only with private addresses allowed).',
    }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, message: 'The webhook runner URL must not carry a user name or password.' }
  }
  if (url.hash !== '') {
    return { ok: false, message: 'The webhook runner URL must not have a #fragment.' }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!allowPrivate && isIP(host) !== 0 && !isPublicAddress(host)) {
    return {
      ok: false,
      message: `The webhook runner URL points to ${host}, which is not a public address. Allow private addresses to use it.`,
    }
  }
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost'))) {
    return {
      ok: false,
      message: 'The webhook runner URL points to localhost. Allow private addresses to use it.',
    }
  }
  return { ok: true, url }
}
