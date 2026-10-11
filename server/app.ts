import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { siws } from 'better-auth-solana'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'

import * as schema from './schema'

export function createApp({ database, origin, secret }: { database: Database; origin: string; secret: string }) {
  const db = drizzle(database, { schema })
  database.exec('PRAGMA foreign_keys = ON')
  migrate(db, { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) })
  const auth = betterAuth({
    baseURL: origin,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    plugins: [siws({ domain: new URL(origin).host, uri: origin })],
    secret,
    trustedOrigins: [origin],
  })
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.header('origin') !== origin) {
      return c.json({ error: 'Untrusted origin' }, 403)
    }
    await next()
  })
  app.on(
    ['GET', 'POST'],
    ['/api/auth/get-session', '/api/auth/sign-out', '/api/auth/siws/nonce', '/api/auth/siws/verify'],
    (c) => auth.handler(c.req.raw),
  )
  app.get('/api/me', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'Authentication required' }, 401)
    const wallet = db
      .select({ address: schema.solanaWallet.address })
      .from(schema.solanaWallet)
      .where(eq(schema.solanaWallet.userId, session.user.id))
      .get()
    if (!wallet) return c.json({ error: 'Wallet identity required' }, 403)
    return c.json({ walletAddress: wallet.address })
  })
  return app
}
