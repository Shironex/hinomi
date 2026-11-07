import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nowMs } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeProcessRunner } from './local-process.js'

// The real process runner with small Node scripts: the environment is only what was passed, and
// a timeout kills the whole process group, grandchildren included.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hinomi-process-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform === 'win32')('nodeProcessRunner', () => {
  it('passes only the given environment and keeps the output', async () => {
    process.env.HINOMI_PROCESS_PROBE = 'must-not-leak'
    try {
      const result = await nodeProcessRunner().run({
        file: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'],
        cwd: dir,
        env: { ONLY: '1' },
        timeoutMs: 10_000,
      })
      expect(result.code).toBe(0)
      expect(result.timedOut).toBe(false)
      const keys = JSON.parse(result.output) as string[]
      expect(keys).not.toContain('HINOMI_PROCESS_PROBE')
      expect(keys).toContain('ONLY')
    } finally {
      delete process.env.HINOMI_PROCESS_PROBE
    }
  })

  it('kills the process group when the time is up', async () => {
    const pidFile = join(dir, 'grandchild.pid')
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      'setInterval(() => {}, 1000)',
    ].join('\n')
    const started = nowMs()
    const result = await nodeProcessRunner().run({
      file: process.execPath,
      args: ['-e', script],
      cwd: dir,
      env: {},
      timeoutMs: 1_000,
    })
    expect(result.timedOut).toBe(true)
    expect(nowMs() - started).toBeLessThan(8_000)
    const grandchild = Number(await readFile(pidFile, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(alive(grandchild)).toBe(false)
  })
})
