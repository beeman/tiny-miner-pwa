import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useAuthSession } from '@/features/auth/use-auth-session'

export function MiningFeatureScene() {
  const identity = useAuthSession()
  const queryClient = useQueryClient()
  const queryKey = ['mining-counter', identity.data?.walletAddress]
  const counter = useQuery({
    enabled: !!identity.data,
    queryFn: async ({ signal }): Promise<{ count: number }> => {
      const response = await fetch('/api/mining', { signal })
      if (!response.ok) throw new Error('Could not load saved count')
      return response.json()
    },
    queryKey,
    retry: false,
  })
  const mine = useMutation({
    mutationFn: async (walletAddress: string): Promise<{ count: number; walletAddress: string }> => {
      const response = await fetch('/api/mining', { method: 'POST' })
      if (response.status === 401) {
        await queryClient.invalidateQueries({ queryKey: ['auth-session'] })
        throw new Error('Your session expired. Sign in again.')
      }
      if (!response.ok)
        throw new Error('Could not confirm this hit. Reload to check the saved count before trying again.')
      const saved: { count: number } = await response.json()
      return { ...saved, walletAddress }
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ['mining-counter'] }),
    onSuccess: async (saved) => {
      const savedKey = ['mining-counter', saved.walletAddress]
      await queryClient.cancelQueries({ queryKey: savedKey })
      queryClient.setQueryData<{ count: number }>(savedKey, (previous) => ({
        count: Math.max(previous?.count ?? 0, saved.count),
      }))
    },
    retry: false,
  })
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
        disabled={!identity.data || identity.isFetching || counter.isPending || counter.isError || mine.isPending}
        onClick={() => identity.data && mine.mutate(identity.data.walletAddress)}
        type="button"
      >
        <img
          alt=""
          className="pointer-events-none w-full [image-rendering:pixelated]"
          draggable={false}
          height={384}
          src="/copper-cave/copper-rock-intact.png"
          width={384}
        />
      </button>
      <img
        alt="Wooden pickaxe"
        className="pointer-events-none absolute left-[62.22%] top-[53.75%] w-[35.56%] [image-rendering:pixelated]"
        draggable={false}
        height={256}
        src="/copper-cave/wooden-pickaxe.png"
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
                : counter.isPending
                  ? 'Loading saved count…'
                  : counter.error
                    ? 'Could not load your count.'
                    : `Mining count: ${counter.data?.count ?? 0}`}
        </p>
        {mine.isPending && <p role="status">Saving hit…</p>}
        {mine.error && <p role="alert">{mine.error.message}</p>}
        {(counter.isError || identity.isError) && (
          <button
            className="mt-2 underline"
            onClick={() => void (identity.isError ? identity.refetch() : counter.refetch())}
            type="button"
          >
            Retry
          </button>
        )}
      </div>
    </section>
  )
}
