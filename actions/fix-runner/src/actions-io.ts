import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

// The GitHub Actions runtime protocol, by hand: inputs come in as INPUT_<NAME> variables,
// outputs go to the file named by GITHUB_OUTPUT, logs and masks are workflow commands on
// stdout. A dozen lines instead of a dependency.

export type Env = Readonly<Record<string, string | undefined>>

/** Reads input `name` the way the runner passes it: INPUT_ plus the upper cased name. */
export function getInput(env: Env, name: string): string {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  return (env[key] ?? '').trim()
}

/** Values logged next to a static message, rendered as `key=value` pairs. */
export type LogFields = Record<string, string | number | boolean | null>

export interface Logger {
  info(message: string, fields?: LogFields): void
  warning(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  group<T>(title: string, run: () => Promise<T>): Promise<T>
}

/** `message key=value key2="two words"`, the line a log entry becomes. */
export function formatLog(message: string, fields?: LogFields): string {
  const pairs = Object.entries(fields ?? {}).map(([key, value]) => {
    const text = String(value)
    return `${key}=${/^[^\s"=]+$/.test(text) ? text : JSON.stringify(text)}`
  })
  return [message, ...pairs].join(' ')
}

// Workflow command data escapes, so a message can never start a command of its own.
function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

export function consoleLogger(write: (line: string) => void): Logger {
  return {
    info: (message, fields) => write(formatLog(message, fields)),
    warning: (message, fields) => write(`::warning::${escapeData(formatLog(message, fields))}`),
    error: (message, fields) => write(`::error::${escapeData(formatLog(message, fields))}`),
    async group(title, run) {
      write(`::group::${escapeData(title)}`)
      try {
        return await run()
      } finally {
        write('::endgroup::')
      }
    },
  }
}

/** Writes action outputs to the GITHUB_OUTPUT file, with a random heredoc delimiter. */
export function writeOutputs(file: string, outputs: Record<string, string>): void {
  let text = ''
  for (const [name, value] of Object.entries(outputs)) {
    const delimiter = `hinomi_${randomUUID()}`
    text += `${name}<<${delimiter}\n${value}\n${delimiter}\n`
  }
  appendFileSync(file, text, 'utf8')
}
