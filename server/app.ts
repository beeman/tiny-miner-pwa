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
      crystalHealth: schema.miningProgress.crystalHealth,
      crystalOre: schema.miningProgress.crystalOre,
      equippedPickaxe: schema.miningProgress.equippedPickaxe,
      goldHealth: schema.miningProgress.goldHealth,
      goldOre: schema.miningProgress.goldOre,
      goldenPickaxeOwned: schema.miningProgress.goldenPickaxeOwned,
      health: schema.miningProgress.health,
      ironHealth: schema.miningProgress.ironHealth,
      ironOre: schema.miningProgress.ironOre,
      ironPickaxeOwned: schema.miningProgress.ironPickaxeOwned,
      revision: schema.miningProgress.revision,
      steelPickaxeOwned: schema.miningProgress.steelPickaxeOwned,
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
          crystalHealth: 40,
          crystalOre: 0,
          equippedPickaxe: 'wooden',
          goldHealth: 30,
          goldOre: 0,
          goldenPickaxeOwned: false,
          health: 10,
          ironHealth: 20,
          ironOre: 0,
          ironPickaxeOwned: false,
          revision: 0,
          steelPickaxeOwned: false,
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
    if (mineId !== 'copper' && mineId !== 'crystal' && mineId !== 'gold' && mineId !== 'iron') {
      return c.json({ error: 'A valid mineId is required' }, 400)
    }
    const mine = {
      copper: { healthColumn: schema.miningProgress.health, maxHealth: 10, minLevel: 1 },
      crystal: { healthColumn: schema.miningProgress.crystalHealth, maxHealth: 40, minLevel: 4 },
      gold: { healthColumn: schema.miningProgress.goldHealth, maxHealth: 30, minLevel: 3 },
      iron: { healthColumn: schema.miningProgress.ironHealth, maxHealth: 20, minLevel: 2 },
    }[mineId]
    const receiptId = mineId === 'copper' ? actionId : `mine:${mineId}:${actionId}`
    const damage = sql<number>`CASE ${schema.miningProgress.equippedPickaxe} WHEN 'golden' THEN 8 WHEN 'steel' THEN 5 WHEN 'iron' THEN 3 ELSE 2 END`
    const breakingHit = sql`${mine.healthColumn} <= ${damage}`
    const progress = db.transaction(
      (tx) => {
        const recorded = tx
          .select({
            coins: schema.miningAction.coins,
            copper: schema.miningAction.copper,
            crystalHealth: schema.miningAction.crystalHealth,
            crystalOre: schema.miningAction.crystalOre,
            equippedPickaxe: schema.miningAction.equippedPickaxe,
            goldHealth: schema.miningAction.goldHealth,
            goldOre: schema.miningAction.goldOre,
            goldenPickaxeOwned: schema.miningAction.goldenPickaxeOwned,
            health: schema.miningAction.health,
            ironHealth: schema.miningAction.ironHealth,
            ironOre: schema.miningAction.ironOre,
            ironPickaxeOwned: schema.miningAction.ironPickaxeOwned,
            revision: schema.miningAction.revision,
            steelPickaxeOwned: schema.miningAction.steelPickaxeOwned,
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
        if ((current?.xp ?? 0) < (mine.minLevel - 1) * 100) {
          return { error: `Mine unlocks at level ${mine.minLevel}`, status: 403 as const }
        }
        tx.insert(schema.miningProgress).values({ userId }).onConflictDoNothing().run()
        const mineUpdates =
          mineId === 'copper'
            ? {
                copper: sql`${schema.miningProgress.copper} + CASE WHEN ${breakingHit} THEN 2 ELSE 0 END`,
                health: sql`CASE WHEN ${breakingHit} THEN ${mine.maxHealth} ELSE ${schema.miningProgress.health} - ${damage} END`,
              }
            : mineId === 'crystal'
              ? {
                  crystalHealth: sql`CASE WHEN ${breakingHit} THEN ${mine.maxHealth} ELSE ${schema.miningProgress.crystalHealth} - ${damage} END`,
                  crystalOre: sql`${schema.miningProgress.crystalOre} + CASE WHEN ${breakingHit} THEN 2 ELSE 0 END`,
                }
              : mineId === 'gold'
                ? {
                    goldHealth: sql`CASE WHEN ${breakingHit} THEN ${mine.maxHealth} ELSE ${schema.miningProgress.goldHealth} - ${damage} END`,
                    goldOre: sql`${schema.miningProgress.goldOre} + CASE WHEN ${breakingHit} THEN 2 ELSE 0 END`,
                  }
                : {
                    ironHealth: sql`CASE WHEN ${breakingHit} THEN ${mine.maxHealth} ELSE ${schema.miningProgress.ironHealth} - ${damage} END`,
                    ironOre: sql`${schema.miningProgress.ironOre} + CASE WHEN ${breakingHit} THEN 2 ELSE 0 END`,
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
      crystalHealth: schema.miningProgress.crystalHealth,
      crystalOre: schema.miningProgress.crystalOre,
      equippedPickaxe: schema.miningProgress.equippedPickaxe,
      goldHealth: schema.miningProgress.goldHealth,
      goldOre: schema.miningProgress.goldOre,
      goldenPickaxeOwned: schema.miningProgress.goldenPickaxeOwned,
      health: schema.miningProgress.health,
      ironHealth: schema.miningProgress.ironHealth,
      ironOre: schema.miningProgress.ironOre,
      ironPickaxeOwned: schema.miningProgress.ironPickaxeOwned,
      revision: schema.miningProgress.revision,
      steelPickaxeOwned: schema.miningProgress.steelPickaxeOwned,
      xp: schema.miningProgress.xp,
    }
    const progress = db.transaction(
      (tx) => {
        const recorded = tx
          .select({
            coins: schema.miningAction.coins,
            copper: schema.miningAction.copper,
            crystalHealth: schema.miningAction.crystalHealth,
            crystalOre: schema.miningAction.crystalOre,
            equippedPickaxe: schema.miningAction.equippedPickaxe,
            goldHealth: schema.miningAction.goldHealth,
            goldOre: schema.miningAction.goldOre,
            goldenPickaxeOwned: schema.miningAction.goldenPickaxeOwned,
            health: schema.miningAction.health,
            ironHealth: schema.miningAction.ironHealth,
            ironOre: schema.miningAction.ironOre,
            ironPickaxeOwned: schema.miningAction.ironPickaxeOwned,
            revision: schema.miningAction.revision,
            steelPickaxeOwned: schema.miningAction.steelPickaxeOwned,
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
            coins: sql`${schema.miningProgress.coins} + ${schema.miningProgress.copper} * 5 + ${schema.miningProgress.crystalOre} * 50 + ${schema.miningProgress.goldOre} * 25 + ${schema.miningProgress.ironOre} * 10`,
            copper: 0,
            crystalOre: 0,
            goldOre: 0,
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
  app.post('/api/mining/upgrade/:pickaxeId', async (c) => {
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
    const pickaxeId = c.req.param('pickaxeId').replace(/-pickaxe$/, '')
    const pickaxe = {
      golden: { name: 'Golden Pickaxe', ownedColumn: schema.miningProgress.goldenPickaxeOwned, price: 300 },
      iron: { name: 'Iron Pickaxe', ownedColumn: schema.miningProgress.ironPickaxeOwned, price: 20 },
      steel: { name: 'Steel Pickaxe', ownedColumn: schema.miningProgress.steelPickaxeOwned, price: 100 },
    }[pickaxeId]
    if (!pickaxe) return c.json({ error: 'A valid pickaxeId is required' }, 400)
    const equipped = pickaxeId as 'golden' | 'iron' | 'steel'
    const receiptId = `upgrade:${pickaxeId}-pickaxe:${actionId}`
    const fields = {
      coins: schema.miningProgress.coins,
      copper: schema.miningProgress.copper,
      crystalHealth: schema.miningProgress.crystalHealth,
      crystalOre: schema.miningProgress.crystalOre,
      equippedPickaxe: schema.miningProgress.equippedPickaxe,
      goldHealth: schema.miningProgress.goldHealth,
      goldOre: schema.miningProgress.goldOre,
      goldenPickaxeOwned: schema.miningProgress.goldenPickaxeOwned,
      health: schema.miningProgress.health,
      ironHealth: schema.miningProgress.ironHealth,
      ironOre: schema.miningProgress.ironOre,
      ironPickaxeOwned: schema.miningProgress.ironPickaxeOwned,
      revision: schema.miningProgress.revision,
      steelPickaxeOwned: schema.miningProgress.steelPickaxeOwned,
      xp: schema.miningProgress.xp,
    }
    const result = db.transaction(
      (tx) => {
        const recorded = tx
          .select({
            coins: schema.miningAction.coins,
            copper: schema.miningAction.copper,
            crystalHealth: schema.miningAction.crystalHealth,
            crystalOre: schema.miningAction.crystalOre,
            equippedPickaxe: schema.miningAction.equippedPickaxe,
            goldHealth: schema.miningAction.goldHealth,
            goldOre: schema.miningAction.goldOre,
            goldenPickaxeOwned: schema.miningAction.goldenPickaxeOwned,
            health: schema.miningAction.health,
            ironHealth: schema.miningAction.ironHealth,
            ironOre: schema.miningAction.ironOre,
            ironPickaxeOwned: schema.miningAction.ironPickaxeOwned,
            revision: schema.miningAction.revision,
            steelPickaxeOwned: schema.miningAction.steelPickaxeOwned,
            xp: schema.miningAction.xp,
          })
          .from(schema.miningAction)
          .where(and(eq(schema.miningAction.actionId, receiptId), eq(schema.miningAction.userId, userId)))
          .get()
        if (recorded) return { progress: recorded }
        tx.insert(schema.miningProgress).values({ userId }).onConflictDoNothing().run()
        const current = tx
          .select({ coins: schema.miningProgress.coins, owned: pickaxe.ownedColumn })
          .from(schema.miningProgress)
          .where(eq(schema.miningProgress.userId, userId))
          .get()
        if (!current) throw new Error('Could not load mining progress')
        if (current.owned) return { error: `${pickaxe.name} already owned`, status: 409 as const }
        if (current.coins < pickaxe.price)
          return { error: `Not enough coins to buy the ${pickaxe.name}`, status: 409 as const }
        const saved = tx
          .update(schema.miningProgress)
          .set({
            coins: sql`${schema.miningProgress.coins} - ${pickaxe.price}`,
            [pickaxeId === 'iron'
              ? 'ironPickaxeOwned'
              : pickaxeId === 'steel'
                ? 'steelPickaxeOwned'
                : 'goldenPickaxeOwned']: true,
            equippedPickaxe: equipped,
            revision: sql`${schema.miningProgress.revision} + 1`,
          })
          .where(eq(schema.miningProgress.userId, userId))
          .returning(fields)
          .get()
        if (!saved) throw new Error(`Could not save ${pickaxe.name} purchase`)
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
  app.post('/api/mining/equip', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'Authentication required' }, 401)
    const userId = session.user.id
    const body: unknown = await c.req.json().catch(() => null)
    const actionId = body && typeof body === 'object' && 'actionId' in body ? body.actionId : null
    const pickaxeId = body && typeof body === 'object' && 'pickaxeId' in body ? body.pickaxeId : null
    if (
      typeof actionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId)
    ) {
      return c.json({ error: 'A UUID actionId is required' }, 400)
    }
    if (pickaxeId !== 'wooden' && pickaxeId !== 'iron' && pickaxeId !== 'steel' && pickaxeId !== 'golden') {
      return c.json({ error: 'A valid pickaxeId is required' }, 400)
    }
    const receiptId = `equip:${actionId}`
    const fields = {
      coins: schema.miningProgress.coins,
      copper: schema.miningProgress.copper,
      crystalHealth: schema.miningProgress.crystalHealth,
      crystalOre: schema.miningProgress.crystalOre,
      equippedPickaxe: schema.miningProgress.equippedPickaxe,
      goldHealth: schema.miningProgress.goldHealth,
      goldOre: schema.miningProgress.goldOre,
      goldenPickaxeOwned: schema.miningProgress.goldenPickaxeOwned,
      health: schema.miningProgress.health,
      ironHealth: schema.miningProgress.ironHealth,
      ironOre: schema.miningProgress.ironOre,
      ironPickaxeOwned: schema.miningProgress.ironPickaxeOwned,
      revision: schema.miningProgress.revision,
      steelPickaxeOwned: schema.miningProgress.steelPickaxeOwned,
      xp: schema.miningProgress.xp,
    }
    const actionFields = {
      coins: schema.miningAction.coins,
      copper: schema.miningAction.copper,
      crystalHealth: schema.miningAction.crystalHealth,
      crystalOre: schema.miningAction.crystalOre,
      equippedPickaxe: schema.miningAction.equippedPickaxe,
      goldHealth: schema.miningAction.goldHealth,
      goldOre: schema.miningAction.goldOre,
      goldenPickaxeOwned: schema.miningAction.goldenPickaxeOwned,
      health: schema.miningAction.health,
      ironHealth: schema.miningAction.ironHealth,
      ironOre: schema.miningAction.ironOre,
      ironPickaxeOwned: schema.miningAction.ironPickaxeOwned,
      revision: schema.miningAction.revision,
      steelPickaxeOwned: schema.miningAction.steelPickaxeOwned,
      xp: schema.miningAction.xp,
    }
    const result = db.transaction(
      (tx) => {
        const recorded = tx
          .select(actionFields)
          .from(schema.miningAction)
          .where(and(eq(schema.miningAction.actionId, receiptId), eq(schema.miningAction.userId, userId)))
          .get()
        if (recorded) return { progress: recorded }
        tx.insert(schema.miningProgress).values({ userId }).onConflictDoNothing().run()
        const owned = tx
          .select({
            golden: schema.miningProgress.goldenPickaxeOwned,
            iron: schema.miningProgress.ironPickaxeOwned,
            steel: schema.miningProgress.steelPickaxeOwned,
          })
          .from(schema.miningProgress)
          .where(eq(schema.miningProgress.userId, userId))
          .get()
        if (
          !owned ||
          (pickaxeId === 'iron' && !owned.iron) ||
          (pickaxeId === 'steel' && !owned.steel) ||
          (pickaxeId === 'golden' && !owned.golden)
        ) {
          return { error: 'Pickaxe is not owned', status: 409 as const }
        }
        const saved = tx
          .update(schema.miningProgress)
          .set({ equippedPickaxe: pickaxeId, revision: sql`${schema.miningProgress.revision} + 1` })
          .where(eq(schema.miningProgress.userId, userId))
          .returning(fields)
          .get()
        if (!saved) throw new Error('Could not equip pickaxe')
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
