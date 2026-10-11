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

test('mining counters are server-owned, isolated by wallet, persistent, and require a session', async () => {
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
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({ count: 0 })
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual({ count: 0 })

  // Neither the supplied value nor another wallet address can change the target or increment.
  expect(
    await (await request('/api/mining', { count: 9999, walletAddress: other.address }, firstCookie)).json(),
  ).toEqual({ count: 1 })
  const increments = await Promise.all(Array.from({ length: 10 }, () => request('/api/mining', {}, firstCookie)))
  expect(increments.every((response) => response.status === 200)).toBe(true)
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({ count: 11 })
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual({ count: 0 })
  expect(await (await request('/api/mining', {}, secondCookie)).json()).toEqual({ count: 1 })
  expect((await request('/api/mining', {}, firstCookie, 'https://attacker.example')).status).toBe(403)

  database.close()
  database = new Database(path)
  app = createApp({ database, origin, secret })
  expect(await (await request('/api/mining', undefined, firstCookie)).json()).toEqual({ count: 11 })
  expect(await (await request('/api/mining', undefined, secondCookie)).json()).toEqual({ count: 1 })
  expect((await request('/api/auth/sign-out', {}, firstCookie)).status).toBe(200)
  expect((await request('/api/mining', undefined, firstCookie)).status).toBe(401)
  expect((await request('/api/mining', {}, firstCookie)).status).toBe(401)
})
