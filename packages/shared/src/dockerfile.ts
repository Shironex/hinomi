import { classifyContainerUser } from './container-user.js'
import { hasNonrootTag, parseImageRef, type ImageRef } from './docker-image.js'
import { tokenizeShellLine } from './shell-line.js'
import { substituteVariables } from './variable-substitution.js'

/** One instruction of a Dockerfile, continuations joined, comments and heredoc bodies dropped. */
export interface DockerfileInstruction {
  /** Upper case keyword (`FROM`, `USER`). */
  keyword: string
  args: string
  /** 1 based line the instruction starts on. */
  line: number
}

export interface DockerfileUser {
  /** The value as written. */
  raw: string
  /** The value after variable substitution; null when a variable could not be resolved. */
  value: string | null
  line: number
}

export interface DockerfileStage {
  /** Position among the stages, from 0. */
  index: number
  /** The `AS` alias as written, or null. */
  name: string | null
  /** Line of the `FROM`. */
  line: number
  /** The `FROM` image argument as written, flags and alias removed. */
  from: string
  /** `--platform` value as written, or null. */
  platform: string | null
  /** The external base image; null for `scratch`, a stage reference or an unresolved name. */
  baseImage: ImageRef | null
  /** Index of the earlier stage this one builds on, or null. */
  baseStage: number | null
  /** True for `FROM scratch`. */
  scratch: boolean
  /** True when the `FROM` still has an unresolved variable in it. */
  baseUnresolved: boolean
  /** Every `USER` of this stage in order (not those inside `ONBUILD`). */
  users: DockerfileUser[]
}

export interface ParsedDockerfile {
  stages: DockerfileStage[]
}

export interface DockerfileOptions {
  /** `--build-arg` values; they win over `ARG` defaults. */
  buildArgs?: Record<string, string>
}

type Vars = Map<string, string>

const HEREDOC = /(?<!<)<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(?!<)/g
const HEREDOC_INSTRUCTIONS = new Set(['RUN', 'COPY', 'ADD'])

/** Reads a leading `# escape=` parser directive; directives end at the first other line. */
function readEscape(lines: string[]): string {
  for (const raw of lines) {
    const match = /^\s*#\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(raw)
    if (!match) return '\\'
    if ((match[1] ?? '').toLowerCase() === 'escape') {
      const value = match[2] ?? ''
      return value === '`' ? '`' : '\\'
    }
  }
  return '\\'
}

function endsWithEscape(line: string, escape: string): boolean {
  return line.trimEnd().endsWith(escape)
}

/** Heredoc terminators an instruction opens, in order. */
function heredocs(text: string): { delimiter: string; stripTabs: boolean }[] {
  const found: { delimiter: string; stripTabs: boolean }[] = []
  for (const match of text.matchAll(HEREDOC)) {
    found.push({ delimiter: match[3] ?? '', stripTabs: match[1] === '-' })
  }
  return found
}

/** Splits the file into instructions. */
export function readInstructions(text: string): DockerfileInstruction[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const escape = readEscape(lines)
  const out: DockerfileInstruction[] = []

  for (let i = 0; i < lines.length; i++) {
    const first = lines[i] ?? ''
    if (first.trim() === '' || first.trimStart().startsWith('#')) continue

    const startLine = i + 1
    let joined = first.trimEnd()
    while (endsWithEscape(joined, escape)) {
      joined = joined.slice(0, joined.length - 1).trimEnd()
      // Comments and blank lines inside a continuation are skipped, like Docker does.
      let nextLine: string | undefined
      while (i + 1 < lines.length) {
        i++
        const candidate = lines[i] ?? ''
        if (candidate.trim() !== '' && !candidate.trimStart().startsWith('#')) {
          nextLine = candidate
          break
        }
      }
      if (nextLine === undefined) break
      joined += ' ' + nextLine.trim()
    }
    joined = joined.trim()

    const space = joined.search(/\s/)
    const keyword = (space === -1 ? joined : joined.slice(0, space)).toUpperCase()
    const args = space === -1 ? '' : joined.slice(space).trim()
    out.push({ keyword, args, line: startLine })

    if (HEREDOC_INSTRUCTIONS.has(keyword)) {
      for (const { delimiter, stripTabs } of heredocs(args)) {
        while (i + 1 < lines.length) {
          i++
          const body = lines[i] ?? ''
          if ((stripTabs ? body.replace(/^\t+/, '') : body) === delimiter) break
        }
      }
    }
  }
  return out
}

/** Reads `NAME`, `NAME=value` words of an ARG or ENV line (`ENV NAME value` legacy form too). */
function readAssignments(
  keyword: string,
  args: string,
): { name: string; value: string | undefined }[] {
  const words = tokenizeShellLine(args)
  if (keyword === 'ENV' && words.length >= 2 && !(words[0] ?? '').includes('=')) {
    return [{ name: words[0] ?? '', value: words.slice(1).join(' ') }]
  }
  return words.map((word) => {
    const eq = word.indexOf('=')
    return eq === -1
      ? { name: word, value: undefined }
      : { name: word.slice(0, eq), value: word.slice(eq + 1) }
  })
}

function lookupIn(vars: Vars): (name: string) => string | undefined {
  return (name) => vars.get(name)
}

/** Splits `FROM [--flag=v]... image [AS name]`. */
function readFrom(args: string): { image: string; name: string | null; platform: string | null } {
  const words = tokenizeShellLine(args)
  let platform: string | null = null
  let index = 0
  while ((words[index] ?? '').startsWith('--')) {
    const flag = words[index] ?? ''
    if (flag.startsWith('--platform=')) platform = flag.slice('--platform='.length)
    index++
  }
  const image = words[index] ?? ''
  const hasAlias = (words[index + 1] ?? '').toUpperCase() === 'AS'
  return { image, name: hasAlias ? (words[index + 2] ?? null) : null, platform }
}

function newStage(
  index: number,
  line: number,
  args: string,
  stages: DockerfileStage[],
  globals: Vars,
): DockerfileStage {
  const { image, name, platform } = readFrom(args)
  const resolved = substituteVariables(image, lookupIn(globals), 'dockerfile')
  const stage: DockerfileStage = {
    index,
    name,
    line,
    from: image,
    platform,
    baseImage: null,
    baseStage: null,
    scratch: false,
    baseUnresolved: resolved === null,
    users: [],
  }
  if (resolved === null) return stage
  const lower = resolved.toLowerCase()
  const parent = stages.find((s) => s.name !== null && s.name.toLowerCase() === lower)
  if (parent) stage.baseStage = parent.index
  else if (lower === 'scratch') stage.scratch = true
  else {
    stage.baseImage = parseImageRef(resolved)
    stage.baseUnresolved = stage.baseImage === null
  }
  return stage
}

/**
 * Parses a Dockerfile into stages. `ARG` values before the first `FROM` feed `FROM`; inside a
 * stage, `ARG` and `ENV` feed `USER`. Build args override `ARG` defaults. A variable with no
 * value stays unresolved (null) instead of becoming an empty string.
 */
export function parseDockerfile(text: string, options: DockerfileOptions = {}): ParsedDockerfile {
  const buildArgs = options.buildArgs ?? {}
  const globals: Vars = new Map()
  const stages: DockerfileStage[] = []
  let scope: Vars = new Map()

  for (const { keyword, args, line } of readInstructions(text)) {
    if (keyword === 'FROM') {
      stages.push(newStage(stages.length, line, args, stages, globals))
      scope = new Map()
      continue
    }
    const stage = stages[stages.length - 1]
    if (keyword === 'ARG') {
      for (const { name, value } of readAssignments(keyword, args)) {
        const fallback =
          value === undefined
            ? stage
              ? globals.get(name)
              : undefined
            : (substituteVariables(value, lookupIn(stage ? scope : globals), 'dockerfile') ??
              undefined)
        const resolved = buildArgs[name] ?? fallback
        if (resolved === undefined) (stage ? scope : globals).delete(name)
        else (stage ? scope : globals).set(name, resolved)
      }
    } else if (keyword === 'ENV' && stage) {
      for (const { name, value } of readAssignments(keyword, args)) {
        const resolved =
          value === undefined
            ? undefined
            : substituteVariables(value, lookupIn(scope), 'dockerfile')
        if (resolved === null || resolved === undefined) scope.delete(name)
        else scope.set(name, resolved)
      }
    } else if (keyword === 'USER' && stage) {
      const raw = tokenizeShellLine(args).join(' ')
      stage.users.push({
        raw,
        value: substituteVariables(raw, lookupIn(scope), 'dockerfile'),
        line,
      })
    }
  }
  return { stages }
}

/**
 * The stage a build produces: the one named (or numbered) by `target`, else the last. Null
 * when the file has no stage or the target matches none.
 */
export function selectStage(
  dockerfile: ParsedDockerfile,
  target?: string | null,
): DockerfileStage | null {
  const { stages } = dockerfile
  if (target === undefined || target === null || target === '')
    return stages[stages.length - 1] ?? null
  const lower = target.toLowerCase()
  return (
    stages.find((s) => s.name !== null && s.name.toLowerCase() === lower) ??
    (/^\d+$/.test(target) ? stages[Number(target)] : undefined) ??
    null
  )
}

/** The external image a stage ends up built on, following `FROM <earlier stage>` links. */
export function resolveBaseImage(
  dockerfile: ParsedDockerfile,
  stage: DockerfileStage,
): ImageRef | null {
  let current: DockerfileStage | undefined = stage
  while (current && current.baseStage !== null) current = dockerfile.stages[current.baseStage]
  return current?.baseImage ?? null
}

/** What the container user is, from the Dockerfile alone. */
export type DockerfileUserKind = 'none' | 'root' | 'non_root' | 'unknown'

export interface DockerfileUserReading {
  /** The stage that was read, null when the file has none or the target is not found. */
  stage: DockerfileStage | null
  /** `none`: no `USER` anywhere on the stage's chain. `unknown`: the last one has an unresolved variable. */
  kind: DockerfileUserKind
  /** The last `USER` that applies, as written and resolved. */
  user: DockerfileUser | null
  /** Index of the stage that `USER` was set in (earlier than `stage` when it is inherited). */
  userStage: number | null
  /** The external base image of the stage, with its tag. */
  baseImage: ImageRef | null
  /** True when the base image tag ends in `nonroot`. */
  baseNonroot: boolean
}

/**
 * Reads the user of the final stage (or of `target`): the last `USER` wins, and a stage with
 * none inherits the last `USER` of the stage it is built on, as the image config does. The
 * base image and tag are returned too, for images that are non root by tag only.
 */
export function readDockerfileUser(
  text: string,
  options: DockerfileOptions & { target?: string | null } = {},
): DockerfileUserReading {
  const dockerfile = parseDockerfile(text, options)
  const stage = selectStage(dockerfile, options.target)
  if (!stage) {
    return {
      stage: null,
      kind: 'none',
      user: null,
      userStage: null,
      baseImage: null,
      baseNonroot: false,
    }
  }

  let holder: DockerfileStage | undefined = stage
  while (holder && holder.users.length === 0 && holder.baseStage !== null) {
    holder = dockerfile.stages[holder.baseStage]
  }
  const user = holder?.users[holder.users.length - 1] ?? null
  const baseImage = resolveBaseImage(dockerfile, stage)
  const common = { stage, baseImage, baseNonroot: baseImage ? hasNonrootTag(baseImage) : false }

  if (!user || !holder) return { ...common, kind: 'none', user: null, userStage: null }
  const kind = user.value === null ? 'unknown' : classifyContainerUser(user.value)
  return { ...common, kind, user, userStage: holder.index }
}
