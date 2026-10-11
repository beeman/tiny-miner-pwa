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
      ironHealth: schema.miningProgress.ironHealth,
      ironOre: schema.miningProgress.ironOre,
      ironPickaxeOwned: schema.miningProgress.ironPickaxeOwned,
      revision: schema.miningProgress.revision,
      xp: schema.miningProgress.xp,
    }
    if (c.req.method === 'GET') {
      const progress = db
        .select(fields)
        .from(schema.miningProgress)
        .where(eq(schema.miningProgress.userId, userId))
        .get()
      return c.json(
        progress ?? {
          coins: 0,
          copper: 0,
          health: 10,
          ironHealth: 20,
          ironOre: 0,
          ironPickaxeOwned: false,
          revision: 0,
          xp: 0,
        },
      )
    }
    const body: unknown = await c.req.json().catch(() => null)
    const actionId = body && typeof body === 'object' && 'actionId' in body ? body.actionId : null
    const mineId = body && typeof body === 'object' && 'mineId' in body ? body.mineId : 'copper'
    if (
      typeof actionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId)
    ) {
      return c.json({ error: 'A UUID actionId is required' }, 400)
    }
    if (mineId !== 'copper' && mineId !== 'iron') return c.json({ error: 'A valid mineId is required' }, 400)
    const receiptId = mineId === 'iron' ? `mine:iron:${actionId}` : actionId
    const healthColumn = mineId === 'iron' ? schema.miningProgress.ironHealth : schema.miningProgress.health
    const damage = sql<number>`CASE WHEN ${schema.miningProgress.ironPickaxeOwned} THEN 3 ELSE 2 END`
    const breakingHit = sql`${healthColumn} <= ${damage}`
    const progress = db.transaction(
      (tx) => {
        const recorded = tx
          .select({
            coins: schema.miningAction.coins,
            copper: schema.miningAction.copper,
            health: schema.miningAction.health,
            ironHealth: schema.miningAction.ironHealth,
            ironOre: schema.miningAction.ironOre,
            ironPickaxeOwned: schema.miningAction.ironPickaxeOwned,
            revision: schema.miningAction.revision,
            xp: schema.miningAction.xp,
          })
          .from(schema.miningAction)
          .where(and(eq(schema.miningAction.actionId, receiptId), eq(schema.miningAction.userId, userId)))
          .get()
        if (recorded) return recorded
        const current = tx
          .select({ xp: schema.miningProgress.xp })
          .from(schema.miningProgress)
          .where(eq(schema.miningProgress.userId, userId))
          .get()
        if (mineId === 'iron' && (current?.xp ?? 0) < 100) {
          return { error: 'Iron Mine unlocks at level 2', status: 403 as const }
        }
        tx.insert(schema.miningProgress).values({ userId }).onConflictDoNothing().run()
        const mineUpdates =
          mineId === 'iron'
            ? {
                ironHealth: sql`CASE WHEN ${breakingHit} THEN 20 ELSE ${schema.miningProgress.ironHealth} - ${damage} END`,
                ironOre: sql`${schema.miningProgress.ironOre} + CASE WHEN ${breakingHit} THEN 2 ELSE 0 END`,
              }
            : {
                copper: sql`${schema.miningProgress.copper} + CASE WHEN ${breakingHit} THEN 2 ELSE 0 END`,
                health: sql`CASE WHEN ${breakingHit} THEN 10 ELSE ${schema.miningProgress.health} - ${damage} END`,
              }
        const saved = tx
          .update(schema.miningProgress)
          .set({
            ...mineUpdates,
            revision: sql`${schema.miningProgress.revision} + 1`,
            xp: sql`${schema.miningProgress.xp} + CASE WHEN ${breakingHit} THEN 10 ELSE 0 END`,
          })
          .where(eq(schema.miningProgress.userId, userId))
          .returning(fields)
          .get()
        if (!saved) throw new Error('Could not save mining progress')
        tx.insert(schema.miningAction)
          .values({ actionId: receiptId, ...saved, userId })
          .run()
        return saved
      },
      { behavior: 'immediate' },
    )
    if ('error' in progress) return c.json({ error: progress.error }, progress.status)
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
      ironHealth: schema.miningProgress.ironHealth,
      ironOre: schema.miningProgress.ironOre,
      ironPickaxeOwned: schema.miningProgress.ironPickaxeOwned,
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
            ironHealth: schema.miningAction.ironHealth,
            ironOre: schema.miningAction.ironOre,
            ironPickaxeOwned: schema.miningAction.ironPickaxeOwned,
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
            coins: sql`${schema.miningProgress.coins} + ${schema.miningProgress.copper} * 5 + ${schema.miningProgress.ironOre} * 10`,
            copper: 0,
            ironOre: 0,
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
  app.post('/api/mining/upgrade/iron-pickaxe', async (c) => {
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
    const receiptId = `upgrade:iron-pickaxe:${actionId}`
    const fields = {
      coins: schema.miningProgress.coins,
      copper: schema.miningProgress.copper,
      health: schema.miningProgress.health,
      ironHealth: schema.miningProgress.ironHealth,
      ironOre: schema.miningProgress.ironOre,
      ironPickaxeOwned: schema.miningProgress.ironPickaxeOwned,
      revision: schema.miningProgress.revision,
      xp: schema.miningProgress.xp,
    }
    const result = db.transaction(
      (tx) => {
        const recorded = tx
          .select({
            coins: schema.miningAction.coins,
            copper: schema.miningAction.copper,
            health: schema.miningAction.health,
            ironHealth: schema.miningAction.ironHealth,
            ironOre: schema.miningAction.ironOre,
            ironPickaxeOwned: schema.miningAction.ironPickaxeOwned,
            revision: schema.miningAction.revision,
            xp: schema.miningAction.xp,
          })
          .from(schema.miningAction)
          .where(and(eq(schema.miningAction.actionId, receiptId), eq(schema.miningAction.userId, userId)))
          .get()
        if (recorded) return { progress: recorded }
        tx.insert(schema.miningProgress).values({ userId }).onConflictDoNothing().run()
        const current = tx
          .select({ coins: schema.miningProgress.coins, owned: schema.miningProgress.ironPickaxeOwned })
          .from(schema.miningProgress)
          .where(eq(schema.miningProgress.userId, userId))
          .get()
        if (!current) throw new Error('Could not load mining progress')
        if (current.owned) return { error: 'Iron Pickaxe already owned', status: 409 as const }
        if (current.coins < 20) return { error: 'Not enough coins to buy the Iron Pickaxe', status: 409 as const }
        const saved = tx
          .update(schema.miningProgress)
          .set({
            coins: sql`${schema.miningProgress.coins} - 20`,
            ironPickaxeOwned: true,
            revision: sql`${schema.miningProgress.revision} + 1`,
          })
          .where(eq(schema.miningProgress.userId, userId))
          .returning(fields)
          .get()
        if (!saved) throw new Error('Could not save Iron Pickaxe purchase')
        tx.insert(schema.miningAction)
          .values({ actionId: receiptId, ...saved, userId })
          .run()
        return { progress: saved }
      },
      { behavior: 'immediate' },
    )
    if ('error' in result) return c.json({ error: result.error }, result.status)
    return c.json(result.progress)
  })
  return app
}
