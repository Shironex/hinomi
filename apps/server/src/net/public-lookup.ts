import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { isPublicAddress } from './public-address.js'

// A dns.lookup for outbound requests to a host a user named. It runs inside the connection's own
// lookup, so a host cannot resolve to a public address for a check and to a private one for the
// request (DNS rebinding). Used by the webhook runner and the notification channels.

/** An error whose message is safe to show and store: it names the host, never a secret. */
function refusedAddress(hostname: string, address: string): Error {
  return Object.assign(
    new Error(
      `${hostname} resolves to ${address}, which is not a public address. Allow private addresses to use it.`,
    ),
    { code: 'ENOTPUBLIC' },
  )
}

/** dns.lookup that refuses names resolving to any address that is not public. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 4)
      return
    }
    const bad = addresses.find((entry) => !isPublicAddress(entry.address))
    const first = addresses[0]
    if (bad || !first) {
      callback(refusedAddress(hostname, bad?.address ?? 'nothing'), '', 4)
      return
    }
    if (options.all) {
      ;(callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses)
      return
    }
    callback(null, first.address, first.family)
  })
}
