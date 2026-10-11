import { Database } from 'bun:sqlite'

import { createApp } from './app'

const origin = process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:5173'
const secret = process.env.BETTER_AUTH_SECRET
if (!secret || secret.length < 32) throw new Error('Set BETTER_AUTH_SECRET to at least 32 random characters.')

export default {
  fetch: createApp({ database: new Database(process.env.DATABASE_PATH ?? 'tiny-miner.sqlite'), origin, secret }).fetch,
  hostname: '127.0.0.1',
  port: 3001,
}
