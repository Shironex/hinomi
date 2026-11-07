import {
  imageRuntime,
  parseDockerfile,
  readInstructions,
  tokenizeShellLine,
  type DockerfileStage,
  type Runtime,
  type RuntimePinRecord,
} from '@hinomi/shared'
import { makePin } from './pin.js'
import { readImagePin } from './value.js'

/** The runtime a `FROM` names when a variable keeps it from being parsed (`node:${VERSION}`). */
function runtimeOfFrom(from: string): Runtime | null {
  const image = /^(?:[\w.-]+(?::\d+)?\/)*?(node|rust|oven\/bun)(?=[:@]|$)/i.exec(from.trim())?.[1]
  switch (image?.toLowerCase()) {
    case 'node':
      return 'node'
    case 'rust':
      return 'rust'
    case 'oven/bun':
      return 'bun'
    default:
      return null
  }
}

/** Indexes of a stage and every stage it is built on. */
function lineageOf(stages: DockerfileStage[], start: DockerfileStage | undefined): Set<number> {
  const lineage = new Set<number>()
  let current = start
  while (current && !lineage.has(current.index)) {
    lineage.add(current.index)
    current = current.baseStage === null ? undefined : stages[current.baseStage]
  }
  return lineage
}

/** The stage a `COPY --from=` names: an alias (any case) or an index. Null for an image. */
function stageNamed(stages: DockerfileStage[], name: string): DockerfileStage | undefined {
  if (/^\d+$/.test(name)) return stages[Number(name)]
  const lower = name.toLowerCase()
  return stages.find((stage) => stage.name?.toLowerCase() === lower)
}

const NODE_MODULES = /(^|\/)node_modules(\/|$)/

/**
 * The stages whose output reaches the final image: the final stage, the stages it is built on,
 * and every stage it copies `node_modules` from (`COPY --from=deps /app/node_modules .`), followed
 * through those stages too. A module built on one Node line can break on another, so such a stage
 * must run the same line as production (design section 5.5); a stage that only builds files does
 * not. A copy of a whole folder is not followed: it may or may not hold `node_modules`.
 */
function reachingFinal(text: string, stages: DockerfileStage[]): Set<number> {
  const reached = lineageOf(stages, stages[stages.length - 1])
  const copies: { into: number; from: DockerfileStage }[] = []
  let current = -1
  for (const { keyword, args } of readInstructions(text)) {
    if (keyword === 'FROM') current++
    if (keyword !== 'COPY' || current < 0) continue
    const tokens = tokenizeShellLine(args)
    const from = tokens.find((t) => t.toLowerCase().startsWith('--from='))?.slice('--from='.length)
    const paths = tokens.filter((t) => !t.startsWith('--')).slice(0, -1)
    if (from === undefined || !paths.some((p) => NODE_MODULES.test(p))) continue
    const source = stageNamed(stages, from)
    if (source && source.index !== current) copies.push({ into: current, from: source })
  }
  let grew = true
  while (grew) {
    grew = false
    for (const copy of copies) {
      if (!reached.has(copy.into) || reached.has(copy.from.index)) continue
      for (const index of lineageOf(stages, copy.from)) reached.add(index)
      grew = true
    }
  }
  return reached
}

export interface DockerfilePinOptions {
  /** A deployment builds this Dockerfile: its final stage runs in production. */
  production: boolean
}

/** One pin per stage whose base image is Node, Bun or Rust. */
export function parseDockerfilePins(
  text: string,
  path: string,
  options: DockerfilePinOptions,
): RuntimePinRecord[] {
  const { stages } = parseDockerfile(text)
  const lineage = lineageOf(stages, stages[stages.length - 1])
  const reached = reachingFinal(text, stages)
  const pins: RuntimePinRecord[] = []
  for (const stage of stages) {
    const ref = stage.baseImage
    const runtime = ref
      ? imageRuntime(ref)
      : stage.baseUnresolved
        ? runtimeOfFrom(stage.from)
        : null
    if (runtime === null) continue
    const final = lineage.has(stage.index)
    const site = {
      runtime,
      source: 'dockerfile' as const,
      path,
      line: stage.line,
      raw: ref?.raw ?? stage.from,
      scope: options.production && final ? ('production' as const) : ('dev' as const),
      stage: stage.index,
      finalStage: reached.has(stage.index),
    }
    pins.push(
      makePin(
        site,
        ref ? readImagePin(runtime, ref) : { kind: 'unknown', version: null, lineName: null },
      ),
    )
  }
  return pins
}
