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
