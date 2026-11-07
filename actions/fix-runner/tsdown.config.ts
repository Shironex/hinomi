import { defineConfig } from 'tsdown'

// GitHub runs the action straight from the repo, so dist/index.mjs is committed and holds
// everything: every dependency is a dev dependency and gets bundled, nothing is installed
// at run time. Not minified, so a reviewer can read what the action runs.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: false,
  sourcemap: false,
  minify: false,
  // JSDoc comments stay in the sources and out of the bundle; license comments are kept.
  outputOptions: { comments: { legal: true, annotation: true, jsdoc: false } },
  // The packages allowed into the bundle; a new one fails the build until it is listed here.
  deps: { onlyBundle: ['zod', 'yaml'] },
})
