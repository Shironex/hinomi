import { spawn } from 'node:child_process'

// How the local runner starts its child processes: each in its own process group, with an
// environment the caller built from nothing, killed as a group when it ends or runs too long.
// Behind an interface so tests swap in a fake that never spawns anything.

/** One child process. `env` is the whole environment; nothing is inherited. */
export interface ProcessSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
}

export interface ProcessResult {
  /** Exit code, or null when a signal ended it. */
  code: number | null
  timedOut: boolean
  /** The end of stdout and stderr together, not scrubbed yet. */
  output: string
}

export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessResult>
  /** Kills every process group still running (shutdown). */
  killAll(): void
}

/** How much of a child's output is kept. */
export const PROCESS_OUTPUT_TAIL_BYTES = 64 * 1024

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    // A negative pid is the whole group, so grandchildren go too.
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group is already gone.
  }
}

/** Spawns real processes. POSIX only: the local runner refuses to start on Windows. */
export function nodeProcessRunner(): ProcessRunner {
  const running = new Set<number>()
  return {
    run(spec) {
      return new Promise((resolve) => {
        let output = ''
        let timedOut = false
        const keep = (chunk: Buffer) => {
          output += chunk.toString('utf8')
          if (output.length > PROCESS_OUTPUT_TAIL_BYTES * 2) {
            output = output.slice(-PROCESS_OUTPUT_TAIL_BYTES)
          }
        }
        const child = spawn(spec.file, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        const pid = child.pid
        if (pid !== undefined) running.add(pid)
        const timer = setTimeout(() => {
          timedOut = true
          killGroup(pid)
        }, spec.timeoutMs)
        child.stdout.on('data', keep)
        child.stderr.on('data', keep)
        let done = false
        const finish = (code: number | null) => {
          if (done) return
          done = true
          clearTimeout(timer)
          // Anything the child left running in its group goes with it.
          killGroup(pid)
          if (pid !== undefined) running.delete(pid)
          resolve({ code, timedOut, output: output.slice(-PROCESS_OUTPUT_TAIL_BYTES) })
        }
        child.on('error', (error) => {
          output += `\n${error.message}`
          finish(null)
        })
        // A grandchild holding the pipes open would delay `close`, so the group goes on exit.
        child.on('exit', () => killGroup(pid))
        child.on('close', (code) => finish(code))
      })
    },
    killAll() {
      for (const pid of running) killGroup(pid)
    },
  }
}

/** Token shapes GitHub hands out, removed from output even when they are not the push token. */
const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g

/**
 * Removes the given secrets, their basic auth forms and GitHub token shapes from text, and drops
 * workflow command lines that carry a mask.
 */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  let clean = text
    .split('\n')
    .filter((line) => !line.startsWith('::add-mask::'))
    .join('\n')
  for (const secret of secrets) {
    if (secret === '') continue
    const forms = [
      secret,
      Buffer.from(`x-access-token:${secret}`, 'utf8').toString('base64'),
      Buffer.from(secret, 'utf8').toString('base64'),
    ]
    for (const form of forms) clean = clean.split(form).join('***')
  }
  return clean.replace(TOKEN_SHAPES, '***')
}
