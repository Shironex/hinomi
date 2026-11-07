import type { LockfileDependency } from '@hinomi/shared'
import { dedupeDependencies } from './graph.js'

interface Replacement {
  /** New module path and version, or null for a local directory (skipped). */
  to: { path: string; version: string } | null
}

/** Splits a directive line into tokens: quoted strings (`"` or backtick) stay whole. */
function tokenize(line: string): { tokens: string[]; indirect: boolean } {
  const tokens: string[] = []
  let indirect = false
  let i = 0
  while (i < line.length) {
    const ch = line[i]!
    if (ch === ' ' || ch === '\t') {
      i++
    } else if (ch === '/' && line[i + 1] === '/') {
      indirect = /^\s*indirect\b/.test(line.slice(i + 2))
      break
    } else if (ch === '"' || ch === '`') {
      const end = line.indexOf(ch, i + 1)
      const stop = end === -1 ? line.length : end
      tokens.push(line.slice(i + 1, stop))
      i = stop + 1
    } else {
      let j = i
      while (j < line.length && line[j] !== ' ' && line[j] !== '\t') {
        if (line[j] === '/' && line[j + 1] === '/') break
        j++
      }
      tokens.push(line.slice(i, j))
      i = j
    }
  }
  return { tokens, indirect }
}

/** OSV's Go versions are semver without the leading `v`; pseudo-versions and `+incompatible` stay. */
const osvVersion = (version: string) => version.replace(/^v/, '')

/**
 * The `go` and `toolchain` lines name releases like `1.23`, `1.23.4` or `1.24rc1`. OSV's `stdlib`
 * entries use semver, so a missing patch becomes `.0` and a release candidate a prerelease.
 */
function goReleaseVersion(raw: string): string | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:(rc|beta)(\d+))?$/.exec(raw.replace(/^go/, ''))
  if (!match) return null
  const base = `${match[1]}.${match[2]}.${match[3] ?? '0'}`
  return match[4] ? `${base}-${match[4]}${match[5]}` : base
}

const isLocalPath = (path: string) =>
  path.startsWith('./') ||
  path.startsWith('../') ||
  path.startsWith('/') ||
  /^[A-Za-z]:[\\/]/.test(path)

/**
 * go.mod. Since Go 1.17 it lists the selected version of every module the main module's
 * packages need, so no go.sum or graph is read. `// indirect` marks transitive modules; Go has
 * no dev scope so the scope is `unknown`. `replace` swaps the reported module and version (a
 * local directory drops the module), `exclude` drops versions Go would not select, `retract`
 * and unknown directives are ignored. The `toolchain` line, else the `go` line, becomes the
 * runtime dependency `stdlib`.
 */
export function parseGoMod(text: string): LockfileDependency[] {
  const requires: { path: string; version: string; indirect: boolean }[] = []
  const replaces = new Map<string, Replacement>()
  const excluded = new Set<string>()
  let goVersion: string | null = null
  let toolchain: string | null = null

  let block: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '')
    const { tokens, indirect } = tokenize(line)
    if (tokens.length === 0) continue
    let directive: string
    let args: string[]
    if (block) {
      if (tokens[0] === ')') {
        block = null
        continue
      }
      directive = block
      args = tokens
    } else {
      directive = tokens[0]!
      args = tokens.slice(1)
      if (args[0] === '(') {
        block = directive
        continue
      }
    }

    if (directive === 'go') goVersion = args[0] ?? goVersion
    else if (directive === 'toolchain') toolchain = args[0] ?? toolchain
    else if (directive === 'require') {
      const [path, version] = args
      if (path && version) requires.push({ path, version, indirect })
    } else if (directive === 'exclude') {
      const [path, version] = args
      if (path && version) excluded.add(`${path}@${version}`)
    } else if (directive === 'replace') {
      const arrow = args.indexOf('=>')
      if (arrow < 1 || arrow >= args.length - 1) continue
      const [oldPath, oldVersion] = args.slice(0, arrow)
      const [newPath, newVersion] = args.slice(arrow + 1)
      if (!oldPath || !newPath) continue
      const to = !newVersion || isLocalPath(newPath) ? null : { path: newPath, version: newVersion }
      replaces.set(oldVersion ? `${oldPath}@${oldVersion}` : oldPath, { to })
    }
  }

  const out: LockfileDependency[] = []
  for (const req of requires) {
    if (excluded.has(`${req.path}@${req.version}`)) continue
    const replacement = replaces.get(`${req.path}@${req.version}`) ?? replaces.get(req.path)
    let name = req.path
    let version = req.version
    if (replacement) {
      if (!replacement.to) continue
      name = replacement.to.path
      version = replacement.to.version
    }
    out.push({
      name,
      version: osvVersion(version),
      ecosystem: 'Go',
      scope: 'unknown',
      direct: !req.indirect,
      ...(!req.indirect && { path: [name] }),
    })
  }

  const stdlib = goReleaseVersion(toolchain ?? '') ?? goReleaseVersion(goVersion ?? '')
  if (stdlib) {
    out.push({ name: 'stdlib', version: stdlib, ecosystem: 'Go', scope: 'runtime', direct: true })
  }
  return dedupeDependencies(out)
}
