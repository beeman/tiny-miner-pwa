import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { siws } from 'better-auth-solana'
import { and, eq, sql } from 'drizzle-orm'
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
  app.on(['GET', 'POST'], '/api/mining', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'Authentication required' }, 401)
    const userId = session.user.id
    const fields = {
      coins: schema.miningProgress.coins,
      copper: schema.miningProgress.copper,
      health: schema.miningProgress.health,
      revision: schema.miningProgress.revision,
      xp: schema.miningProgress.xp,
    }
    if (c.req.method === 'GET') {
      const progress = db
        .select(fields)
        .from(schema.miningProgress)
        .where(eq(schema.miningProgress.userId, userId))
        .get()
      return c.json(progress ?? { coins: 0, copper: 0, health: 10, revision: 0, xp: 0 })
    }
    const body: unknown = await c.req.json().catch(() => null)
    const actionId = body && typeof body === 'object' && 'actionId' in body ? body.actionId : null
    if (
      typeof actionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId)
    ) {
      return c.json({ error: 'A UUID actionId is required' }, 400)
    }
    const progress = db.transaction(
      (tx) => {
        const recorded = tx
          .select({
            coins: schema.miningAction.coins,
            copper: schema.miningAction.copper,
            health: schema.miningAction.health,
            revision: schema.miningAction.revision,
            xp: schema.miningAction.xp,
          })
          .from(schema.miningAction)
          .where(and(eq(schema.miningAction.actionId, actionId), eq(schema.miningAction.userId, userId)))
          .get()
        if (recorded) return recorded
        tx.insert(schema.miningProgress).values({ userId }).onConflictDoNothing().run()
        const saved = tx
          .update(schema.miningProgress)
          .set({
            copper: sql`${schema.miningProgress.copper} + CASE WHEN ${schema.miningProgress.health} <= 2 THEN 2 ELSE 0 END`,
            health: sql`CASE WHEN ${schema.miningProgress.health} <= 2 THEN 10 ELSE ${schema.miningProgress.health} - 2 END`,
            revision: sql`${schema.miningProgress.revision} + 1`,
            xp: sql`${schema.miningProgress.xp} + CASE WHEN ${schema.miningProgress.health} <= 2 THEN 10 ELSE 0 END`,
          })
          .where(eq(schema.miningProgress.userId, userId))
          .returning(fields)
          .get()
        if (!saved) throw new Error('Could not save mining progress')
        tx.insert(schema.miningAction)
          .values({ actionId, ...saved, userId })
          .run()
        return saved
      },
      { behavior: 'immediate' },
    )
    return c.json(progress)
  })
  app.post('/api/mining/sell', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'Authentication required' }, 401)
    const userId = session.user.id
    const body: unknown = await c.req.json().catch(() => null)
    const actionId = body && typeof body === 'object' && 'actionId' in body ? body.actionId : null
    if (
      typeof actionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId)
    ) {
      return c.json({ error: 'A UUID actionId is required' }, 400)
    }
    const receiptId = `sell:${actionId}`
    const fields = {
      coins: schema.miningProgress.coins,
      copper: schema.miningProgress.copper,
      health: schema.miningProgress.health,
      revision: schema.miningProgress.revision,
      xp: schema.miningProgress.xp,
    }
    const progress = db.transaction(
      (tx) => {
        const recorded = tx
          .select({
            coins: schema.miningAction.coins,
            copper: schema.miningAction.copper,
            health: schema.miningAction.health,
            revision: schema.miningAction.revision,
            xp: schema.miningAction.xp,
          })
          .from(schema.miningAction)
          .where(and(eq(schema.miningAction.actionId, receiptId), eq(schema.miningAction.userId, userId)))
          .get()
        if (recorded) return recorded
        tx.insert(schema.miningProgress).values({ userId }).onConflictDoNothing().run()
        const saved = tx
          .update(schema.miningProgress)
          .set({
            coins: sql`${schema.miningProgress.coins} + ${schema.miningProgress.copper} * 5`,
            copper: 0,
            revision: sql`${schema.miningProgress.revision} + 1`,
          })
          .where(eq(schema.miningProgress.userId, userId))
          .returning(fields)
          .get()
        if (!saved) throw new Error('Could not save copper sale')
        tx.insert(schema.miningAction)
          .values({ actionId: receiptId, ...saved, userId })
          .run()
        return saved
      },
      { behavior: 'immediate' },
    )
    return c.json(progress)
  })
  return app
}
