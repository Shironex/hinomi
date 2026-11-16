import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publicFetch } from './public-fetch.js'

// The public only fetch: no private address by name, by literal, or through a proxy.

let server: Server
let port: number
let hits: number

beforeEach(async () => {
  hits = 0
  server = createServer((_req, res) => {
    hits++
    res.end('reached')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

const post = (url: string) => publicFetch(url, { method: 'POST', body: '{}' })

describe('publicFetch', () => {
  it('refuses a name that resolves to a loopback address, without naming the address', async () => {
    const result = post(`http://localhost:${port}/`)
    await expect(result).rejects.toThrow(/localhost resolves to a private or reserved address/)
    await expect(result).rejects.not.toThrow(/127\.0\.0\.1/)
    await expect(result).rejects.toMatchObject({ code: 'ENOTPUBLIC' })
    expect(hits).toBe(0)
  })

  it.each(['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[64:ff9b::7f00:1]', '169.254.169.254'])(
    'refuses the literal %s before connecting',
    async (host) => {
      const result = post(`http://${host}:${port}/`)
      await expect(result).rejects.toThrow(/not a public address/)
      await expect(result).rejects.toMatchObject({ code: 'ENOTPUBLIC' })
      expect(hits).toBe(0)
    },
  )

  it('never sends through a proxy from the environment', async () => {
    // A child process, because Node reads NODE_USE_ENV_PROXY when it starts. The host does not
    // exist: without the direct agent the request would go to the proxy, which answers anything.
    const module = fileURLToPath(new URL('./public-fetch.ts', import.meta.url))
    const script = `const { publicFetch } = await import(${JSON.stringify(module)})
      try { await publicFetch('http://hinomi-test.invalid/', { method: 'POST', body: '{}' }); console.log('sent') }
      catch (error) { console.log('refused ' + error.code) }`
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            NODE_USE_ENV_PROXY: '1',
            HTTP_PROXY: `http://127.0.0.1:${port}`,
            http_proxy: `http://127.0.0.1:${port}`,
            NO_PROXY: '',
          },
          timeout: 20_000,
        },
        (error, stdout) => (error ? reject(new Error(error.message)) : resolve(stdout)),
      )
    })
    expect(output.trim()).toMatch(/^refused (ENOTFOUND|EAI_AGAIN)$/)
    expect(hits).toBe(0)
  }, 30_000)
})
