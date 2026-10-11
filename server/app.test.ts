import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { generateKeyPairSigner, getBase58Decoder } from '@solana/kit'
import { createSIWSMessage, type SIWSNonceResponse } from 'better-auth-solana/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from './app'

const origin = 'http://localhost:5173'
const secret = 'test-only-session-secret-at-least-32-characters'
const directory = mkdtempSync(join(tmpdir(), 'tiny-miner-auth-'))
const path = join(directory, 'test.sqlite')
let database = new Database(path)
let app = createApp({ database, origin, secret })
let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>

beforeAll(async () => {
  signer = await generateKeyPairSigner()
})
afterAll(() => {
  database.close()
  rmSync(directory, { recursive: true })
})

async function request(path: string, body?: object, cookie?: string, requestOrigin = origin) {
  return app.request(`${origin}${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), Origin: requestOrigin },
    method: body ? 'POST' : 'GET',
  })
}

async function challenge() {
  const response = await request('/api/auth/siws/nonce', { walletAddress: signer.address })
  expect(response.status).toBe(200)
  const nonce: SIWSNonceResponse = await response.json()
  return createSIWSMessage({ address: signer.address, challenge: nonce, statement: 'Sign in to Tiny Miner.' })
}

async function sign(message: string, keypair = signer.keyPair) {
  const signature = await crypto.subtle.sign('Ed25519', keypair.privateKey, new TextEncoder().encode(message))
  return getBase58Decoder().decode(new Uint8Array(signature))
}

function verify(message: string, signature: string) {
  return request('/api/auth/siws/verify', { message, signature, walletAddress: signer.address })
}

async function login(wallet: Awaited<ReturnType<typeof generateKeyPairSigner>>) {
  const nonceResponse = await request('/api/auth/siws/nonce', { walletAddress: wallet.address })
  const nonce: SIWSNonceResponse = await nonceResponse.json()
  const message = createSIWSMessage({ address: wallet.address, challenge: nonce })
  const response = await request('/api/auth/siws/verify', {
    message,
    signature: await sign(message, wallet.keyPair),
    walletAddress: wallet.address,
  })
  expect(response.status).toBe(200)
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
}

test('rejects unauthenticated requests and forged session cookies', async () => {
  expect((await request('/api/me')).status).toBe(401)
  expect((await request('/api/me', undefined, 'better-auth.session_token=forged')).status).toBe(401)
})

test('rejects an invalid signature, a different signing key, and altered challenge fields', async () => {
  const message = await challenge()
  const other = await generateKeyPairSigner()
  expect((await verify(message, await sign(message, other.keyPair))).status).toBe(401)
  expect((await verify(message, 'invalid')).status).toBe(400)
  for (const [from, to] of [
    ['Nonce: ', 'Nonce: altered'],
    ['URI: http://localhost:5173', 'URI: https://attacker.example'],
    ['localhost:5173', 'attacker.example'],
  ]) {
    const altered = message.replace(from, to)
    expect((await verify(altered, await sign(altered))).status).toBe(401)
  }
  expect((await request('/api/me')).status).toBe(401)
})

test('rejects expired challenges and untrusted origins', async () => {
  const message = await challenge()
  database.query('UPDATE verification SET expires_at = ?').run(Date.now() - 1000)
  expect((await verify(message, await sign(message))).status).toBe(401)
  expect(
    (await request('/api/auth/siws/nonce', { walletAddress: signer.address }, undefined, 'https://attacker.example'))
      .status,
  ).toBe(403)
})

test('validates a real signature, rejects replay, restores a persisted session, and revokes it on sign-out', async () => {
  const message = await challenge()
  const signature = await sign(message)
  const response = await verify(message, signature)
  expect(response.status).toBe(200)
  const setCookie = response.headers.get('set-cookie') ?? ''
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie.toLowerCase()).toContain('samesite=lax')
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  expect(cookie).toContain('session_token=')
  expect(await (await request('/api/me', undefined, cookie)).json()).toEqual({ walletAddress: signer.address })
  expect((await verify(message, signature)).status).toBe(401)

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/me', undefined, cookie)).json()).toEqual({ walletAddress: signer.address })
  expect((await request('/api/auth/get-session', undefined, cookie)).status).toBe(200)
  expect((await request('/api/auth/sign-out', {}, cookie)).status).toBe(200)
  expect((await request('/api/me', undefined, cookie)).status).toBe(401)
  expect((await request('/api/me')).status).toBe(401)
})

test('rock damage and rewards are atomic, idempotent, isolated by wallet, persistent, and require a session', async () => {
  const other = await generateKeyPairSigner()
  const firstCookie = await login(signer)
  const secondCookie = await login(other)
  expect((await request('/api/mining')).status).toBe(401)
  expect((await request('/api/mining', {})).status).toBe(401)
  expect((await request('/api/mining', {}, 'better-auth.session_token=forged')).status).toBe(401)
  const initial = {
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 0,
    xp: 0,
  }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(initial)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual(initial)
  expect((await request('/api/mining', {}, firstCookie)).status).toBe(400)
  expect((await request('/api/mining', { actionId: 'invalid' }, firstCookie)).status).toBe(400)

  const actionIds = Array.from({ length: 5 }, () => crypto.randomUUID())
  for (let hit = 0; hit < 5; hit++) {
    const response = await request(
      '/api/mining',
      { actionId: actionIds[hit], copper: 9999, damage: 10, health: 0, walletAddress: other.address, xp: 9999 },
      firstCookie,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      coins: 0,
      copper: hit === 4 ? 2 : 0,
      crystalHealth: 40,
      crystalOre: 0,
      goldHealth: 30,
      goldOre: 0,
      health: hit === 4 ? 10 : 10 - (hit + 1) * 2,
      ironHealth: 20,
      ironOre: 0,
      equippedPickaxe: 'wooden',
      goldenPickaxeOwned: false,
      ironPickaxeOwned: false,
      steelPickaxeOwned: false,
      revision: hit + 1,
      xp: hit === 4 ? 10 : 0,
    })
  }
  const broken = {
    coins: 0,
    copper: 2,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 5,
    xp: 10,
  }
  expect(await (await request('/api/mining', { actionId: actionIds[4] }, firstCookie)).json()).toEqual(broken)
  // Replaying an older hit returns its original result without changing current progress.
  expect(await (await request('/api/mining', { actionId: actionIds[0] }, firstCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 8,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 1,
    xp: 0,
  })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(broken)

  const actionId = crypto.randomUUID()
  const duplicates = await Promise.all(
    Array.from({ length: 10 }, () => request('/api/mining', { actionId }, firstCookie)),
  )
  expect(duplicates.every((response) => response.status === 200)).toBe(true)
  for (const response of duplicates) {
    expect(await response.json()).toEqual({
      coins: 0,
      copper: 2,
      crystalHealth: 40,
      crystalOre: 0,
      goldHealth: 30,
      goldOre: 0,
      health: 8,
      ironHealth: 20,
      ironOre: 0,
      equippedPickaxe: 'wooden',
      goldenPickaxeOwned: false,
      ironPickaxeOwned: false,
      steelPickaxeOwned: false,
      revision: 6,
      xp: 10,
    })
  }
  const hits = await Promise.all(
    Array.from({ length: 5 }, () => request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)),
  )
  expect(hits.every((response) => response.status === 200)).toBe(true)
  const saved = {
    coins: 0,
    copper: 4,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 8,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 11,
    xp: 20,
  }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(saved)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual(initial)
  expect(await (await request('/api/mining', { actionId }, secondCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 8,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 1,
    xp: 0,
  })
  expect((await request('/api/mining', { actionId }, firstCookie, 'https://attacker.example')).status).toBe(403)

  // Reach the breaking hit, then fail its receipt to exercise reward rollback too.
  for (let hit = 0; hit < 3; hit++) {
    expect((await request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)).status).toBe(200)
  }
  const beforeFailure = {
    coins: 0,
    copper: 4,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 2,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 14,
    xp: 20,
  }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(beforeFailure)
  const failedId = crypto.randomUUID()
  database.exec(`CREATE TRIGGER fail_mining_action BEFORE INSERT ON mining_action
    WHEN NEW.action_id = '${failedId}' BEGIN SELECT RAISE(ABORT, 'test action failure'); END`)
  expect((await request('/api/mining', { actionId: failedId }, firstCookie)).status).toBe(500)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(beforeFailure)
  database.exec('DROP TRIGGER fail_mining_action')
  expect(await (await request('/api/mining', { actionId: failedId }, firstCookie)).json()).toEqual({
    coins: 0,
    copper: 6,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 15,
    xp: 30,
  })

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({
    coins: 0,
    copper: 6,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 15,
    xp: 30,
  })
  expect(await (await request('/api/mining', { actionId: actionIds[4] }, firstCookie)).json()).toEqual(broken)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 8,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 1,
    xp: 0,
  })
  expect((await request('/api/auth/sign-out', {}, firstCookie)).status).toBe(200)
  expect((await request('/api/mining', undefined, firstCookie)).status).toBe(401)
  expect((await request('/api/mining', { actionId }, firstCookie)).status).toBe(401)
})

test('selling copper is atomic, idempotent, isolated, concurrent with mining, and persistent', async () => {
  const first = await generateKeyPairSigner()
  const other = await generateKeyPairSigner()
  const firstCookie = await login(first)
  const secondCookie = await login(other)

  expect((await request('/api/mining/sell', { actionId: crypto.randomUUID() })).status).toBe(401)
  expect(
    (await request('/api/mining/sell', { actionId: crypto.randomUUID() }, 'better-auth.session_token=forged')).status,
  ).toBe(401)

  const miningActionIds = Array.from({ length: 5 }, () => crypto.randomUUID())
  for (const actionId of miningActionIds) {
    expect((await request('/api/mining', { actionId }, firstCookie)).status).toBe(200)
  }
  const beforeSale = {
    coins: 0,
    copper: 2,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 5,
    xp: 10,
  }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(beforeSale)
  const saleId = miningActionIds[4]
  const saleRequest = {
    actionId: saleId,
    coins: 999999,
    copper: 0,
    price: 999999,
    walletAddress: other.address,
  }
  const sold = {
    coins: 10,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 6,
    xp: 10,
  }
  const duplicateSales = await Promise.all(
    Array.from({ length: 10 }, () => request('/api/mining/sell', saleRequest, firstCookie)),
  )
  expect(duplicateSales.every((response) => response.status === 200)).toBe(true)
  for (const response of duplicateSales) expect(await response.json()).toEqual(sold)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(sold)

  for (let hit = 0; hit < 4; hit++) {
    expect((await request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)).status).toBe(200)
  }
  const nextSaleId = crypto.randomUUID()
  const miningAndSelling = await Promise.all([
    request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie),
    request('/api/mining/sell', { actionId: nextSaleId }, firstCookie),
  ])
  expect(miningAndSelling.every((response) => response.status === 200)).toBe(true)
  const afterConcurrentActions = await (await request('/api/mining', undefined, firstCookie)).json()
  expect([
    {
      coins: 10,
      copper: 2,
      crystalHealth: 40,
      crystalOre: 0,
      goldHealth: 30,
      goldOre: 0,
      health: 10,
      ironHealth: 20,
      ironOre: 0,
      equippedPickaxe: 'wooden',
      goldenPickaxeOwned: false,
      ironPickaxeOwned: false,
      steelPickaxeOwned: false,
      revision: 12,
      xp: 20,
    },
    {
      coins: 20,
      copper: 0,
      crystalHealth: 40,
      crystalOre: 0,
      goldHealth: 30,
      goldOre: 0,
      health: 10,
      ironHealth: 20,
      ironOre: 0,
      equippedPickaxe: 'wooden',
      goldenPickaxeOwned: false,
      ironPickaxeOwned: false,
      steelPickaxeOwned: false,
      revision: 12,
      xp: 20,
    },
  ]).toContainEqual(afterConcurrentActions)
  expect(afterConcurrentActions.copper * 5 + afterConcurrentActions.coins).toBe(20)
  const recordedSale = await (await request('/api/mining/sell', { actionId: nextSaleId }, firstCookie)).json()
  expect([
    afterConcurrentActions,
    {
      coins: 10,
      copper: 0,
      crystalHealth: 40,
      crystalOre: 0,
      goldHealth: 30,
      goldOre: 0,
      health: 2,
      ironHealth: 20,
      ironOre: 0,
      equippedPickaxe: 'wooden',
      goldenPickaxeOwned: false,
      ironPickaxeOwned: false,
      steelPickaxeOwned: false,
      revision: 11,
      xp: 10,
    },
  ]).toContainEqual(recordedSale)

  const secondMiningIds = Array.from({ length: 5 }, () => crypto.randomUUID())
  for (const actionId of secondMiningIds) {
    expect((await request('/api/mining', { actionId }, secondCookie)).status).toBe(200)
  }
  const secondBeforeSale = {
    coins: 0,
    copper: 2,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 5,
    xp: 10,
  }
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual(secondBeforeSale)
  expect(await (await request('/api/mining/sell', { actionId: saleId }, secondCookie)).json()).toEqual({
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    coins: 10,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 6,
    xp: 10,
  })

  expect(
    (await request('/api/mining/sell', { actionId: saleId }, firstCookie, 'https://attacker.example')).status,
  ).toBe(403)
  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(afterConcurrentActions)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual({
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    coins: 10,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 6,
    xp: 10,
  })
  expect(await (await request('/api/mining/sell', { actionId: saleId }, firstCookie)).json()).toEqual(sold)
})

test('iron pickaxe purchases are server-priced, idempotent, isolated, and persistent', async () => {
  const first = await generateKeyPairSigner()
  const second = await generateKeyPairSigner()
  const third = await generateKeyPairSigner()
  const firstCookie = await login(first)
  const secondCookie = await login(second)
  const thirdCookie = await login(third)

  expect((await request('/api/mining/upgrade/iron-pickaxe', { actionId: crypto.randomUUID() })).status).toBe(401)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 0,
    xp: 0,
  })
  const unaffordableId = crypto.randomUUID()
  expect((await request('/api/mining/upgrade/iron-pickaxe', { actionId: unaffordableId }, secondCookie)).status).toBe(
    409,
  )
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toMatchObject({
    coins: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
  })

  async function earnTwenty(walletCookie: string) {
    for (let hit = 0; hit < 10; hit++) {
      expect((await request('/api/mining', { actionId: crypto.randomUUID() }, walletCookie)).status).toBe(200)
    }
    expect((await request('/api/mining/sell', { actionId: crypto.randomUUID() }, walletCookie)).status).toBe(200)
  }

  await earnTwenty(firstCookie)
  for (let hit = 0; hit < 2; hit++) {
    expect((await request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)).status).toBe(200)
  }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({
    coins: 20,
    health: 6,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
  })

  const purchaseId = crypto.randomUUID()
  const purchaseRequest = { actionId: purchaseId, coins: 0, cost: 0, damage: 100 }
  const purchase = {
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 6,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'iron',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: true,
    steelPickaxeOwned: false,
    revision: 14,
    xp: 20,
  }
  const duplicatePurchases = await Promise.all(
    Array.from({ length: 10 }, () => request('/api/mining/upgrade/iron-pickaxe', purchaseRequest, firstCookie)),
  )
  expect(duplicatePurchases.every((response) => response.status === 200)).toBe(true)
  for (const response of duplicatePurchases) expect(await response.json()).toEqual(purchase)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(purchase)

  const upgradedHit = await request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)
  expect(await upgradedHit.json()).toEqual({ ...purchase, health: 3, revision: 15 })

  await earnTwenty(thirdCookie)
  const competingPurchases = await Promise.all([
    request('/api/mining/upgrade/iron-pickaxe', { actionId: crypto.randomUUID() }, thirdCookie),
    request('/api/mining/upgrade/iron-pickaxe', { actionId: crypto.randomUUID() }, thirdCookie),
  ])
  expect(competingPurchases.map((response) => response.status).sort()).toEqual([200, 409])
  expect(await (await request('/api/mining', undefined, thirdCookie)).json()).toMatchObject({
    coins: 0,
    equippedPickaxe: 'iron',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: true,
    steelPickaxeOwned: false,
    revision: 12,
  })
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toMatchObject({
    coins: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
  })

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({
    ...purchase,
    health: 3,
    revision: 15,
  })
  expect(await (await request('/api/mining/upgrade/iron-pickaxe', purchaseRequest, firstCookie)).json()).toEqual(
    purchase,
  )
  expect((await request('/api/mining', undefined)).status).toBe(401)
})

test('Iron Mine is locked until level two and preserves both mine states through mining, sales, and reload', async () => {
  const first = await generateKeyPairSigner()
  const second = await generateKeyPairSigner()
  const firstCookie = await login(first)
  const secondCookie = await login(second)

  const locked = await request(
    '/api/mining',
    { actionId: crypto.randomUUID(), mineId: 'iron', xp: 999999 },
    firstCookie,
  )
  expect(locked.status).toBe(403)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 0,
    xp: 0,
  })

  for (let hit = 0; hit < 50; hit++) {
    const response = await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)
    expect(response.status).toBe(200)
  }
  let progress = await (await request('/api/mining', undefined, firstCookie)).json()
  expect(progress).toMatchObject({ copper: 20, health: 10, ironHealth: 20, ironOre: 0, xp: 100 })

  for (let hit = 0; hit < 2; hit++) {
    await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)
  }
  const ironHit = { actionId: crypto.randomUUID(), mineId: 'iron' }
  const firstIronHit = await request('/api/mining', ironHit, firstCookie)
  expect(firstIronHit.status).toBe(200)
  const ironHitResult = await firstIronHit.json()
  expect(await (await request('/api/mining', ironHit, firstCookie)).json()).toEqual(ironHitResult)
  progress = await (await request('/api/mining', undefined, firstCookie)).json()
  expect(progress).toMatchObject({ copper: 20, health: 6, ironHealth: 18, ironOre: 0, xp: 100 })

  await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)
  progress = await (await request('/api/mining', undefined, firstCookie)).json()
  expect(progress).toMatchObject({ health: 4, ironHealth: 18, xp: 100 })
  for (let hit = 0; hit < 9; hit++) {
    await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'iron' }, firstCookie)
  }
  progress = await (await request('/api/mining', undefined, firstCookie)).json()
  expect(progress).toMatchObject({ copper: 20, health: 4, ironHealth: 20, ironOre: 2, xp: 110 })

  const saleId = crypto.randomUUID()
  const saleRequest = { actionId: saleId, coins: 999999, ironPrice: 1, copperPrice: 999999 }
  const sold = await request('/api/mining/sell', saleRequest, firstCookie)
  expect(sold.status).toBe(200)
  const soldProgress = await sold.json()
  expect(soldProgress).toMatchObject({ coins: 120, copper: 0, health: 4, ironHealth: 20, ironOre: 0, xp: 110 })
  expect(await (await request('/api/mining/sell', saleRequest, firstCookie)).json()).toEqual(soldProgress)
  expect((await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'iron' }, secondCookie)).status).toBe(
    403,
  )

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(soldProgress)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 0,
    xp: 0,
  })
})

test('Gold Mine and Crystal Cavern unlock by level, preserve damage, reward ores, and sell at server prices', async () => {
  const first = await generateKeyPairSigner()
  const second = await generateKeyPairSigner()
  const firstCookie = await login(first)
  const secondCookie = await login(second)
  const reusedActionId = crypto.randomUUID()
  const hit = (mineId: 'copper' | 'crystal' | 'gold' | 'iron', cookie = firstCookie, actionId = crypto.randomUUID()) =>
    request('/api/mining', { actionId, mineId }, cookie)

  expect((await request('/api/mining')).status).toBe(401)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: false,
    ironPickaxeOwned: false,
    steelPickaxeOwned: false,
    revision: 0,
    xp: 0,
  })
  for (const mineId of ['gold', 'crystal'] as const) {
    expect(
      (await request('/api/mining', { actionId: reusedActionId, level: 99, mineId, xp: 999999 }, firstCookie)).status,
    ).toBe(403)
  }

  for (let count = 0; count < 50; count++) {
    const response = await hit('copper', firstCookie, count === 0 ? reusedActionId : undefined)
    expect(response.status).toBe(200)
  }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({
    copper: 20,
    crystalHealth: 40,
    goldHealth: 30,
    health: 10,
    xp: 100,
  })
  expect((await hit('gold', firstCookie, reusedActionId)).status).toBe(403)
  expect((await hit('crystal', firstCookie, reusedActionId)).status).toBe(403)

  await hit('copper')
  const ironHit = await hit('iron', firstCookie, reusedActionId)
  expect(ironHit.status).toBe(200)
  const savedIronHit = await ironHit.json()
  expect(await (await hit('iron', firstCookie, reusedActionId)).json()).toEqual(savedIronHit)
  expect(savedIronHit).toMatchObject({ health: 8, ironHealth: 18, xp: 100 })

  for (let count = 0; count < 50; count++) expect((await hit('copper')).status).toBe(200)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({
    copper: 40,
    health: 8,
    xp: 200,
  })
  expect((await hit('crystal', firstCookie, reusedActionId)).status).toBe(403)
  const firstGoldHit = await hit('gold', firstCookie, reusedActionId)
  expect(firstGoldHit.status).toBe(200)
  const savedGoldHit = await firstGoldHit.json()
  expect(await (await hit('gold', firstCookie, reusedActionId)).json()).toEqual(savedGoldHit)
  expect(savedGoldHit).toMatchObject({ goldHealth: 28, goldOre: 0, xp: 200 })
  await hit('iron')
  for (let count = 0; count < 14; count++) expect((await hit('gold')).status).toBe(200)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({
    goldHealth: 30,
    goldOre: 2,
    xp: 210,
  })

  for (let count = 0; count < 45; count++) expect((await hit('copper')).status).toBe(200)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({
    copper: 58,
    crystalHealth: 40,
    goldHealth: 30,
    health: 8,
    ironHealth: 16,
    xp: 300,
  })
  const firstCrystalHit = await hit('crystal', firstCookie, reusedActionId)
  expect(firstCrystalHit.status).toBe(200)
  const savedCrystalHit = await firstCrystalHit.json()
  expect(await (await hit('crystal', firstCookie, reusedActionId)).json()).toEqual(savedCrystalHit)
  expect(savedCrystalHit).toMatchObject({ crystalHealth: 38, crystalOre: 0, xp: 300 })
  await hit('gold')
  await hit('gold')
  const unfinishedProgress = await (await request('/api/mining', undefined, firstCookie)).json()
  expect(unfinishedProgress).toMatchObject({
    copper: 58,
    crystalHealth: 38,
    crystalOre: 0,
    goldHealth: 26,
    goldOre: 2,
    health: 8,
    ironHealth: 16,
    ironOre: 0,
    xp: 300,
  })

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(unfinishedProgress)

  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({
    goldHealth: 26,
    goldOre: 2,
    xp: 300,
  })
  for (let count = 0; count < 19; count++) expect((await hit('crystal')).status).toBe(200)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({
    crystalHealth: 40,
    crystalOre: 2,
    xp: 310,
  })
  for (let count = 0; count < 8; count++) expect((await hit('iron')).status).toBe(200)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({
    ironHealth: 20,
    ironOre: 2,
    xp: 320,
  })

  const saleRequest = {
    actionId: crypto.randomUUID(),
    copperPrice: 1,
    crystalPrice: 1,
    goldPrice: 1,
    ironPrice: 1,
    price: 1,
  }
  const soldResponse = await request('/api/mining/sell', saleRequest, firstCookie)
  expect(soldResponse.status).toBe(200)
  const sold = await soldResponse.json()
  expect(sold).toMatchObject({
    coins: 460,
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 26,
    goldOre: 0,
    health: 8,
    ironHealth: 20,
    ironOre: 0,
    xp: 320,
  })
  expect(await (await request('/api/mining/sell', saleRequest, firstCookie)).json()).toEqual(sold)
  expect((await hit('crystal', secondCookie, reusedActionId)).status).toBe(403)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toMatchObject({
    copper: 0,
    crystalHealth: 40,
    crystalOre: 0,
    goldHealth: 30,
    goldOre: 0,
    health: 10,
    ironHealth: 20,
    ironOre: 0,
    xp: 0,
  })

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(sold)
})

test('Steel and Golden Pickaxes are server-priced, equip only when owned, preserve rock health, and persist', async () => {
  const first = await generateKeyPairSigner()
  const second = await generateKeyPairSigner()
  const firstCookie = await login(first)
  const secondCookie = await login(second)
  const equip = (pickaxeId: string, cookie = firstCookie, actionId = crypto.randomUUID()) =>
    request('/api/mining/equip', { actionId, pickaxeId }, cookie)
  const buy = (pickaxeId: string, cookie = firstCookie, actionId = crypto.randomUUID()) =>
    request(`/api/mining/upgrade/${pickaxeId}-pickaxe`, { actionId, cost: 0, damage: 999 }, cookie)
  const mineCopper = (cookie: string, hits: number) =>
    Promise.all(
      Array.from({ length: hits }, () =>
        request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, cookie),
      ),
    )
  const sell = (cookie: string) => request('/api/mining/sell', { actionId: crypto.randomUUID() }, cookie)

  expect((await request('/api/mining/upgrade/steel-pickaxe', { actionId: crypto.randomUUID() })).status).toBe(401)
  expect((await request('/api/mining/equip', { actionId: crypto.randomUUID(), pickaxeId: 'golden' })).status).toBe(401)
  expect((await equip('iron', secondCookie)).status).toBe(409)
  expect((await equip('steel')).status).toBe(409)
  expect((await buy('steel')).status).toBe(409)
  expect((await buy('golden')).status).toBe(409)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({ coins: 0 })

  await mineCopper(firstCookie, 50)
  await sell(firstCookie)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({ coins: 100 })
  await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)
  const ironPurchaseId = crypto.randomUUID()
  const ironPurchases = await Promise.all(Array.from({ length: 6 }, () => buy('iron', firstCookie, ironPurchaseId)))
  expect(ironPurchases.every((response) => response.status === 200)).toBe(true)
  const ironPurchase = await ironPurchases[0].json()
  expect(ironPurchase).toMatchObject({ coins: 80, equippedPickaxe: 'iron', health: 8, ironPickaxeOwned: true })
  for (const response of ironPurchases.slice(1)) expect(await response.json()).toEqual(ironPurchase)
  expect(
    await (await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)).json(),
  ).toMatchObject({
    coins: 80,
    equippedPickaxe: 'iron',
    health: 5,
  })
  await mineCopper(firstCookie, 5)
  await mineCopper(firstCookie, 5)
  await sell(firstCookie)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({ coins: 110, health: 10 })

  const steelPurchaseId = crypto.randomUUID()
  const steelPurchases = await Promise.all(Array.from({ length: 6 }, () => buy('steel', firstCookie, steelPurchaseId)))
  expect(steelPurchases.every((response) => response.status === 200)).toBe(true)
  const steelPurchase = await steelPurchases[0].json()
  expect(steelPurchase).toMatchObject({ coins: 10, equippedPickaxe: 'steel', health: 10, steelPickaxeOwned: true })
  for (const response of steelPurchases.slice(1)) expect(await response.json()).toEqual(steelPurchase)
  expect(
    await (await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)).json(),
  ).toMatchObject({
    equippedPickaxe: 'steel',
    health: 5,
  })
  await mineCopper(firstCookie, 60)
  await sell(firstCookie)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toMatchObject({ coins: 310, health: 5 })
  await equip('iron')
  await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)

  const goldenPurchaseId = crypto.randomUUID()
  const goldenPurchases = await Promise.all(
    Array.from({ length: 6 }, () => buy('golden', firstCookie, goldenPurchaseId)),
  )
  expect(goldenPurchases.every((response) => response.status === 200)).toBe(true)
  const goldenPurchase = await goldenPurchases[0].json()
  expect(goldenPurchase).toMatchObject({
    coins: 10,
    equippedPickaxe: 'golden',
    goldenPickaxeOwned: true,
    health: 2,
    steelPickaxeOwned: true,
  })
  for (const response of goldenPurchases.slice(1)) expect(await response.json()).toEqual(goldenPurchase)
  expect(
    await (await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)).json(),
  ).toMatchObject({
    equippedPickaxe: 'golden',
    health: 10,
  })
  expect(await (await equip('steel')).json()).toMatchObject({ equippedPickaxe: 'steel', health: 10 })
  expect(
    await (await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)).json(),
  ).toMatchObject({
    equippedPickaxe: 'steel',
    health: 5,
  })
  expect(await (await equip('iron')).json()).toMatchObject({ equippedPickaxe: 'iron', health: 5 })
  expect(
    await (await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)).json(),
  ).toMatchObject({
    equippedPickaxe: 'iron',
    health: 2,
  })
  expect(await (await equip('wooden')).json()).toMatchObject({ equippedPickaxe: 'wooden', health: 2 })
  const saved = await (
    await request('/api/mining', { actionId: crypto.randomUUID(), mineId: 'copper' }, firstCookie)
  ).json()
  expect(saved).toMatchObject({
    equippedPickaxe: 'wooden',
    goldenPickaxeOwned: true,
    health: 10,
    steelPickaxeOwned: true,
  })

  await mineCopper(secondCookie, 150)
  await sell(secondCookie)
  const competingPurchases = await Promise.all([buy('golden', secondCookie), buy('golden', secondCookie)])
  expect(competingPurchases.map((response) => response.status).sort()).toEqual([200, 409])
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toMatchObject({
    coins: 0,
    equippedPickaxe: 'golden',
    goldenPickaxeOwned: true,
  })

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(saved)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toMatchObject({
    coins: 0,
    equippedPickaxe: 'golden',
    goldenPickaxeOwned: true,
  })
})
