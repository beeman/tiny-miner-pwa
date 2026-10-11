import { useQuery } from '@tanstack/react-query'

export function useAuthSession() {
  return useQuery({
    queryFn: async ({ signal }): Promise<{ walletAddress: string } | null> => {
      const response = await fetch('/api/me', { signal })
      if (response.status === 401) return null
      if (!response.ok) throw new Error('Could not load your session. Check that the server is running.')
      return response.json()
    },
    queryKey: ['auth-session'],
    retry: false,
  })
}
