import { ClusterUiOfflineAlert } from '@/features/cluster/ui/cluster-ui-offline-alert'
import { AppProviders } from '@/features/core/data-access/app-providers'
import { MiningFeatureScene } from '@/features/mining/mining-feature-scene'
import { ShellUiPage } from '@/features/shell/ui/shell-ui-page'
import { WalletFeatureEntry } from '@/features/wallet/wallet-feature-entry'

export function App() {
  return (
    <AppProviders>
      <ShellUiPage>
        <ClusterUiOfflineAlert />
        <MiningFeatureScene />
        <WalletFeatureEntry />
      </ShellUiPage>
    </AppProviders>
  )
}
