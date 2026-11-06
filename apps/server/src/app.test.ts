import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await createApp().request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('static SPA', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hinomi-web-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>hinomi</title>')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to index.html for client routes', async () => {
    const res = await createApp({ webDistDir: dir }).request('/some/client/route')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>hinomi</title>')
  })

  it('keeps unknown api routes as json 404', async () => {
    const res = await createApp({ webDistDir: dir }).request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })
})
