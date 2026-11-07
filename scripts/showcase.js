#!/usr/bin/env node
/**
 * Regenerates every README image from fixture mode (see showcase.config.js):
 *
 *   pnpm showcase                capture and frame the dark, light and phone sets, then the hero
 *   pnpm showcase dark phone     only the listed variants (the hero needs dark)
 *   pnpm showcase readme         print the README screenshot table of the dark set
 *
 * The kit builds the web app in fixture mode and serves it on localhost:15190 for each variant,
 * so no Hinomi server, token or network access is needed.
 */
import { resolve } from 'node:path'
import { capture, frame, hero, readmeSnippet, resolveConfig } from '@noctcore/showcase-kit'
import { showcaseConfig } from '../showcase.config.js'

const VARIANTS = ['dark', 'light', 'phone']
const root = resolve(import.meta.dirname, '..')
const config = (variant) => resolveConfig(showcaseConfig(variant), root, 'showcase.config.js')

const args = process.argv.slice(2)

if (args[0] === 'readme') {
  process.stdout.write(`${readmeSnippet(config('dark'), { cols: 2, base: '.' })}\n`)
} else {
  const unknown = args.filter((arg) => !VARIANTS.includes(arg))
  if (unknown.length) {
    console.error(`Unknown variant: ${unknown.join(', ')}. Use ${VARIANTS.join(', ')} or readme.`)
    process.exit(1)
  }
  const variants = args.length ? args : VARIANTS
  for (const variant of variants) {
    const resolved = config(variant)
    await capture(resolved)
    await frame(resolved)
  }
  if (variants.includes('dark')) await hero(config('dark'))
}
