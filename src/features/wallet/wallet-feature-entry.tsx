import { useConnectedWallet } from '@solana/kit-plugin-wallet/react'
import { PickaxeIcon } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { useAppClient } from '@/features/core/data-access/use-app-client'

import { WalletUiSeekerButton } from './ui/wallet-ui-seeker-button'
import { formatAddress } from './util/format-address'

export function WalletFeatureEntry() {
  const client = useAppClient()
  const connected = useConnectedWallet(client)

  return (
    <Card className="mx-auto w-full max-w-sm text-center">
      <CardHeader className="items-center gap-4 pt-8">
        <PickaxeIcon aria-hidden="true" className="size-12" />
        <h1 className="text-3xl font-bold">Tiny Miner</h1>
        <CardDescription>A little mining adventure. Built for your pocket.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-6 pb-8">
        <p className="text-muted-foreground text-sm">The mine is coming soon. Connect your wallet to get ready.</p>
        <p aria-live="polite" className="text-sm">
          {connected
            ? `Wallet connected: ${formatAddress(connected.account.address)}`
            : 'Use Connect wallet above to begin.'}
        </p>
        {!connected && <WalletUiSeekerButton variant="connect" />}
        <p className="text-muted-foreground text-xs">Web first · Portrait play · Gameplay coming soon</p>
      </CardContent>
    </Card>
  )
}
