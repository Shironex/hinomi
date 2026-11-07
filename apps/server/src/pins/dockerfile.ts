import {
  imageRuntime,
  parseDockerfile,
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

/** Indexes of the final stage and every stage it is built on. */
function finalLineage(stages: DockerfileStage[]): Set<number> {
  const lineage = new Set<number>()
  let current: DockerfileStage | undefined = stages[stages.length - 1]
  while (current && !lineage.has(current.index)) {
    lineage.add(current.index)
    current = current.baseStage === null ? undefined : stages[current.baseStage]
  }
  return lineage
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
  const lineage = finalLineage(stages)
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
      finalStage: final,
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
