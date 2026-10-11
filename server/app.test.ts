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
  const initial = { coins: 0, copper: 0, health: 10, ironPickaxeOwned: false, revision: 0, xp: 0 }
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
      health: hit === 4 ? 10 : 10 - (hit + 1) * 2,
      ironPickaxeOwned: false,
      revision: hit + 1,
      xp: hit === 4 ? 10 : 0,
    })
  }
  const broken = { coins: 0, copper: 2, health: 10, ironPickaxeOwned: false, revision: 5, xp: 10 }
  expect(await (await request('/api/mining', { actionId: actionIds[4] }, firstCookie)).json()).toEqual(broken)
  // Replaying an older hit returns its original result without changing current progress.
  expect(await (await request('/api/mining', { actionId: actionIds[0] }, firstCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    health: 8,
    ironPickaxeOwned: false,
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
      health: 8,
      ironPickaxeOwned: false,
      revision: 6,
      xp: 10,
    })
  }
  const hits = await Promise.all(
    Array.from({ length: 5 }, () => request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)),
  )
  expect(hits.every((response) => response.status === 200)).toBe(true)
  const saved = { coins: 0, copper: 4, health: 8, ironPickaxeOwned: false, revision: 11, xp: 20 }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(saved)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual(initial)
  expect(await (await request('/api/mining', { actionId }, secondCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    health: 8,
    ironPickaxeOwned: false,
    revision: 1,
    xp: 0,
  })
  expect((await request('/api/mining', { actionId }, firstCookie, 'https://attacker.example')).status).toBe(403)

  // Reach the breaking hit, then fail its receipt to exercise reward rollback too.
  for (let hit = 0; hit < 3; hit++) {
    expect((await request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)).status).toBe(200)
  }
  const beforeFailure = { coins: 0, copper: 4, health: 2, ironPickaxeOwned: false, revision: 14, xp: 20 }
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
    health: 10,
    ironPickaxeOwned: false,
    revision: 15,
    xp: 30,
  })

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({
    coins: 0,
    copper: 6,
    health: 10,
    ironPickaxeOwned: false,
    revision: 15,
    xp: 30,
  })
  expect(await (await request('/api/mining', { actionId: actionIds[4] }, firstCookie)).json()).toEqual(broken)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual({
    coins: 0,
    copper: 0,
    health: 8,
    ironPickaxeOwned: false,
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
  const beforeSale = { coins: 0, copper: 2, health: 10, ironPickaxeOwned: false, revision: 5, xp: 10 }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(beforeSale)
  const saleId = miningActionIds[4]
  const saleRequest = {
    actionId: saleId,
    coins: 999999,
    copper: 0,
    price: 999999,
    walletAddress: other.address,
  }
  const sold = { coins: 10, copper: 0, health: 10, ironPickaxeOwned: false, revision: 6, xp: 10 }
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
    { coins: 10, copper: 2, health: 10, ironPickaxeOwned: false, revision: 12, xp: 20 },
    { coins: 20, copper: 0, health: 10, ironPickaxeOwned: false, revision: 12, xp: 20 },
  ]).toContainEqual(afterConcurrentActions)
  expect(afterConcurrentActions.copper * 5 + afterConcurrentActions.coins).toBe(20)
  const recordedSale = await (await request('/api/mining/sell', { actionId: nextSaleId }, firstCookie)).json()
  expect([
    afterConcurrentActions,
    { coins: 10, copper: 0, health: 2, ironPickaxeOwned: false, revision: 11, xp: 10 },
  ]).toContainEqual(recordedSale)

  const secondMiningIds = Array.from({ length: 5 }, () => crypto.randomUUID())
  for (const actionId of secondMiningIds) {
    expect((await request('/api/mining', { actionId }, secondCookie)).status).toBe(200)
  }
  const secondBeforeSale = { coins: 0, copper: 2, health: 10, ironPickaxeOwned: false, revision: 5, xp: 10 }
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual(secondBeforeSale)
  expect(await (await request('/api/mining/sell', { actionId: saleId }, secondCookie)).json()).toEqual({
    copper: 0,
    coins: 10,
    health: 10,
    ironPickaxeOwned: false,
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
    coins: 10,
    health: 10,
    ironPickaxeOwned: false,
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
    health: 10,
    ironPickaxeOwned: false,
    revision: 0,
    xp: 0,
  })
  const unaffordableId = crypto.randomUUID()
  expect((await request('/api/mining/upgrade/iron-pickaxe', { actionId: unaffordableId }, secondCookie)).status).toBe(
    409,
  )
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toMatchObject({
    coins: 0,
    ironPickaxeOwned: false,
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
    ironPickaxeOwned: false,
  })

  const purchaseId = crypto.randomUUID()
  const purchaseRequest = { actionId: purchaseId, coins: 0, cost: 0, damage: 100 }
  const purchase = {
    coins: 0,
    copper: 0,
    health: 6,
    ironPickaxeOwned: true,
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
    ironPickaxeOwned: true,
    revision: 12,
  })
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toMatchObject({
    coins: 0,
    ironPickaxeOwned: false,
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
