// Renders the brand PNGs (favicons, app icons, social preview) from the SVG and HTML sources
// in this folder with a headless Chromium. No npm dependency: it drives the browser binary
// directly with --screenshot.
//
//   pnpm brand                       # uses CHROME_PATH, a Playwright download, or an installed Chrome
//   CHROME_PATH=/path/to/chrome pnpm brand
//
// The social preview loads Instrument Sans from apps/web/node_modules, so run pnpm install first.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const pub = join(root, 'apps/web/public')

/** Icon renders: source SVG in this folder, output path, square size in px. */
const ICONS = [
  ['favicon.svg', join(pub, 'favicon-32.png'), 32],
  ['icon-maskable.svg', join(pub, 'apple-touch-icon.png'), 180],
  ['icon.svg', join(pub, 'icon-192.png'), 192],
  ['icon.svg', join(pub, 'icon-512.png'), 512],
  ['icon-maskable.svg', join(pub, 'icon-maskable-512.png'), 512],
]

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const os = platform()
  const cache =
    os === 'darwin'
      ? join(homedir(), 'Library/Caches/ms-playwright')
      : os === 'win32'
        ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
        : join(homedir(), '.cache/ms-playwright')
  if (existsSync(cache)) {
    const shells = readdirSync(cache)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()
    for (const dir of shells) {
      for (const sub of readdirSync(join(cache, dir))) {
        const bin = join(
          cache,
          dir,
          sub,
          os === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell',
        )
        if (existsSync(bin)) return bin
      }
    }
  }
  const installed = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    win32: [
      join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }
  const hit = (installed[os] ?? []).find((p) => existsSync(p))
  if (hit) return hit
  throw new Error(
    'No Chromium found. Set CHROME_PATH or run `pnpm dlx playwright install --only-shell chromium`.',
  )
}

function shoot(chrome, url, out, width, height) {
  execFileSync(
    chrome,
    [
      '--headless',
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      '--virtual-time-budget=3000',
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      url,
    ],
    { stdio: 'ignore' },
  )
  console.log(`wrote ${out.slice(root.length + 1)} (${width}x${height})`)
}

const chrome = findChrome()
const tmp = mkdtempSync(join(tmpdir(), 'hinomi-brand-'))
try {
  for (const [src, out, size] of ICONS) {
    const page = join(tmp, `${size}-${src}.html`)
    const img = pathToFileURL(join(here, src)).href
    writeFileSync(
      page,
      `<!doctype html><html><body style="margin:0;background:transparent"><img src="${img}" width="${size}" height="${size}" style="display:block"></body></html>`,
    )
    shoot(chrome, pathToFileURL(page).href, out, size, size)
  }
  copyFileSync(join(here, 'favicon.svg'), join(pub, 'favicon.svg'))
  console.log('wrote apps/web/public/favicon.svg (copy)')
  const social = pathToFileURL(join(here, 'social-preview.html')).href
  shoot(chrome, social, join(here, 'social-preview.png'), 1280, 640)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
