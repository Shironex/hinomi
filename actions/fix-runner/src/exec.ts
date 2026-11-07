import { spawn } from 'node:child_process'
import { nowMs } from '@hinomi/shared'
import type { Env } from './actions-io.js'

// Every process the runner starts goes through this boundary. A command is a program and an
// argument array built from validated fields, started without a shell, so nothing from the
// dispatch is ever parsed as shell syntax. Tests swap the Exec for a fake.

export interface Command {
  file: string
  args: string[]
  /** Extra environment on top of the scrubbed process environment. */
  env?: Record<string, string>
}

export interface ExecOptions {
  /** Absolute working directory. */
  cwd: string
  timeoutMs: number
}

export interface ExecResult {
  /** Exit code, null when the process was killed or could not start. */
  code: number | null
  /** stdout and stderr in the order they arrived, the end kept when it is long. */
  output: string
  timedOut: boolean
  durationMs: number
}

export interface Exec {
  run(command: Command, options: ExecOptions): Promise<ExecResult>
}

/** Renders a command for logs and the result file. Display only, never executed. */
export function formatCommand(command: Command): string {
  return [command.file, ...command.args]
    .map((part) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ')
}

// Variables child processes never get. INPUT_* holds the plan and the other inputs; the
// ACTIONS_* tokens would let an install script write caches or artifacts of this run.
const SCRUBBED = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_CACHE_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
]

/** The environment a child process gets: the parent's minus inputs and runtime tokens. */
export function childEnv(parent: Env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || key.startsWith('INPUT_') || SCRUBBED.includes(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

/** Most output kept per process; the start is dropped first, since errors land at the end. */
const MAX_KEPT_CHARS = 1_000_000

export interface NodeExecOptions {
  env: Env
  /** Receives output as it arrives, for the job log. */
  echo?: (chunk: string) => void
}

/** The real Exec: node:child_process spawn with `shell: false`. */
export function nodeExec(options: NodeExecOptions): Exec {
  return {
    run(command, { cwd, timeoutMs }) {
      const started = nowMs()
      return new Promise((resolve) => {
        let output = ''
        let timedOut = false
        const keep = (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          options.echo?.(text)
          output += text
          if (output.length > MAX_KEPT_CHARS * 2) output = output.slice(-MAX_KEPT_CHARS)
        }
        const child = spawn(command.file, command.args, {
          cwd,
          env: childEnv(options.env, command.env),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
        child.stdout.on('data', keep)
        child.stderr.on('data', keep)
        const finish = (code: number | null, extra = '') => {
          clearTimeout(timer)
          resolve({
            code,
            output: (output + extra).slice(-MAX_KEPT_CHARS),
            timedOut,
            durationMs: nowMs() - started,
          })
        }
        child.on('error', (error) => finish(null, `\n${error.message}`))
        child.on('close', (code) => finish(timedOut ? null : code))
      })
    },
  }
}
