import type { ScanLogger } from './scan/index.js'

/** Structured enough to grep, plain enough to read in `docker logs`. Never pass tokens in `data`. */
export type Logger = ScanLogger

function line(message: string, data?: Record<string, unknown>): string {
  if (!data || Object.keys(data).length === 0) return message
  let json: string
  try {
    json = JSON.stringify(data)
  } catch {
    json = '[unserialisable data]'
  }
  return `${message} ${json}`
}

export function createConsoleLogger(): Logger {
  return {
    info: (message, data) => console.log(line(message, data)),
    warn: (message, data) => console.warn(line(message, data)),
    error: (message, data) => console.error(line(message, data)),
  }
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }
