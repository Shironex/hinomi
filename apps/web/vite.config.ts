import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vitest/config'
import { fixturesMode } from './vite.fixtures.ts'

const apiTarget = process.env.HINOMI_API_URL ?? 'http://localhost:3000'

/**
 * Fills the placeholders in the built sw.js: the shell files to precache (index and the hashed
 * assets) and a build id from their names, so a new build gets a new cache and old ones are
 * deleted on activate. Hashed names change whenever their content does.
 */
function serviceWorkerBuild(): Plugin {
  let outDir = ''
  let shell: string[] = []
  return {
    name: 'hinomi-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir)
    },
    writeBundle(_options, bundle) {
      shell = [
        '/',
        ...Object.keys(bundle)
          .filter((name) => name.startsWith('assets/'))
          .map((name) => `/${name}`),
      ]
    },
    closeBundle: {
      order: 'post',
      handler() {
        if (shell.length === 0) return
        const file = join(outDir, 'sw.js')
        const id = createHash('sha256').update(shell.join('\n')).digest('hex').slice(0, 12)
        const source = readFileSync(file, 'utf8')
          .replace('__BUILD_ID__', id)
          .replace('__PRECACHE__', JSON.stringify(shell))
        writeFileSync(file, source)
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerBuild(), fixturesMode()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Longer than asyncUtilTimeout, so a missing element fails with its own message, not a timeout.
    testTimeout: 15_000,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
    },
  },
})
