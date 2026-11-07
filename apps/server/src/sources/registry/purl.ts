// Package URLs from an SBOM (`pkg:deb/debian/libc6@2.36-9?distro=debian-12&upstream=glibc`)
// turned into OSV queries. The text is untrusted: lengths are capped, qualifiers go into a Map,
// and anything that does not name a type, a name and a version is dropped.

const MAX_PURL_LENGTH = 1000
const MAX_QUALIFIERS = 20

export interface Purl {
  /** Lowercased purl type (`npm`, `deb`, `apk`, `golang`, ...). */
  type: string
  /** Namespace segments, percent decoded (`debian`, `@angular`, `github.com/x`). */
  namespace: string[]
  name: string
  version: string
  /** Lowercased keys, decoded values. */
  qualifiers: ReadonlyMap<string, string>
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** Parses a purl; null when it is not a purl with a type, a name and a version. */
export function parsePurl(raw: string): Purl | null {
  if (raw.length > MAX_PURL_LENGTH || !raw.toLowerCase().startsWith('pkg:')) return null
  let rest = raw.slice(4)
  const hash = rest.indexOf('#')
  if (hash !== -1) rest = rest.slice(0, hash)
  const qualifiers = new Map<string, string>()
  const question = rest.indexOf('?')
  if (question !== -1) {
    const pairs = rest.slice(question + 1).split('&')
    rest = rest.slice(0, question)
    for (const pair of pairs.slice(0, MAX_QUALIFIERS)) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const value = decode(pair.slice(eq + 1))
      if (value !== null) qualifiers.set(pair.slice(0, eq).toLowerCase(), value)
    }
  }
  rest = rest.replace(/^\/+/, '')
  const at = rest.lastIndexOf('@')
  if (at <= 0) return null
  const version = decode(rest.slice(at + 1))
  const segments = rest.slice(0, at).split('/').map(decode)
  if (!version || segments.length < 2 || segments.some((s) => !s)) return null
  const [type, ...path] = segments as string[]
  return {
    type: type!.toLowerCase(),
    namespace: path.slice(0, -1),
    name: path[path.length - 1]!,
    version,
    qualifiers,
  }
}

/** One package to ask OSV about. */
export interface ImagePackage {
  /** The OSV ecosystem (`Debian:12`, `Alpine:v3.20`, `npm`, `Go`, ...). */
  ecosystem: string
  /** The name OSV knows it by: the source package for distributions. */
  name: string
  version: string
  /** The purl type (`deb`, `apk`, `npm`, `golang`, ...), shown on the finding. */
  packageType: string
  /**
   * The ecosystem stored on the advisory: OS packages keep the package type (`deb`, `apk`, `rpm`),
   * as Coolify results do; language packages use Hinomi's names (`npm`, `Go`, `rust`).
   */
  storedEcosystem: string
  /** Whether the version can be checked locally against the record (language ecosystems). */
  localCheck: boolean
}

/** Language purl types to OSV ecosystem, stored ecosystem and whether the local check applies. */
const LANGUAGES: ReadonlyMap<string, { osv: string; stored: string; local: boolean }> = new Map([
  ['npm', { osv: 'npm', stored: 'npm', local: true }],
  ['pypi', { osv: 'PyPI', stored: 'PyPI', local: true }],
  ['golang', { osv: 'Go', stored: 'Go', local: true }],
  ['cargo', { osv: 'crates.io', stored: 'rust', local: true }],
  ['gem', { osv: 'RubyGems', stored: 'RubyGems', local: true }],
  ['composer', { osv: 'Packagist', stored: 'Packagist', local: true }],
  ['maven', { osv: 'Maven', stored: 'Maven', local: false }],
  ['nuget', { osv: 'NuGet', stored: 'NuGet', local: false }],
  ['pub', { osv: 'Pub', stored: 'Pub', local: false }],
  ['hex', { osv: 'Hex', stored: 'Hex', local: false }],
])

const DEBIAN_CODENAMES: ReadonlyMap<string, string> = new Map([
  ['buster', '10'],
  ['bullseye', '11'],
  ['bookworm', '12'],
  ['trixie', '13'],
  ['forky', '14'],
])

/**
 * The distribution and its version from the qualifiers: `distro=debian-12` (Syft),
 * `os_name=debian&os_version=12` (Docker Scout), or a Debian code name (`distro=bookworm`).
 */
function distroOf(purl: Purl): { name: string; version: string } | null {
  const q = purl.qualifiers
  const osName = q.get('os_name')?.toLowerCase()
  const osVersion = q.get('os_version')
  if (osName && osVersion) return { name: osName, version: osVersion }
  const distro = q.get('distro')?.toLowerCase()
  if (distro) {
    const dash = distro.lastIndexOf('-')
    if (dash > 0) return { name: distro.slice(0, dash), version: distro.slice(dash + 1) }
  }
  const codename = DEBIAN_CODENAMES.get(distro ?? q.get('os_distro')?.toLowerCase() ?? '')
  return codename ? { name: 'debian', version: codename } : null
}

const NUMERIC = /^\d+(\.\d+)*$/

/** The OSV ecosystem of an OS package's distribution, or null when OSV has none Hinomi names. */
function osEcosystem(type: string, namespace: string, purl: Purl): string | null {
  const distro = distroOf(purl)
  const name = (distro?.name ?? namespace).toLowerCase()
  const version = distro?.version ?? ''
  if (type === 'apk' && name === 'wolfi') return 'Wolfi'
  if (type === 'apk' && name === 'chainguard') return 'Chainguard'
  if (!NUMERIC.test(version)) return null
  const [major, minor] = version.split('.')
  if (type === 'deb' && name === 'debian') return `Debian:${major}`
  if (type === 'deb' && name === 'ubuntu' && minor) {
    // LTS releases are the April ones of even years (22.04, 24.04).
    const lts = Number(major) % 2 === 0 && minor === '04'
    return `Ubuntu:${major}.${minor}${lts ? ':LTS' : ''}`
  }
  if (type === 'apk' && name === 'alpine' && minor) return `Alpine:v${major}.${minor}`
  if (type === 'rpm' && name === 'rocky') return `Rocky Linux:${major}`
  if (type === 'rpm' && name === 'almalinux') return `AlmaLinux:${major}`
  return null
}

/**
 * The OSV query of a purl, or null when OSV cannot match it (an unknown type, an OS package
 * without its distribution release). Distributions publish advisories under the source package
 * (`glibc`, not `libc6`): the `upstream` qualifier names it when the SBOM tool recorded it.
 */
export function imagePackageOf(purl: Purl): ImagePackage | null {
  const language = LANGUAGES.get(purl.type)
  if (language) {
    let name = [...purl.namespace, purl.name].join(purl.type === 'maven' ? ':' : '/')
    let version = purl.version
    if (purl.type === 'golang') {
      version = version.replace(/^v/, '')
      if (name === 'stdlib') version = version.replace(/^go/, '')
    }
    if (purl.type === 'pypi') name = name.toLowerCase()
    return {
      ecosystem: language.osv,
      name,
      version,
      packageType: purl.type,
      storedEcosystem: language.stored,
      localCheck: language.local,
    }
  }
  if (purl.type !== 'deb' && purl.type !== 'apk' && purl.type !== 'rpm') return null
  const ecosystem = osEcosystem(purl.type, purl.namespace[0] ?? '', purl)
  if (!ecosystem) return null
  const upstream = purl.qualifiers.get('upstream')?.trim()
  let name = purl.name
  let version = purl.version
  if (upstream) {
    // `upstream=systemd` or, when the source version differs, `upstream=systemd@252.22-1`.
    const at = upstream.indexOf('@')
    name = at === -1 ? upstream : upstream.slice(0, at)
    if (at !== -1 && upstream.slice(at + 1)) version = upstream.slice(at + 1)
    // Syft writes `upstream=glibc (2.36-9)` for some deb packages.
    const paren = /^(\S+) \(([^)]+)\)$/.exec(upstream)
    if (paren) {
      name = paren[1]!
      version = paren[2]!
    }
  }
  if (!name) return null
  return {
    ecosystem,
    name,
    version,
    packageType: purl.type,
    storedEcosystem: purl.type,
    localCheck: false,
  }
}
