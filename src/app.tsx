import { ClusterUiOfflineAlert } from '@/features/cluster/ui/cluster-ui-offline-alert'
import { AppProviders } from '@/features/core/data-access/app-providers'
import { ShellUiPage } from '@/features/shell/ui/shell-ui-page'
import { WalletFeatureEntry } from '@/features/wallet/wallet-feature-entry'

export function App() {
  return (
    <AppProviders>
      <ShellUiPage>
        <ClusterUiOfflineAlert />
        <section
          aria-label="Copper Cave"
          className="relative mx-auto aspect-[720/1280] w-full max-w-sm overflow-hidden rounded-xl"
        >
          <img
            alt=""
            className="absolute inset-0 size-full [image-rendering:pixelated]"
            height={1280}
            src="/copper-cave/cave-background.png"
            width={720}
          />
          <h2 className="absolute inset-x-0 top-[8%] text-center text-2xl font-bold text-amber-100">Copper Cave</h2>
          <img
            alt="Intact copper rock"
            className="pointer-events-none absolute left-[23.33%] top-[46.56%] w-[53.33%] [image-rendering:pixelated]"
            draggable={false}
            height={384}
            src="/copper-cave/copper-rock-intact.png"
            width={384}
          />
          <img
            alt="Wooden pickaxe"
            className="pointer-events-none absolute left-[62.22%] top-[53.75%] w-[35.56%] [image-rendering:pixelated]"
            draggable={false}
            height={256}
            src="/copper-cave/wooden-pickaxe.png"
            width={256}
          />
        </section>
        <WalletFeatureEntry />
      </ShellUiPage>
    </AppProviders>
  )
}
