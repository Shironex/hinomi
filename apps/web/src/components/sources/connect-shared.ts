import { testTokenRequestSchema, type SourceDto, type SourceTestResult } from '@hinomi/shared'
import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/queries'
import { settingsKeys } from '@/lib/settings-api'

/** Pieces shared by the token and the GitHub App connect forms. */

export type ConnectableKind = 'coolify' | 'github'

export type SuccessfulTest = Extract<SourceTestResult, { ok: true }>

export interface ConnectResult {
  source: SourceDto
  test: SuccessfulTest
}

export interface ConnectFormProps {
  kind: ConnectableKind
  /** A saved source to give new credentials. Omit to create one. */
  source?: SourceDto
  onConnected: (result: ConnectResult) => void
  onCancel?: () => void
}

/** A failed connection test, carried through the mutation so it lands by the right field. */
export class ConnectionTestFailed extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Codes from the Coolify and GitHub testers that mean the credentials are the problem. */
export const TOKEN_CODES = new Set(['unauthorized', 'forbidden', 'auth', 'permission'])

export const urlSchema = testTokenRequestSchema.shape.baseUrl.unwrap().unwrap()

/** A sentence for a field error: the testers answer without a closing period. */
export function sentence(message: string): string {
  return message.endsWith('.') ? message : `${message}.`
}

/** After a save: the source list and the scan state (a first source starts a scan). */
export function refreshAfterConnect(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: settingsKeys.sources }),
    queryClient.invalidateQueries({ queryKey: queryKeys.scanStatus }),
  ])
}
