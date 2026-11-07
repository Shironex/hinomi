import { createHash } from 'node:crypto'
import { MANIFEST_MEDIA_TYPES } from './client.js'

// Test helpers: a fake OCI registry with the shapes ghcr.io and Docker Hub answer with (an image
// index with BuildKit attestation manifests, in-toto statements with an SPDX predicate, a pull
// token service, blobs redirected to a CDN host). Fictional images only: ghcr.io/kestrel-co/*.
// Bodies are built here rather than stored as files so their digests always match.

export const FAKE_TOKEN = 'registry-token-fictional-0001'
export const CDN_HOST = 'blobs.cdn.example.dev'
/** A public address the fake CDN host resolves to. */
export const CDN_ADDRESS = '20.0.0.1'

/** The URL of a fetch input, whatever form it takes. */
export const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

export const digestOf = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8')

export interface FakeBlob {
  bytes: Buffer
  digest: string
  mediaType: string
}

function blob(value: unknown, mediaType: string): FakeBlob {
  const bytes = Buffer.isBuffer(value) ? value : json(value)
  return { bytes, digest: digestOf(bytes), mediaType }
}

const descriptor = (b: FakeBlob, extra: Record<string, unknown> = {}) => ({
  mediaType: b.mediaType,
  digest: b.digest,
  size: b.bytes.length,
  ...extra,
})

/** The SPDX packages of the fictional edge-api image (Alpine 3.20 with a Go binary). */
export const EDGE_API_SPDX_PACKAGES: unknown[] = [
  { name: 'sbom', SPDXID: 'SPDXRef-DocumentRoot' },
  {
    name: 'libcrypto3',
    versionInfo: '3.3.1-r0',
    externalRefs: [
      {
        referenceCategory: 'SECURITY',
        referenceType: 'cpe23Type',
        referenceLocator: 'cpe:2.3:a:libcrypto3:libcrypto3:3.3.1-r0:*:*:*:*:*:*:*',
      },
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator:
          'pkg:apk/alpine/libcrypto3@3.3.1-r0?arch=x86_64&distro=alpine-3.20.2&upstream=openssl',
      },
    ],
  },
  {
    name: 'libssl3',
    versionInfo: '3.3.1-r0',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator:
          'pkg:apk/alpine/libssl3@3.3.1-r0?arch=x86_64&distro=alpine-3.20.2&upstream=openssl',
      },
    ],
  },
  {
    name: 'musl',
    versionInfo: '1.2.5-r0',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: 'pkg:apk/alpine/musl@1.2.5-r0?arch=x86_64&distro=alpine-3.20.2',
      },
    ],
  },
  {
    name: 'golang.org/x/net',
    versionInfo: 'v0.20.0',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: 'pkg:golang/golang.org/x/net@v0.20.0',
      },
    ],
  },
  {
    name: 'github.com/kestrel-co/edge-router',
    versionInfo: 'v1.4.0',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: 'pkg:golang/github.com/kestrel-co/edge-router@v1.4.0',
      },
    ],
  },
  {
    name: 'composer',
    versionInfo: '2.7.0',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: 'pkg:generic/composer@2.7.0',
      },
    ],
  },
]

export interface FakeImageOptions {
  /** SPDX packages of the amd64 image; null: its attestation carries provenance only. */
  spdxPackages?: unknown[] | null
  /** Serve a single image manifest instead of an index. */
  singleManifest?: boolean
  /** Wrap the SBOM statement in a DSSE envelope. */
  dsse?: boolean
  /** A statement about another image than the amd64 one. */
  wrongSubject?: boolean
}

export interface FakeImage {
  repository: string
  tag: string
  indexDigest: string
  amd64Digest: string
  /** Everything the registry serves by digest. */
  blobs: Map<string, FakeBlob>
  top: FakeBlob
}

/** Builds the manifests and blobs of one fictional image. */
export function fakeImage(
  repository: string,
  tag: string,
  options: FakeImageOptions = {},
): FakeImage {
  const blobs = new Map<string, FakeBlob>()
  const add = (b: FakeBlob) => {
    blobs.set(b.digest, b)
    return b
  }
  const config = add(
    blob({ architecture: 'amd64', os: 'linux' }, 'application/vnd.oci.image.config.v1+json'),
  )
  const layer = add(
    blob(Buffer.from(`layer of ${repository}`), 'application/vnd.oci.image.layer.v1.tar+gzip'),
  )
  const image = (arch: string) =>
    add(
      blob(
        {
          schemaVersion: 2,
          mediaType: MANIFEST_MEDIA_TYPES.ociManifest,
          config: descriptor(config),
          layers: [descriptor(layer)],
          annotations: {
            'org.opencontainers.image.source': `https://github.com/${repository}`,
            arch,
          },
        },
        MANIFEST_MEDIA_TYPES.ociManifest,
      ),
    )
  const amd64 = image('amd64')
  const arm64 = image('arm64')
  if (options.singleManifest) {
    return {
      repository,
      tag,
      indexDigest: amd64.digest,
      amd64Digest: amd64.digest,
      blobs,
      top: amd64,
    }
  }
  const statement = (subject: FakeBlob, predicateType: string, predicate: unknown) => ({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: `pkg:docker/${repository}@${tag}?platform=linux%2Famd64`,
        digest: {
          sha256: options.wrongSubject ? 'f'.repeat(64) : subject.digest.slice('sha256:'.length),
        },
      },
    ],
    predicateType,
    predicate,
  })
  const provenance = (subject: FakeBlob) =>
    add(
      blob(
        statement(subject, 'https://slsa.dev/provenance/v1', {
          buildDefinition: { buildType: 'https://mobyproject.org/buildkit@v1' },
        }),
        'application/vnd.in-toto+json',
      ),
    )
  const attestation = (subject: FakeBlob, layers: FakeBlob[]) =>
    add(
      blob(
        {
          schemaVersion: 2,
          mediaType: MANIFEST_MEDIA_TYPES.ociManifest,
          config: descriptor(config),
          layers: layers.map((l) =>
            descriptor(l, {
              annotations: {
                'in-toto.io/predicate-type':
                  (
                    JSON.parse(l.bytes.toString()) as {
                      predicateType?: string
                    }
                  ).predicateType ?? 'https://spdx.dev/Document',
              },
            }),
          ),
        },
        MANIFEST_MEDIA_TYPES.ociManifest,
      ),
    )
  const packages =
    options.spdxPackages === undefined ? EDGE_API_SPDX_PACKAGES : options.spdxPackages
  const amd64Layers = [provenance(amd64)]
  if (packages) {
    const sbom = statement(amd64, 'https://spdx.dev/Document', {
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: `sbom-${repository}`,
      creationInfo: { creators: ['Organization: Anchore, Inc', 'Tool: syft-v1.0.0'] },
      packages,
    })
    const body = options.dsse
      ? {
          payloadType: 'application/vnd.in-toto+json',
          payload: json(sbom).toString('base64'),
          signatures: [],
        }
      : sbom
    // A DSSE envelope has no predicateType at the top: the annotation falls back to SPDX.
    amd64Layers.unshift(add(blob(body, 'application/vnd.in-toto+json')))
  }
  const attestAmd64 = attestation(amd64, amd64Layers)
  const attestArm64 = attestation(arm64, [provenance(arm64)])
  const reference = (target: FakeBlob) => ({
    'vnd.docker.reference.digest': target.digest,
    'vnd.docker.reference.type': 'attestation-manifest',
  })
  const unknown = { architecture: 'unknown', os: 'unknown' }
  const top = add(
    blob(
      {
        schemaVersion: 2,
        mediaType: MANIFEST_MEDIA_TYPES.ociIndex,
        manifests: [
          descriptor(amd64, { platform: { architecture: 'amd64', os: 'linux' } }),
          descriptor(attestAmd64, { platform: unknown, annotations: reference(amd64) }),
          descriptor(arm64, { platform: { architecture: 'arm64', os: 'linux' } }),
          descriptor(attestArm64, { platform: unknown, annotations: reference(arm64) }),
        ],
      },
      MANIFEST_MEDIA_TYPES.ociIndex,
    ),
  )
  return { repository, tag, indexDigest: top.digest, amd64Digest: amd64.digest, blobs, top }
}

export interface FakeRegistry {
  fetch: typeof fetch
  lookup: (hostname: string) => Promise<string[]>
  /** `METHOD url` of every request, the token service and CDN included. */
  requests: string[]
  /** Authorization headers sent to the CDN host (must stay empty). */
  cdnAuthorization: string[]
  images: Map<string, FakeImage>
}

/**
 * A registry on `host` that wants an anonymous pull token (ghcr.io style: realm on the same host)
 * and redirects blob reads to a CDN host. Unknown repositories answer 404.
 */
export function fakeRegistry(
  host: string,
  images: FakeImage[],
  options: { redirectBlobs?: boolean } = {},
): FakeRegistry {
  const byRepo = new Map(images.map((i) => [i.repository, i]))
  const requests: string[] = []
  const cdnAuthorization: string[] = []
  const answer = (
    status: number,
    body: Buffer | string | null,
    headers: Record<string, string> = {},
  ) => new Response(body, { status, headers })

  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(urlOf(input))
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${url.origin}${url.pathname}`)
    const headers = new Headers(init?.headers)
    if (url.host === CDN_HOST) {
      const auth = headers.get('authorization')
      if (auth) cdnAuthorization.push(auth)
      const digest = url.pathname.split('/').pop() ?? ''
      for (const image of images) {
        const b = image.blobs.get(digest)
        if (b)
          return Promise.resolve(answer(200, b.bytes, { 'content-length': String(b.bytes.length) }))
      }
      return Promise.resolve(answer(404, null))
    }
    if (url.host !== host) return Promise.reject(new Error(`unexpected host ${url.host}`))
    if (url.pathname === '/token') {
      return Promise.resolve(answer(200, JSON.stringify({ token: FAKE_TOKEN, expires_in: 300 })))
    }
    const match = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url.pathname)
    if (!match) return Promise.resolve(answer(404, null))
    const [, repository, kind, reference] = match as unknown as [string, string, string, string]
    if (headers.get('authorization') !== `Bearer ${FAKE_TOKEN}`) {
      return Promise.resolve(
        answer(401, '{"errors":[{"code":"UNAUTHORIZED"}]}', {
          'www-authenticate': `Bearer realm="https://${host}/token",service="${host}",scope="repository:${repository}:pull"`,
        }),
      )
    }
    const image = byRepo.get(repository)
    if (!image) return Promise.resolve(answer(404, '{"errors":[{"code":"NAME_UNKNOWN"}]}'))
    if (kind === 'blobs' && options.redirectBlobs === false) {
      const b = image.blobs.get(decodeURIComponent(reference))
      return Promise.resolve(b ? answer(200, b.bytes) : answer(404, null))
    }
    if (kind === 'blobs') {
      return Promise.resolve(
        answer(307, null, {
          location: `https://${CDN_HOST}/blobs/${decodeURIComponent(reference)}`,
        }),
      )
    }
    const ref = decodeURIComponent(reference)
    const b = ref === image.tag ? image.top : image.blobs.get(ref)
    if (!b) return Promise.resolve(answer(404, '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}'))
    const meta = { 'content-type': b.mediaType, 'docker-content-digest': b.digest }
    return Promise.resolve(answer(200, method === 'HEAD' ? null : b.bytes, meta))
  }

  return {
    fetch: fakeFetch,
    lookup: (hostname) =>
      hostname === CDN_HOST ? Promise.resolve([CDN_ADDRESS]) : Promise.resolve(['10.0.0.9']),
    requests,
    cdnAuthorization,
    images: byRepo,
  }
}
