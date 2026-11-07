import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await createApp().request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', version: 'dev' })
  })
})

describe('static SPA', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hinomi-web-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>hinomi</title>')
    writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Hinomi"}')
    writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
    writeFileSync(join(dir, 'icon-192.png'), 'png')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'export {}')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to index.html for client routes', async () => {
    const res = await createApp({ webDistDir: dir }).request('/some/client/route')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>hinomi</title>')
  })

  it('serves the manifest with its media type, revalidated', async () => {
    const res = await createApp({ webDistDir: dir }).request('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/manifest+json')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.json()).toEqual({ name: 'Hinomi' })
  })

  it('serves sw.js as javascript that is never cached', async () => {
    const res = await createApp({ webDistDir: dir }).request('/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('addEventListener')
  })

  it('serves icons as files, not as index.html', async () => {
    const res = await createApp({ webDistDir: dir }).request('/icon-192.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('png')
  })

  it('caches hashed assets for a year', async () => {
    const res = await createApp({ webDistDir: dir }).request('/assets/index-abc123.js')
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('answers 404 for a missing file instead of the SPA fallback', async () => {
    const app = createApp({ webDistDir: dir })
    for (const path of ['/assets/gone-123.js', '/apple-touch-icon.png', '/other.webmanifest']) {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('<title>hinomi</title>')
    }
  })

  it('keeps unknown api routes as json 404', async () => {
    const res = await createApp({ webDistDir: dir }).request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'No such API route' },
    })
  })
})
