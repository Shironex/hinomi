import { accessStatusSchema, type AccessStatus } from '@hinomi/shared'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { authSessionQuery } from '@/lib/auth-api'

/** Where docs/access.md lives, linked from every access status. */
export const ACCESS_DOCS_URL = 'https://github.com/Shironex/hinomi/blob/main/docs/access.md'

/**
 * How this browser reaches Hinomi (GET /api/access). The answer depends on the network
 * path, which does not change while the page is open, so it is read once per load.
 */
export const accessQuery = queryOptions({
  queryKey: ['access'] as const,
  queryFn: ({ signal }) => api.get('/access', accessStatusSchema, { signal }),
  staleTime: Number.POSITIVE_INFINITY,
})

/** The access status, or undefined while loading or when the server cannot tell us. */
export function useAccessStatus(): AccessStatus | undefined {
  return useQuery(accessQuery).data
}

/** True while the built in login is on (HINOMI_AUTH); false when off or not known yet. */
export function useLoginEnabled(): boolean {
  return useQuery(authSessionQuery).data?.enabled ?? false
}

export type AccessTone = 'ok' | 'warn' | 'danger'

/**
 * Protected is calm, public is loud, anything Hinomi cannot confirm keeps the warning. With the
 * built in login on, a public address is a warning, not an alarm: every request needs a session.
 */
export function accessTone(status: AccessStatus | undefined, loginOn = false): AccessTone {
  if (!status) return 'warn'
  if (status.state === 'tailscale') return 'ok'
  if (status.state === 'cloudflare_access') return status.verified ? 'ok' : 'warn'
  if (status.state === 'public') return loginOn ? 'warn' : 'danger'
  return 'warn'
}

/** Short label for the sidebar. */
export function accessLabel(status: AccessStatus, loginOn = false): string {
  switch (status.state) {
    case 'tailscale':
      return 'Protected by Tailscale'
    case 'cloudflare_access':
      return status.verified ? 'Protected by Cloudflare Access' : 'Cloudflare Access, not verified'
    case 'public':
      return loginOn ? 'Public, login required' : 'Public, no protection'
    case 'unknown':
      return 'Access not detected'
  }
}
