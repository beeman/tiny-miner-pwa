import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useAuthSession } from '@/features/auth/use-auth-session'

type MiningProgress = {
  coins: number
  copper: number
  health: number
  ironPickaxeOwned: boolean
  revision: number
  xp: number
}

export function MiningFeatureScene() {
  const identity = useAuthSession()
  const queryClient = useQueryClient()
  const queryKey = ['mining-progress', identity.data?.walletAddress]
  const progress = useQuery({
    enabled: !!identity.data,
    queryFn: async ({ signal }): Promise<MiningProgress> => {
      const response = await fetch('/api/mining', { signal })
      if (!response.ok) throw new Error('Could not load saved progress')
      return response.json()
    },
    queryKey,
    retry: false,
  })
  const mine = useMutation({
    mutationFn: async ({
      actionId,
      walletAddress,
    }: {
      actionId: string
      walletAddress: string
    }): Promise<MiningProgress & { walletAddress: string }> => {
      const response = await fetch('/api/mining', {
        body: JSON.stringify({ actionId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (response.status === 401) {
        await queryClient.invalidateQueries({ queryKey: ['auth-session'] })
        throw new Error('Your session expired. Sign in again.')
      }
      if (!response.ok) throw new Error('Could not confirm this hit. Retry the same hit safely.')
      const saved: MiningProgress = await response.json()
      return { ...saved, walletAddress }
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ['mining-progress'] }),
    onSuccess: async (saved) => {
      const savedKey = ['mining-progress', saved.walletAddress]
      await queryClient.cancelQueries({ queryKey: savedKey })
      queryClient.setQueryData<MiningProgress>(savedKey, (previous) =>
        previous && previous.revision > saved.revision ? previous : saved,
      )
    },
    retry: false,
  })
  const sell = useMutation({
    mutationFn: async ({
      actionId,
      walletAddress,
    }: {
      actionId: string
      walletAddress: string
    }): Promise<MiningProgress & { walletAddress: string }> => {
      const response = await fetch('/api/mining/sell', {
        body: JSON.stringify({ actionId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (response.status === 401) {
        await queryClient.invalidateQueries({ queryKey: ['auth-session'] })
        throw new Error('Your session expired. Sign in again.')
      }
      if (!response.ok) throw new Error('Could not confirm this sale. Retry the same sale safely.')
      const saved: MiningProgress = await response.json()
      return { ...saved, walletAddress }
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ['mining-progress'] }),
    onSuccess: async (saved) => {
      const savedKey = ['mining-progress', saved.walletAddress]
      await queryClient.cancelQueries({ queryKey: savedKey })
      queryClient.setQueryData<MiningProgress>(savedKey, (previous) =>
        previous && previous.revision > saved.revision ? previous : saved,
      )
    },
    retry: false,
  })
  const buyIronPickaxe = useMutation({
    mutationFn: async ({
      actionId,
      walletAddress,
    }: {
      actionId: string
      walletAddress: string
    }): Promise<MiningProgress & { walletAddress: string }> => {
      const response = await fetch('/api/mining/upgrade/iron-pickaxe', {
        body: JSON.stringify({ actionId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (response.status === 401) {
        await queryClient.invalidateQueries({ queryKey: ['auth-session'] })
        throw new Error('Your session expired. Sign in again.')
      }
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(result?.error ?? 'Could not confirm this purchase. Retry safely.')
      }
      const saved: MiningProgress = await response.json()
      return { ...saved, walletAddress }
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ['mining-progress'] }),
    onSuccess: async (saved) => {
      const savedKey = ['mining-progress', saved.walletAddress]
      await queryClient.cancelQueries({ queryKey: savedKey })
      queryClient.setQueryData<MiningProgress>(savedKey, (previous) =>
        previous && previous.revision > saved.revision ? previous : saved,
      )
    },
    retry: false,
  })
  const failedHit = mine.isError && mine.variables?.walletAddress === identity.data?.walletAddress
  const failedSale = sell.isError && sell.variables?.walletAddress === identity.data?.walletAddress
  const failedPickaxePurchase =
    buyIronPickaxe.isError && buyIronPickaxe.variables?.walletAddress === identity.data?.walletAddress
  const rock =
    (progress.data?.health ?? 10) <= 4
      ? 'copper-rock-heavily-cracked.png'
      : (progress.data?.health ?? 10) <= 8
        ? 'copper-rock-lightly-cracked.png'
        : 'copper-rock-intact.png'
  return (
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
      <button
        aria-label="Mine copper rock"
        className="absolute left-[23.33%] top-[46.56%] w-[53.33%] rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-100 disabled:cursor-not-allowed"
        disabled={
          !identity.data || identity.isFetching || progress.isPending || progress.isError || mine.isPending || failedHit
        }
        onClick={() =>
          identity.data && mine.mutate({ actionId: crypto.randomUUID(), walletAddress: identity.data.walletAddress })
        }
        type="button"
      >
        <img
          alt=""
          className="pointer-events-none w-full [image-rendering:pixelated]"
          draggable={false}
          height={384}
          src={`/copper-cave/${rock}`}
          width={384}
        />
      </button>
      <img
        alt={progress.data?.ironPickaxeOwned ? 'Iron Pickaxe' : 'Wooden Pickaxe'}
        className="pointer-events-none absolute left-[62.22%] top-[53.75%] w-[35.56%] [image-rendering:pixelated]"
        draggable={false}
        height={256}
        src={progress.data?.ironPickaxeOwned ? '/pickaxes/iron-pickaxe.png' : '/pickaxes/wooden-pickaxe.png'}
        width={256}
      />
      <div className="absolute inset-x-4 top-[16%] rounded-lg bg-black/70 p-3 text-center text-sm text-amber-100">
        <p aria-live="polite">
          {identity.isPending
            ? 'Restoring session…'
            : identity.error
              ? 'Could not load your session.'
              : !identity.data
                ? 'Sign in below to mine.'
                : progress.isPending
                  ? 'Loading saved progress…'
                  : progress.error
                    ? 'Could not load your progress.'
                    : `Health: ${progress.data?.health ?? 10}/10 · Copper: ${progress.data?.copper ?? 0} · Coins: ${progress.data?.coins ?? 0} · XP: ${progress.data?.xp ?? 0}`}
          {mine.isPending && <span role="status"> · Saving hit…</span>}
          {sell.isPending && <span role="status"> · Selling copper…</span>}
          {buyIronPickaxe.isPending && <span role="status"> · Buying Iron Pickaxe…</span>}
        </p>
        <p>
          Equipped: {progress.data?.ironPickaxeOwned ? 'Iron Pickaxe · 3 damage/hit' : 'Wooden Pickaxe · 2 damage/hit'}
        </p>
        <button
          className="mt-2 rounded-md border border-amber-100/60 px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={
            !identity.data ||
            identity.isFetching ||
            progress.isPending ||
            progress.isError ||
            (progress.data?.copper ?? 0) === 0 ||
            sell.isPending ||
            failedSale
          }
          onClick={() =>
            identity.data && sell.mutate({ actionId: crypto.randomUUID(), walletAddress: identity.data.walletAddress })
          }
          type="button"
        >
          Sell copper
        </button>
        <button
          className="ml-2 mt-2 rounded-md border border-amber-100/60 px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={
            !identity.data ||
            identity.isFetching ||
            progress.isPending ||
            progress.isError ||
            progress.data?.ironPickaxeOwned ||
            buyIronPickaxe.isPending ||
            failedPickaxePurchase
          }
          onClick={() =>
            identity.data &&
            buyIronPickaxe.mutate({ actionId: crypto.randomUUID(), walletAddress: identity.data.walletAddress })
          }
          type="button"
        >
          {progress.data?.ironPickaxeOwned ? 'Owned' : 'Buy Iron Pickaxe · 20 coins'}
        </button>
        {failedPickaxePurchase && (
          <>
            <p role="alert">{buyIronPickaxe.error?.message}</p>
            <button
              className="mt-1 underline"
              disabled={buyIronPickaxe.isPending || !identity.data}
              onClick={() => buyIronPickaxe.variables && buyIronPickaxe.mutate(buyIronPickaxe.variables)}
              type="button"
            >
              Retry purchase
            </button>
          </>
        )}
        {failedSale && (
          <>
            <p role="alert">{sell.error?.message}</p>
            <button
              className="mt-1 underline"
              disabled={sell.isPending || !identity.data}
              onClick={() => sell.variables && sell.mutate(sell.variables)}
              type="button"
            >
              Retry sale
            </button>
          </>
        )}
        {failedHit && (
          <>
            <p role="alert">{mine.error?.message}</p>
            <button
              className="mt-2 underline"
              disabled={mine.isPending || !identity.data}
              onClick={() => mine.variables && mine.mutate(mine.variables)}
              type="button"
            >
              Retry hit
            </button>
          </>
        )}
        {(progress.isError || identity.isError) && (
          <button
            className="mt-2 underline"
            onClick={() => void (identity.isError ? identity.refetch() : progress.refetch())}
            type="button"
          >
            Retry
          </button>
        )}
      </div>
    </section>
  )
}
