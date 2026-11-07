import { parseVolumeSpec, type ContainerMount, type ContainerMountType } from './docker-mount.js'
import { tokenizeShellLine } from './shell-line.js'

/** What a Coolify `custom_docker_run_options` line says about the container. */
export interface DockerRunOptions {
  /** The value of the last `--user` / `-u`, or null when none is given. */
  user: string | null
  mounts: ContainerMount[]
  /** Networks named by `--network` / `--net`, in order (`host` and `none` included). */
  networks: string[]
  privileged: boolean
}

/** Splits `--flag=value`, `-fvalue` and `--flag value` forms; null when the token is not that flag. */
function flagValue(
  token: string,
  next: string | undefined,
  names: readonly string[],
): { value: string; consumed: number } | null {
  for (const name of names) {
    if (token === name) return next === undefined ? null : { value: next, consumed: 1 }
    if (name.startsWith('--') && token.startsWith(`${name}=`)) {
      return { value: token.slice(name.length + 1), consumed: 0 }
    }
    if (!name.startsWith('--') && token.startsWith(name) && token.length > name.length) {
      // `-u1000` and `-v/a:/b`; `-u=1000` is not valid shell option syntax for docker but harmless.
      return { value: token.slice(name.length).replace(/^=/, ''), consumed: 0 }
    }
  }
  return null
}

/** Splits a `--mount` value on commas, honouring double quotes around a field. */
function splitMountFields(value: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false
  for (const char of value) {
    if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) {
      fields.push(current)
      current = ''
    } else current += char
  }
  fields.push(current)
  return fields
}

/** Parses `type=bind,source=/a,target=/b,readonly` (`src`, `dst`, `destination`, `ro` accepted). */
export function parseMountOption(value: string): ContainerMount {
  const mount: ContainerMount = { type: 'volume', source: null, target: null, readOnly: false }
  for (const field of splitMountFields(value)) {
    const eq = field.indexOf('=')
    const key = (eq === -1 ? field : field.slice(0, eq)).trim().toLowerCase()
    const val = eq === -1 ? '' : field.slice(eq + 1).trim()
    if (key === 'type') {
      const type: ContainerMountType =
        val === 'bind' || val === 'volume' || val === 'tmpfs' ? val : 'other'
      mount.type = type
    } else if (key === 'source' || key === 'src') mount.source = val || null
    else if (key === 'target' || key === 'destination' || key === 'dst') mount.target = val || null
    else if (key === 'readonly' || key === 'ro' || key === 'read-only') {
      mount.readOnly = eq === -1 || val === '' || val === 'true' || val === '1'
    }
  }
  return mount
}

/**
 * Reads the options a platform passes to `docker run`: `--user` / `-u`, `-v` / `--volume`,
 * `--mount`, `--network` / `--net` and `--privileged`. Flags it does not know are skipped.
 * Quotes follow shell rules, and for repeated `--user` the last one wins like Docker's.
 */
export function parseDockerRunOptions(line: string): DockerRunOptions {
  const tokens = tokenizeShellLine(line)
  const result: DockerRunOptions = { user: null, mounts: [], networks: [], privileged: false }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    const next = tokens[i + 1]

    if (token === '--privileged' || token === '--privileged=true') {
      result.privileged = true
      continue
    }
    const user = flagValue(token, next, ['--user', '-u'])
    if (user) {
      result.user = user.value
      i += user.consumed
      continue
    }
    const volume = flagValue(token, next, ['--volume', '-v'])
    if (volume) {
      result.mounts.push(parseVolumeSpec(volume.value))
      i += volume.consumed
      continue
    }
    const mount = flagValue(token, next, ['--mount'])
    if (mount) {
      result.mounts.push(parseMountOption(mount.value))
      i += mount.consumed
      continue
    }
    const network = flagValue(token, next, ['--network', '--net'])
    if (network) {
      result.networks.push(network.value)
      i += network.consumed
    }
  }
  return result
}
