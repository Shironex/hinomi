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
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6')
}

/** The IPv4 address an IPv4 mapped or compatible IPv6 address carries, or null. */
function embeddedIpv4(address: string): string | null {
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped?.[1]) return mapped[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (!hex?.[1] || !hex[2]) return null
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

/** True when the address is a public unicast address. Anything unparsable is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NOT_PUBLIC.check(address, 'ipv4')
  if (family !== 6) return false
  const v4 = embeddedIpv4(address)
  if (v4) return isPublicAddress(v4)
  return !NOT_PUBLIC.check(address, 'ipv6')
}
