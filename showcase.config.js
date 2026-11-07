// README images for Hinomi, captured with @noctcore/showcase-kit.
// Regenerate everything with `pnpm showcase` (scripts/showcase.js).
//
// The capture runs the web app alone, without the server: `vite build --mode fixtures` boots
// through apps/web/src/fixtures/entry.ts, which freezes the clock at 5 November 2026 10:00 UTC
// and answers every /api request from the fictional dataset in apps/web/src/fixtures/dataset.ts
// (Kestrel Co, example.dev hosts, made up packages and advisories). No other build mode
// includes any of it, and nothing leaves the machine while capturing.
//
// Determinism: fixed clock and data, dates formatted in UTC whatever the machine's time zone,
// a fresh page load per shot, the pointer parked where it hovers nothing, and the kit
// itself disables animations and waits for fonts.
//
// Variants (see scripts/showcase.js): `dark` is this default export, `light` and `phone` are
// built from it with showcaseConfig().
import { defineConfig } from '@noctcore/showcase-kit'

const PORT = 15190
const ORIGIN = `http://localhost:${PORT}`

const DARK_BACKGROUND = { type: 'gradient', from: '#2e1c44', to: '#0f0818', angle: 135 }
const LIGHT_BACKGROUND = { type: 'gradient', from: '#e7d6f7', to: '#faf6fd', angle: 135 }

/** Open a path on a fresh load, wait for its content, then park the pointer on empty space. */
function open(path, text, park = { x: 1439, y: 450 }) {
  return async (page) => {
    await page.goto(`${ORIGIN}${path}`)
    await page.getByText(text, { exact: true }).first().waitFor()
    await page.mouse.move(park.x, park.y)
  }
}

const DESKTOP_SHOTS = [
  {
    id: 'exposure',
    title: 'Exposure',
    caption:
      'Exposure: 1,286 alerts narrow to the few on public apps, ranked, with the top finding open.',
    nav: open('/?sel=1', 'Why it ranks #1'),
  },
  {
    id: 'finding',
    title: 'Finding',
    caption: 'Finding: why it ranks where it does, the fix and the affected apps.',
    nav: open('/finding/1', 'Why it ranks at the top'),
  },
  {
    id: 'fixes',
    title: 'By fix',
    caption: 'By fix: the package bumps that clear the most findings, across repos and apps.',
    nav: open('/?tab=fixes', 'What it clears'),
  },
  {
    id: 'deployments',
    title: 'Deployments',
    caption: 'Deployments: every app by server, shaded by exposure, with blind spots marked.',
    nav: open('/deployments', 'docs-site'),
  },
  {
    id: 'settings',
    title: 'Settings',
    caption: 'Settings: Coolify, GitHub and OSV.dev sources, channels, scans and repo mapping.',
    nav: open('/settings', 'OSV.dev lockfile scan'),
  },
  {
    id: 'setup',
    title: 'Setup',
    caption: 'Setup: four steps from an empty instance to the first scan.',
    nav: open('/onboarding?fixture=setup', 'Connect GitHub'),
  },
]

const PHONE_SHOTS = [
  {
    id: 'phone',
    title: 'Phone',
    caption: 'On a phone: the same ranking with bottom tabs.',
    nav: open('/', 'authline', { x: 389, y: 60 }),
  },
]

/**
 * The config for one variant: `dark` (the README set), `light` (the same shots in the light
 * theme) or `phone` (one dark capture at phone width).
 */
export function showcaseConfig(variant = 'dark') {
  const light = variant === 'light'
  const phone = variant === 'phone'
  return defineConfig({
    name: 'Hinomi',
    slug: 'hinomi',
    target: {
      mode: 'url',
      url: ORIGIN,
      start: `pnpm exec vite build --mode fixtures --outDir dist-fixtures && pnpm exec vite preview --outDir dist-fixtures --port ${PORT} --strictPort`,
      cwd: 'apps/web',
      readyTimeoutMs: 180000,
    },
    ready: '#root > *',
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: light ? 'light' : 'dark',
    shots: phone ? PHONE_SHOTS : DESKTOP_SHOTS,
    frame: phone
      ? {
          style: 'none',
          theme: 'dark',
          background: DARK_BACKGROUND,
          padding: 56,
          radius: 28,
          shadow: true,
          maxWidth: 720,
          quality: 82,
        }
      : {
          style: 'browser',
          address: 'hinomi.example.dev',
          theme: light ? 'light' : 'dark',
          background: light ? LIGHT_BACKGROUND : DARK_BACKGROUND,
          padding: 64,
          radius: 12,
          shadow: true,
          maxWidth: 1600,
          quality: 82,
        },
    outputs: {
      raw: `showcase-out/raw/${variant}/{id}.png`,
      readme: light ? 'assets/showcase/light/{id}.webp' : 'assets/showcase/{id}.webp',
    },
    // The banner is rendered from the dark set only (scripts/showcase.js).
    ...(phone ? {} : { hero: HERO }),
  })
}

const HERO = {
  layout: 'stack',
  tagline: 'Is anything deployed and reachable exposed right now?',
  logo: 'assets/brand/icon.svg',
  shots: ['deployments', 'fixes', 'exposure'],
  output: 'assets/showcase/hero.webp',
  background: DARK_BACKGROUND,
  theme: 'dark',
  quality: 85,
}

export default showcaseConfig('dark')
