import type { FixDispatchStep } from '@hinomi/shared'
import type { Command } from '../exec.js'
import { GO_PROXY } from '../registry.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'

// Go modules. Hinomi reads go.mod as the lockfile: since Go 1.17 it lists every module the
// build selects, indirect ones marked `// indirect`. A step is a lockfile_update that runs
// `go get <module>@v<to>`, which rewrites the requirement in go.mod (adding it when the module
// was only implied) and its hashes in go.sum. Go has no install scripts and `go get` never
// builds or runs code; GOTOOLCHAIN=local keeps it from downloading and running another Go
// toolchain that a `toolchain` line asks for, and GOWORK=off keeps a go.work out of it.

/** Environment of every go command: no toolchain switch, no workspace. */
export const GO_ENV: Readonly<Record<string, string>> = {
  GOTOOLCHAIN: 'local',
  GOWORK: 'off',
}

export interface GoRequirement {
  path: string
  /** Without the leading `v`, as Hinomi and OSV spell Go versions. */
  version: string
  indirect: boolean
}

const stripV = (version: string) => version.replace(/^v/, '')

/** Strips a `//` comment and splits a directive line into tokens, quotes removed. */
function tokens(line: string): { words: string[]; comment: string } {
  const at = line.indexOf('//')
  const body = at === -1 ? line : line.slice(0, at)
  const words = body
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^["`]|["`]$/g, ''))
  return { words, comment: at === -1 ? '' : line.slice(at + 2) }
}

interface GoMod {
  requires: GoRequirement[]
  /** Module paths a `replace` directive points elsewhere. */
  replaced: Set<string>
}

/** The `require` and `replace` directives of a go.mod, single line and block forms. */
export function parseGoMod(text: string): GoMod {
  const requires: GoRequirement[] = []
  const replaced = new Set<string>()
  let block: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const { words, comment } = tokens(raw)
    if (words.length === 0) continue
    if (block !== null) {
      if (words[0] === ')') {
        block = null
        continue
      }
      directive(block, words, comment)
      continue
    }
    const [verb, ...rest] = words
    if ((verb === 'require' || verb === 'replace') && rest[0] === '(') {
      block = verb
      continue
    }
    if (verb) directive(verb, rest, comment)
  }
  return { requires, replaced }

  function directive(verb: string, args: string[], comment: string) {
    if (verb === 'require' && args.length >= 2) {
      requires.push({
        path: args[0] ?? '',
        version: stripV(args[1] ?? ''),
        indirect: /^\s*indirect\b/.test(comment),
      })
    } else if (verb === 'replace' && args[0]) {
      replaced.add(args[0])
    }
  }
}

async function readGoMod(ctx: ProjectContext): Promise<GoMod | null> {
  const text = await ctx.fs.read(ctx.lockfile)
  return text === null ? null : parseGoMod(text)
}

function goCommand(args: string[]): Command {
  return { file: 'go', args, env: { ...GO_ENV } }
}

/** The single `go get` for the steps of one attempt, null when there is nothing to get. */
export function goGetCommand(steps: readonly FixDispatchStep[]): Command | null {
  const targets = steps.flatMap(({ apply }) =>
    apply.type === 'lockfile_update' ? [`${apply.packageName}@v${apply.to}`] : [],
  )
  return targets.length === 0 ? null : goCommand(['get', ...targets])
}

async function checkStep(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'lockfile_update' || apply.tool !== 'go') {
    return { status: 'failed', reason: 'edit_failed', detail: `${apply.type} is not a go get` }
  }
  const mod = await readGoMod(ctx)
  if (mod?.replaced.has(apply.packageName)) {
    // go get would move the requirement while the replacement keeps winning.
    return {
      status: 'skipped',
      reason: 'manual_specifier',
      detail: `${ctx.lockfile} replaces ${apply.packageName}: update the replace directive by hand`,
    }
  }
  return { status: 'edited', files: [] }
}

export const goApplier: Applier = {
  packageManager: 'go',
  lockfiles: ['go.mod'],
  versionCommand: goCommand(['version']),

  async resolvedVersions(ctx, modulePath) {
    const mod = await readGoMod(ctx)
    const versions = (mod?.requires ?? [])
      .filter((r) => r.path === modulePath)
      .map((r) => r.version)
    return [...new Set(versions)]
  },

  // Go has no release age setting of its own; Hinomi's floor applies.
  releaseAgeGate: () => Promise.resolve(null),

  publishedAt(ctx, modulePath, version) {
    return ctx.publishTimes.publishedAt(modulePath, version, GO_PROXY)
  },

  applyStep: checkStep,

  lockfileInstall(_ctx, { steps }) {
    const command = goGetCommand(steps)
    return command === null ? [] : command
  },

  fullInstall() {
    return goCommand(['mod', 'download'])
  },

  checks() {
    return Promise.resolve([
      { name: 'go build', command: goCommand(['build', './...']) },
      { name: 'go test', command: goCommand(['test', './...']) },
    ])
  },
}
