import { createAuthClient } from 'better-auth/react'
import { siwsClient } from 'better-auth-solana/client'

export const authClient = createAuthClient({ plugins: [siwsClient()] })
