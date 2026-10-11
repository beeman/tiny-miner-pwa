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
  async function login(wallet: typeof signer) {
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
  const firstCookie = await login(signer)
  const secondCookie = await login(other)
  expect((await request('/api/mining')).status).toBe(401)
  expect((await request('/api/mining', {})).status).toBe(401)
  expect((await request('/api/mining', {}, 'better-auth.session_token=forged')).status).toBe(401)
  const initial = { copper: 0, health: 10, revision: 0, xp: 0 }
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
      copper: hit === 4 ? 2 : 0,
      health: hit === 4 ? 10 : 10 - (hit + 1) * 2,
      revision: hit + 1,
      xp: hit === 4 ? 10 : 0,
    })
  }
  const broken = { copper: 2, health: 10, revision: 5, xp: 10 }
  expect(await (await request('/api/mining', { actionId: actionIds[4] }, firstCookie)).json()).toEqual(broken)
  // Replaying an older hit returns its original result without changing current progress.
  expect(await (await request('/api/mining', { actionId: actionIds[0] }, firstCookie)).json()).toEqual({
    copper: 0,
    health: 8,
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
    expect(await response.json()).toEqual({ copper: 2, health: 8, revision: 6, xp: 10 })
  }
  const hits = await Promise.all(
    Array.from({ length: 5 }, () => request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)),
  )
  expect(hits.every((response) => response.status === 200)).toBe(true)
  const saved = { copper: 4, health: 8, revision: 11, xp: 20 }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(saved)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual(initial)
  expect(await (await request('/api/mining', { actionId }, secondCookie)).json()).toEqual({
    copper: 0,
    health: 8,
    revision: 1,
    xp: 0,
  })
  expect((await request('/api/mining', { actionId }, firstCookie, 'https://attacker.example')).status).toBe(403)

  // Reach the breaking hit, then fail its receipt to exercise reward rollback too.
  for (let hit = 0; hit < 3; hit++) {
    expect((await request('/api/mining', { actionId: crypto.randomUUID() }, firstCookie)).status).toBe(200)
  }
  const beforeFailure = { copper: 4, health: 2, revision: 14, xp: 20 }
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(beforeFailure)
  const failedId = crypto.randomUUID()
  database.exec(`CREATE TRIGGER fail_mining_action BEFORE INSERT ON mining_action
    WHEN NEW.action_id = '${failedId}' BEGIN SELECT RAISE(ABORT, 'test action failure'); END`)
  expect((await request('/api/mining', { actionId: failedId }, firstCookie)).status).toBe(500)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual(beforeFailure)
  database.exec('DROP TRIGGER fail_mining_action')
  expect(await (await request('/api/mining', { actionId: failedId }, firstCookie)).json()).toEqual({
    copper: 6,
    health: 10,
    revision: 15,
    xp: 30,
  })

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({
    copper: 6,
    health: 10,
    revision: 15,
    xp: 30,
  })
  expect(await (await request('/api/mining', { actionId: actionIds[4] }, firstCookie)).json()).toEqual(broken)
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual({
    copper: 0,
    health: 8,
    revision: 1,
    xp: 0,
  })
  expect((await request('/api/auth/sign-out', {}, firstCookie)).status).toBe(200)
  expect((await request('/api/mining', undefined, firstCookie)).status).toBe(401)
  expect((await request('/api/mining', { actionId }, firstCookie)).status).toBe(401)
})
