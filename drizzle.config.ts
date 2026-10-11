import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  out: './server/migrations',
  schema: './server/schema.ts',
})
