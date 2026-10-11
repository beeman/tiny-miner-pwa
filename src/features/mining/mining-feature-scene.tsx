import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useAuthSession } from '@/features/auth/use-auth-session'

type MiningProgress = {
  coins: number
  copper: number
  crystalHealth: number
  crystalOre: number
  equippedPickaxe: PickaxeId
  goldHealth: number
  goldOre: number
  goldenPickaxeOwned: boolean
  health: number
  ironHealth: number
  ironOre: number
  ironPickaxeOwned: boolean
  revision: number
  steelPickaxeOwned: boolean
  xp: number
}

type PickaxeId = 'wooden' | 'iron' | 'steel' | 'golden'

const pickaxes: Record<PickaxeId, { damage: number; label: string; price: number }> = {
  golden: { damage: 8, label: 'Golden Pickaxe', price: 300 },
  iron: { damage: 3, label: 'Iron Pickaxe', price: 20 },
  steel: { damage: 5, label: 'Steel Pickaxe', price: 100 },
  wooden: { damage: 2, label: 'Wooden Pickaxe', price: 0 },
}

const mines = {
  copper: {
    assetDirectory: 'copper-cave',
    background: '/copper-cave/cave-background.png',
    healthKey: 'health',
    label: 'Copper Cave',
    maxHealth: 10,
    minLevel: 1,
    oreKey: 'copper',
    resource: 'copper',
    rockPrefix: 'copper-rock',
  },
  crystal: {
    assetDirectory: 'crystal-cavern',
    background: '/crystal-cavern/cave-background.png',
    healthKey: 'crystalHealth',
    label: 'Crystal Cavern',
    maxHealth: 40,
    minLevel: 4,
    oreKey: 'crystalOre',
    resource: 'crystal',
    rockPrefix: 'crystal-rock',
  },
  gold: {
    assetDirectory: 'gold-mine',
    background: '/gold-mine/cave-background.png',
    healthKey: 'goldHealth',
    label: 'Gold Mine',
    maxHealth: 30,
    minLevel: 3,
    oreKey: 'goldOre',
    resource: 'gold',
    rockPrefix: 'gold-rock',
  },
  iron: {
    assetDirectory: 'iron-mine',
    background: '/iron-mine/cave-background.png',
    healthKey: 'ironHealth',
    label: 'Iron Mine',
    maxHealth: 20,
    minLevel: 2,
    oreKey: 'ironOre',
    resource: 'iron',
    rockPrefix: 'iron-rock',
  },
} as const
type MineId = keyof typeof mines
const mineOrder: MineId[] = ['copper', 'iron', 'gold', 'crystal']

export function MiningFeatureScene() {
  const [mineId, setMineId] = useState<MineId>('copper')
  const selectedMine = mines[mineId]
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
      mineId,
      walletAddress,
    }: {
      actionId: string
      mineId: MineId
      walletAddress: string
    }): Promise<MiningProgress & { walletAddress: string }> => {
      const response = await fetch('/api/mining', {
        body: JSON.stringify({ actionId, mineId }),
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
  const buyPickaxe = useMutation({
    mutationFn: async ({
      actionId,
      pickaxeId,
      walletAddress,
    }: {
      actionId: string
      pickaxeId: Exclude<PickaxeId, 'wooden'>
      walletAddress: string
    }): Promise<MiningProgress & { walletAddress: string }> => {
      const response = await fetch(`/api/mining/upgrade/${pickaxeId}-pickaxe`, {
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
  const equipPickaxe = useMutation({
    mutationFn: async ({
      actionId,
      pickaxeId,
      walletAddress,
    }: {
      actionId: string
      pickaxeId: PickaxeId
      walletAddress: string
    }): Promise<MiningProgress & { walletAddress: string }> => {
      const response = await fetch('/api/mining/equip', {
        body: JSON.stringify({ actionId, pickaxeId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (response.status === 401) {
        await queryClient.invalidateQueries({ queryKey: ['auth-session'] })
        throw new Error('Your session expired. Sign in again.')
      }
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(result?.error ?? 'Could not equip this pickaxe. Retry safely.')
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
  const failedPickaxePurchase =
    buyPickaxe.isError && buyPickaxe.variables?.walletAddress === identity.data?.walletAddress
  const failedPickaxeEquip =
    equipPickaxe.isError && equipPickaxe.variables?.walletAddress === identity.data?.walletAddress
  const xp = progress.data?.xp ?? 0
  const level = Math.floor(xp / 100) + 1
  const health = progress.data?.[selectedMine.healthKey] ?? selectedMine.maxHealth
  const rockState =
    health <= selectedMine.maxHealth / 2
      ? 'heavily-cracked'
      : health <= selectedMine.maxHealth * 0.8
        ? 'lightly-cracked'
        : 'intact'
  const hasOre =
    (progress.data?.copper ?? 0) > 0 ||
    (progress.data?.crystalOre ?? 0) > 0 ||
    (progress.data?.goldOre ?? 0) > 0 ||
    (progress.data?.ironOre ?? 0) > 0
  return (
    <section
      aria-label={selectedMine.label}
      className="relative mx-auto aspect-[720/1280] w-full max-w-sm overflow-hidden rounded-xl"
    >
      <img
        alt=""
        className="absolute inset-0 size-full [image-rendering:pixelated]"
        height={1280}
        src={selectedMine.background}
        width={720}
      />
      <h2 className="absolute inset-x-0 top-[8%] text-center text-2xl font-bold text-amber-100">
        {selectedMine.label}
      </h2>
      <button
        aria-label={`Mine ${selectedMine.resource} rock`}
        className="absolute left-[23.33%] top-[46.56%] w-[53.33%] rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-100 disabled:cursor-not-allowed"
        disabled={
          !identity.data ||
          identity.isFetching ||
          progress.isPending ||
          progress.isError ||
          mine.isPending ||
          failedHit ||
          level < selectedMine.minLevel
        }
        onClick={() =>
          identity.data &&
          mine.mutate({ actionId: crypto.randomUUID(), mineId, walletAddress: identity.data.walletAddress })
        }
        type="button"
      >
        <img
          alt=""
          className="pointer-events-none w-full [image-rendering:pixelated]"
          draggable={false}
          height={384}
          src={`/${selectedMine.assetDirectory}/${selectedMine.rockPrefix}-${rockState}.png`}
          width={384}
        />
      </button>
      <img
        alt={`${pickaxes[progress.data?.equippedPickaxe ?? 'wooden'].label}`}
        className="pointer-events-none absolute left-[62.22%] top-[53.75%] w-[35.56%] [image-rendering:pixelated]"
        draggable={false}
        height={256}
        src={`/pickaxes/${progress.data?.equippedPickaxe ?? 'wooden'}-pickaxe.png`}
        width={256}
      />
      <div className="absolute inset-x-4 top-[16%] rounded-lg bg-black/70 p-3 text-center text-sm text-amber-100">
        <div className="mb-2 grid grid-cols-2 gap-1.5" role="group" aria-label="Select mine">
          {mineOrder.map((id) => {
            const mine = mines[id]
            const unlocked = level >= mine.minLevel
            return (
              <button
                key={id}
                aria-pressed={mineId === id}
                className="min-w-0 rounded-md border border-amber-100/60 px-2 py-1 text-xs aria-pressed:bg-amber-100 aria-pressed:text-black disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
                disabled={!unlocked}
                onClick={() => setMineId(id)}
                type="button"
              >
                {unlocked ? mine.label : `${mine.label} · Level ${mine.minLevel}`}
              </button>
            )
          })}
        </div>
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
                    : `Health: ${health}/${selectedMine.maxHealth}`}
          {mine.isPending && <span role="status"> · Saving hit…</span>}
          {sell.isPending && <span role="status"> · Selling ore…</span>}
          {buyPickaxe.isPending && (
            <span role="status"> · Buying {pickaxes[buyPickaxe.variables.pickaxeId].label}…</span>
          )}
          {equipPickaxe.isPending && <span role="status"> · Equipping pickaxe…</span>}
        </p>
        {progress.data && (
          <p>
            Level {level} · {xp % 100}/100 XP to next level
          </p>
        )}
        {progress.data && (
          <p>
            Copper: {progress.data.copper} · Crystal: {progress.data.crystalOre} · Gold: {progress.data.goldOre} · Iron:{' '}
            {progress.data.ironOre} · Coins: {progress.data.coins}
          </p>
        )}
        <p>
          Equipped: {pickaxes[progress.data?.equippedPickaxe ?? 'wooden'].label} ·{' '}
          {pickaxes[progress.data?.equippedPickaxe ?? 'wooden'].damage} damage/hit
        </p>
        <label className="mt-2 inline-flex items-center gap-2">
          Pickaxe
          <select
            aria-label="Equip owned pickaxe"
            className="rounded-md border border-amber-100/60 bg-black px-2 py-1"
            disabled={!identity.data || equipPickaxe.isPending || !progress.data}
            onChange={(event) =>
              identity.data &&
              equipPickaxe.mutate({
                actionId: crypto.randomUUID(),
                pickaxeId: event.target.value as PickaxeId,
                walletAddress: identity.data.walletAddress,
              })
            }
            value={progress.data?.equippedPickaxe ?? 'wooden'}
          >
            <option value="wooden">Wooden · 2 damage</option>
            {progress.data?.ironPickaxeOwned && <option value="iron">Iron · 3 damage</option>}
            {progress.data?.steelPickaxeOwned && <option value="steel">Steel · 5 damage</option>}
            {progress.data?.goldenPickaxeOwned && <option value="golden">Golden · 8 damage</option>}
          </select>
        </label>
        <button
          className="mt-2 rounded-md border border-amber-100/60 px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={
            !identity.data ||
            identity.isFetching ||
            progress.isPending ||
            progress.isError ||
            !hasOre ||
            sell.isPending ||
            failedSale
          }
          onClick={() =>
            identity.data && sell.mutate({ actionId: crypto.randomUUID(), walletAddress: identity.data.walletAddress })
          }
          type="button"
        >
          Sell ore
        </button>
        <div className="mt-2 flex flex-wrap justify-center gap-1.5" role="group" aria-label="Pickaxe upgrades">
          {(['iron', 'steel', 'golden'] as const).map((pickaxeId) => {
            const owned =
              pickaxeId === 'iron'
                ? progress.data?.ironPickaxeOwned
                : pickaxeId === 'steel'
                  ? progress.data?.steelPickaxeOwned
                  : progress.data?.goldenPickaxeOwned
            return (
              <button
                key={pickaxeId}
                className="rounded-md border border-amber-100/60 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !identity.data ||
                  identity.isFetching ||
                  progress.isPending ||
                  progress.isError ||
                  owned ||
                  buyPickaxe.isPending ||
                  failedPickaxePurchase
                }
                onClick={() =>
                  identity.data &&
                  buyPickaxe.mutate({
                    actionId: crypto.randomUUID(),
                    pickaxeId,
                    walletAddress: identity.data.walletAddress,
                  })
                }
                type="button"
              >
                {owned ? 'Owned' : `Buy ${pickaxes[pickaxeId].label} · ${pickaxes[pickaxeId].price} coins`}
              </button>
            )
          })}
        </div>
        {failedPickaxePurchase && (
          <>
            <p role="alert">{buyPickaxe.error?.message}</p>
            <button
              className="mt-1 underline"
              disabled={buyPickaxe.isPending || !identity.data}
              onClick={() => buyPickaxe.variables && buyPickaxe.mutate(buyPickaxe.variables)}
              type="button"
            >
              Retry purchase
            </button>
          </>
        )}
        {failedPickaxeEquip && <p role="alert">{equipPickaxe.error?.message}</p>}
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
