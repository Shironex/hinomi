import { parse } from 'yaml'
import { classifyContainerUser, type ContainerUserKind } from './container-user.js'
import { parseVolumeSpec, type ContainerMount } from './docker-mount.js'
import { parseImageRef, type ImageRef } from './docker-image.js'
import { substituteVariables } from './variable-substitution.js'

export interface ComposeBuild {
  context: string | null
  dockerfile: string | null
  target: string | null
}

export interface ComposeService {
  name: string
  /** `image:` after interpolation, null when absent. */
  image: string | null
  imageRef: ImageRef | null
  build: ComposeBuild | null
  /** `user:` as a string (a numeric `user: 1000` is stringified); null when absent. */
  user: string | null
  /** Null when there is no `user:`, or it holds a variable that did not resolve. */
  userKind: ContainerUserKind | null
  privileged: boolean
  /** `network_mode:` (`host`, `service:db`), or null. */
  networkMode: string | null
  volumes: ContainerMount[]
  /** Keys of the top level networks the service joins; `default` when it names none. */
  networks: string[]
}

export interface ComposeNetwork {
  /** Key under the top level `networks:`. */
  key: string
  /** The real network name: `name:` or the external name, else the key. */
  name: string
  external: boolean
}

export interface ComposeFile {
  services: ComposeService[]
  networks: ComposeNetwork[]
}

export type ComposeParseResult = { ok: true; file: ComposeFile } | { ok: false; error: string }

export interface ComposeOptions {
  /** Values for `${VAR}` interpolation; defaults (`${VAR:-x}`) work without any. */
  env?: Record<string, string | undefined>
}

type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

function interpolate(value: string, env: ComposeOptions['env']): string | null {
  return substituteVariables(value, (name) => env?.[name], 'compose')
}

/** Interpolated text; an unresolved variable keeps the original text and reports `resolved: false`. */
function resolve(value: string, env: ComposeOptions['env']): { text: string; resolved: boolean } {
  const text = interpolate(value, env)
  return text === null ? { text: value, resolved: false } : { text, resolved: true }
}

function readVolume(entry: unknown, env: ComposeOptions['env']): ContainerMount | null {
  if (typeof entry === 'string') return parseVolumeSpec(resolve(entry, env).text)
  if (!isDict(entry)) return null
  const type = asText(entry.type)
  const source = asText(entry.source)
  const target = asText(entry.target)
  return {
    type: type === 'bind' || type === 'volume' || type === 'tmpfs' ? type : 'other',
    source: source === null ? null : resolve(source, env).text,
    target,
    readOnly: entry.read_only === true,
  }
}

function readBuild(value: unknown): ComposeBuild | null {
  if (typeof value === 'string') return { context: value, dockerfile: null, target: null }
  if (!isDict(value)) return null
  return {
    context: asText(value.context),
    dockerfile: asText(value.dockerfile),
    target: asText(value.target),
  }
}

function readNetworks(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (isDict(value)) return Object.keys(value)
  return ['default']
}

function readService(name: string, raw: Dict, env: ComposeOptions['env']): ComposeService {
  const imageText = asText(raw.image)
  const image = imageText === null ? null : resolve(imageText, env).text
  const userText = asText(raw.user)
  const user = userText === null ? null : resolve(userText, env)
  const volumes = Array.isArray(raw.volumes) ? raw.volumes : []
  return {
    name,
    image,
    imageRef: image === null ? null : parseImageRef(image),
    build: readBuild(raw.build),
    user: user?.text ?? null,
    userKind: user?.resolved ? classifyContainerUser(user.text) : null,
    privileged: raw.privileged === true,
    networkMode: asText(raw.network_mode),
    volumes: volumes.flatMap((v) => readVolume(v, env) ?? []),
    networks: readNetworks(raw.networks),
  }
}

function readNetwork(key: string, raw: unknown): ComposeNetwork {
  if (!isDict(raw)) return { key, name: key, external: false }
  const explicit = asText(raw.name)
  const external = raw.external === true || isDict(raw.external)
  const externalName = isDict(raw.external) ? asText(raw.external.name) : null
  return { key, name: externalName ?? explicit ?? key, external }
}

/**
 * Reads the parts of a compose file the guards need: per service the image, build, user,
 * volumes (short and long syntax), network mode and networks, plus the top level networks.
 * Pure: the YAML is parsed with the `yaml` package, nothing else is read. Invalid YAML or a file
 * with no `services:` map is `{ ok: false }`, never a throw.
 */
export function parseCompose(text: string, options: ComposeOptions = {}): ComposeParseResult {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid YAML' }
  }
  if (!isDict(doc) || !isDict(doc.services)) {
    return { ok: false, error: 'the file has no services map' }
  }
  const services = Object.entries(doc.services).flatMap(([name, raw]) =>
    isDict(raw) ? [readService(name, raw, options.env)] : [],
  )
  const networks = isDict(doc.networks)
    ? Object.entries(doc.networks).map(([key, raw]) => readNetwork(key, raw))
    : []
  return { ok: true, file: { services, networks } }
}

/** Names of the external networks a service joins (what links it to other projects). */
export function externalNetworkNames(file: ComposeFile, service: ComposeService): string[] {
  return service.networks.flatMap((key) => {
    const network = file.networks.find((n) => n.key === key)
    return network?.external ? [network.name] : []
  })
}
