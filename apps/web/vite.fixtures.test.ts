import { resolveConfig } from 'vite'
import { describe, expect, it } from 'vitest'
import { fixturesMode } from './vite.fixtures.ts'

const HTML = '<script type="module" src="/src/main.tsx"></script>'

async function transform(mode: string, command: 'build' | 'serve') {
  const plugin = fixturesMode()
  const config = await resolveConfig({ configFile: false, mode, plugins: [plugin] }, command)
  const hook = plugin.configResolved
  if (typeof hook === 'function') await hook.call({} as never, config)
  const html = plugin.transformIndexHtml
  if (!html || typeof html === 'function') throw new Error('expected a transformIndexHtml object')
  return html.handler.call({} as never, HTML, {} as never)
}

describe('fixturesMode', () => {
  it('keeps the real entry in a production build', async () => {
    expect(await transform('production', 'build')).toBe(HTML)
  })

  it('keeps the real entry in development', async () => {
    expect(await transform('development', 'serve')).toBe(HTML)
  })

  it('boots through the fixture entry in the fixtures mode only', async () => {
    expect(await transform('fixtures', 'build')).toContain('/src/fixtures/entry.ts')
    expect(await transform('fixtures', 'serve')).not.toContain('/src/main.tsx')
  })
})
