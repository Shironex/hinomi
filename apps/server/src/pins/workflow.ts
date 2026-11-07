import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml'
import type { Runtime, RuntimePinRecord, RuntimePinSource } from '@hinomi/shared'
import { makePin } from './pin.js'
import { readPinValue } from './value.js'

// Pins in GitHub workflows: the setup actions of Node, Bun and Rust. A value is read from the
// source text of its node, never from the YAML number (`20.10` must not become `20.1`).

interface Located {
  raw: string
  line: number | null
}

interface Context {
  text: string
  lines: LineCounter
  workflowEnv: YAMLMap | null
  jobEnv: YAMLMap | null
  matrix: YAMLMap | null
  stepEnv: YAMLMap | null
}

const EXPRESSION = /^\$\{\{\s*([\s\S]+?)\s*\}\}$/

function asMap(node: unknown): YAMLMap | null {
  return isMap(node) ? node : null
}

function sourceOf(node: Node, ctx: Context): Located {
  const range = node.range
  const raw = range
    ? ctx.text.slice(range[0], range[1]).trim()
    : String(isScalar(node) ? node.value : '')
  return { raw, line: range ? ctx.lines.linePos(range[0]).line : null }
}

function scalarValues(node: unknown, ctx: Context): Located[] {
  if (isScalar(node)) return [sourceOf(node, ctx)]
  if (isSeq(node))
    return node.items.flatMap((item) => (isScalar(item) ? [sourceOf(item, ctx)] : []))
  return []
}

/** Values of `${{ matrix.x }}` and `${{ env.X }}` that are written out in the file, or null. */
function resolveExpression(expression: string, ctx: Context): Located[] | null {
  const match = /^(matrix|env)\.([A-Za-z_][\w-]*)$/.exec(expression)
  const name = match?.[2]
  if (!match || name === undefined) return null
  if (match[1] === 'env') {
    for (const env of [ctx.stepEnv, ctx.jobEnv, ctx.workflowEnv]) {
      const node = env?.get(name, true)
      if (isScalar(node)) return [sourceOf(node, ctx)]
    }
    return null
  }
  if (!ctx.matrix) return null
  const values = scalarValues(ctx.matrix.get(name, true), ctx)
  const include = ctx.matrix.get('include', true)
  if (isSeq(include)) {
    for (const entry of include.items) {
      const item = asMap(entry)?.get(name, true)
      if (isScalar(item)) values.push(sourceOf(item, ctx))
    }
  }
  return values.length > 0 ? values : null
}

/** The pins one input gives: each literal, each matrix entry, or one unknown. */
function pinsOfInput(
  node: unknown,
  ctx: Context,
  runtime: Runtime,
  source: RuntimePinSource,
  path: string,
  job: string,
  resolveFile?: (file: string, runtime: Runtime) => RuntimePinRecord | null,
  isFile = false,
): RuntimePinRecord[] {
  if (!isScalar(node)) return []
  const written = sourceOf(node, ctx)
  const site = (value: Located) => ({
    runtime,
    source,
    path,
    line: value.line,
    raw: value.raw,
    scope: 'ci' as const,
    job,
  })
  const unknown = { kind: 'unknown' as const, version: null, lineName: null }
  let values: Located[] = [written]
  const expression = EXPRESSION.exec(written.raw.replace(/^["']|["']$/g, ''))
  if (expression?.[1] !== undefined) {
    values = resolveExpression(expression[1], ctx) ?? []
    if (values.length === 0) return [makePin(site(written), unknown)]
  } else if (written.raw.includes('${{')) {
    return [makePin(site(written), unknown)]
  }
  if (runtime === 'rust' && !isFile) {
    // `toolchain: stable, nightly` names several toolchains in one input.
    values = values.flatMap((value) =>
      value.raw.includes(',')
        ? value.raw.split(',').map((part) => ({ raw: part.trim(), line: value.line }))
        : [value],
    )
  }
  return values.map((value) => {
    if (isFile) {
      const file = value.raw.replace(/^["']|["']$/g, '').replace(/^\.\//, '')
      const resolved = resolveFile?.(file, runtime) ?? null
      return makePin(
        site({ raw: file, line: value.line }),
        resolved
          ? { kind: resolved.kind, version: resolved.version, lineName: resolved.lineName }
          : unknown,
      )
    }
    return makePin(site(value), readPinValue(runtime, value.raw))
  })
}

export interface WorkflowOptions {
  /** The pins of a version file the workflow names (`node-version-file`), or null. */
  resolveFile?: (file: string, runtime: Runtime) => RuntimePinRecord | null
}

const NODE_ACTION = /^actions\/setup-node(?:@|$)/i
const BUN_ACTION = /^oven-sh\/setup-bun(?:@|$)/i
const RUST_ACTIONS = /^(?:dtolnay\/rust-toolchain|actions-rust-lang\/setup-rust-toolchain)(?:@|$)/i

export function parseWorkflow(
  text: string,
  path: string,
  options: WorkflowOptions = {},
): RuntimePinRecord[] {
  const lines = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lines, strict: false, uniqueKeys: false })
  const root = asMap(doc.contents)
  const jobs = asMap(root?.get('jobs', true))
  if (!root || !jobs) return []
  const pins: RuntimePinRecord[] = []
  const workflowEnv = asMap(root.get('env', true))

  for (const jobPair of jobs.items) {
    const job = asMap(jobPair.value)
    const steps = job?.get('steps', true)
    if (!job || !isSeq(steps)) continue
    const jobId = isScalar(jobPair.key) ? String(jobPair.key.value) : ''
    const strategy = asMap(job.get('strategy', true))
    const base: Omit<Context, 'stepEnv'> = {
      text,
      lines,
      workflowEnv,
      jobEnv: asMap(job.get('env', true)),
      matrix: asMap(strategy?.get('matrix', true)),
    }
    for (const stepNode of steps.items) {
      const step = asMap(stepNode)
      const uses = step?.get('uses', true)
      if (!step || !isScalar(uses)) continue
      const used = sourceOf(uses, { ...base, stepEnv: null })
      const action = used.raw.replace(/^["']|["']$/g, '')
      const ctx: Context = { ...base, stepEnv: asMap(step.get('env', true)) }
      const withMap = asMap(step.get('with', true))
      const input = (name: string) => withMap?.get(name, true)
      const add = (runtime: Runtime, source: RuntimePinSource, node: unknown, isFile = false) =>
        pins.push(
          ...pinsOfInput(node, ctx, runtime, source, path, jobId, options.resolveFile, isFile),
        )

      if (NODE_ACTION.test(action)) {
        if (input('node-version') !== undefined) add('node', 'setup_node', input('node-version'))
        else add('node', 'setup_node', input('node-version-file'), true)
      } else if (BUN_ACTION.test(action)) {
        if (input('bun-version') !== undefined) add('bun', 'setup_bun', input('bun-version'))
        else add('bun', 'setup_bun', input('bun-version-file'), true)
      } else if (RUST_ACTIONS.test(action)) {
        const toolchain = input('toolchain')
        if (toolchain !== undefined) {
          add('rust', 'rust_toolchain_action', toolchain)
        } else if (/^dtolnay\//i.test(action)) {
          // `dtolnay/rust-toolchain@stable` and `@1.82.0`: the ref is the toolchain.
          const ref = action.slice(action.indexOf('@') + 1)
          if (ref !== '' && ref !== 'master' && action.includes('@')) {
            pins.push(
              makePin(
                {
                  runtime: 'rust',
                  source: 'rust_toolchain_action',
                  path,
                  line: used.line,
                  raw: ref,
                  scope: 'ci',
                  job: jobId,
                },
                readPinValue('rust', ref),
              ),
            )
          }
        }
      }
    }
  }
  return pins
}
