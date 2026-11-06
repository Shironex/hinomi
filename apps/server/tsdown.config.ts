import { defineConfig } from 'tsdown'

// Workspace packages are dev dependencies, so they are bundled into the output.
// Runtime dependencies stay external and are installed in the image.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
})
