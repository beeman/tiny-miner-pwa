import { getBase58Decoder } from '@solana/kit'
import { useSignMessage } from '@solana/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UiWalletAccount } from '@wallet-standard/ui'
import { createSIWSMessage } from 'better-auth-solana/client'

import { Button } from '@/components/ui/button'
import { formatError } from '@/features/wallet/util/format-error'

import { authClient } from './auth-client'
import { useAuthSession } from './use-auth-session'

export function AuthFeatureSession({ account }: { account?: UiWalletAccount }) {
  const queryClient = useQueryClient()
  const identity = useAuthSession()
  const signOut = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut()
      if (result.error) throw new Error(result.error.message ?? 'Could not sign out')
    },
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: ['auth-session'] })
      queryClient.setQueryData(['auth-session'], null)
    },
  })

  if (identity.isPending) return <p className="text-sm">Restoring session…</p>
  if (identity.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {identity.error.message}
      </p>
    )
  if (identity.data) {
    return (
      <div className="flex w-full flex-col gap-3">
        <p aria-live="polite" className="text-sm">
          Signed in as <span className="break-all font-mono">{identity.data.walletAddress}</span>
        </p>
        <Button disabled={signOut.isPending} onClick={() => signOut.mutate()} variant="outline">
          {signOut.isPending ? 'Signing out…' : 'Sign out'}
        </Button>
        {signOut.error && (
          <p role="alert" className="text-destructive text-sm">
            {formatError(signOut.error)}
          </p>
        )}
      </div>
    )
  }
  if (!account) return <p className="text-muted-foreground text-sm">Connect a wallet to sign in.</p>
  if (!account.features.includes('solana:signMessage')) {
    return <p className="text-sm">This wallet does not support message signing.</p>
  }
  return <WalletSignIn account={account} key={account.address} />
}

function WalletSignIn({ account }: { account: UiWalletAccount }) {
  const queryClient = useQueryClient()
  const signMessage = useSignMessage(account)
  const signIn = useMutation({
    mutationFn: async () => {
      const challenge = await authClient.siws.nonce({ walletAddress: account.address })
      if (!challenge.data) throw new Error(challenge.error?.message ?? 'Could not request sign-in challenge')
      const message = createSIWSMessage({
        address: account.address,
        challenge: challenge.data,
        statement: 'Sign in to Tiny Miner.',
      })
      const { signature } = await signMessage({ message: new TextEncoder().encode(message) })
      const result = await authClient.siws.verify({
        message,
        signature: getBase58Decoder().decode(signature),
        walletAddress: account.address,
      })
      if (!result.data) throw new Error(result.error?.message ?? 'Could not verify signature')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth-session'] }),
  })
  return (
    <div className="flex w-full flex-col gap-3">
      <Button disabled={signIn.isPending} onClick={() => signIn.mutate()}>
        {signIn.isPending ? 'Waiting for signature…' : 'Sign in to Tiny Miner'}
      </Button>
      {signIn.error && (
        <p role="alert" className="text-destructive text-sm">
          {formatError(signIn.error)}
        </p>
      )}
    </div>
  )
}
