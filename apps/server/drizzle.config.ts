import { defineConfig } from 'drizzle-kit'

// Generates SQL migrations from src/db/schema.ts into ./drizzle:
//   pnpm --filter @hinomi/server db:generate
// The server applies them on boot (src/db/migrate.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
