import { BlockList, isIP } from 'node:net'

// Whether an address is on the public internet. Hinomi sits on a private network next to
// databases, admin panels and cloud metadata endpoints; every outbound call to a host a user or a
// remote server named checks the addresses it resolves to with this (the webhook runner, the
// registry SBOM reader).

/** Ranges that are not on the public internet (RFC 6890 and friends). */
const NOT_PUBLIC = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // this network, unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier grade NAT (also Tailscale)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo: carries an obfuscated IPv4 address
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['fec0::', 10], // site local (deprecated, still routed privately)
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6')
}

/** The 16 bytes of an IPv6 address (zone id dropped), or null when it does not parse. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.split('%')[0] ?? ''
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (tail?.[1]) {
    const parts = tail[1].split('.').map(Number)
    if (parts.some((n) => n > 255)) return null
    const [a = 0, b = 0, c = 0, d = 0] = parts
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const words = (part: string | undefined) => (part ? part.split(':') : [])
  const head = words(halves[0])
  const rest = words(halves[1])
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  const all = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...rest]
  if (all.length !== 8 || all.some((w) => !/^[0-9a-f]{1,4}$/i.test(w))) return null
  return all.flatMap((w) => {
    const n = parseInt(w, 16)
    return [n >> 8, n & 255]
  })
}

const zero = (bytes: number[], from: number, to: number) =>
  bytes.slice(from, to).every((b) => b === 0)

/**
 * The IPv4 address an IPv6 address carries, or null: IPv4 mapped (`::ffff:0:0/96`), IPv4
 * compatible (`::/96`), IPv4 translated (`::ffff:0:0:0/96`), NAT64 (`64:ff9b::/96`) and 6to4
 * (`2002::/16`). Each one reaches that IPv4 address, so it is classified as that address.
 */
function embeddedIpv4(address: string): string | null {
  const bytes = ipv6Bytes(address)
  if (!bytes) return null
  const v4 = (at: number) => bytes.slice(at, at + 4).join('.')
  const word = (at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
  if (zero(bytes, 0, 10) && word(10) === 0xffff) return v4(12)
  if (zero(bytes, 0, 12)) return v4(12)
  if (zero(bytes, 0, 8) && word(8) === 0xffff && word(10) === 0) return v4(12)
  if (word(0) === 0x64 && word(2) === 0xff9b && zero(bytes, 4, 12)) return v4(12)
  if (word(0) === 0x2002) return v4(2)
  return null
}

/** True when the address is a public unicast address. Anything unparsable is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NOT_PUBLIC.check(address, 'ipv4')
  if (family !== 6) return false
  if (NOT_PUBLIC.check(address, 'ipv6')) return false
  const v4 = embeddedIpv4(address)
  return v4 ? isPublicAddress(v4) : true
}
