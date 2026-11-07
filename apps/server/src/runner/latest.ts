import { FIX_WORKFLOW, LATEST_FIX_WORKFLOW, nowMs } from '@hinomi/shared'
import type { LatestFixWorkflow } from './caller.js'

// The commit callers should pin: the one tagged by the latest Hinomi release, read from the
// public GitHub API at run time. A release's SHA is only known after its tag exists, so it
// cannot be written into the release itself; reading it keeps every instance current without
// a new Hinomi build. Cached for hours, and on any failure (offline instance, rate limit, a
// release that predates the runner) the answer is LATEST_FIX_WORKFLOW.

const API = 'https://api.github.com'
const [OWNER = '', NAME = '', ...PATH_PARTS] = FIX_WORKFLOW.split('/')
const REPO = `${OWNER}/${NAME}`
const WORKFLOW_PATH = PATH_PARTS.join('/')
const SHA = /^[a-f0-9]{40}$/
const TAG = /^v\d+\.\d+\.\d+$/

/** Successful answers are kept this long. */
export const LATEST_TTL_MS = 6 * 60 * 60 * 1000
/** Failed lookups wait this long before the next try. */
export const LATEST_RETRY_MS = 30 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

export interface LatestFixWorkflowSource {
  get(): Promise<LatestFixWorkflow | null>
}

export interface ReleaseLatestOptions {
  fetch?: typeof fetch
  now?: () => number
  fallback?: LatestFixWorkflow | null
}

async function getJson(fetchImpl: typeof fetch, path: string): Promise<unknown> {
  const response = await fetchImpl(`${API}${path}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return null
  const body: unknown = await response.json()
  return body
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/**
 * Reads the latest release's tag, the commit it points at, and checks the reusable workflow
 * exists at that commit. Null when any of it is missing.
 */
export async function fetchLatestFixWorkflow(
  fetchImpl: typeof fetch,
): Promise<LatestFixWorkflow | null> {
  const release = await getJson(fetchImpl, `/repos/${REPO}/releases/latest`)
  const tag = field(release, 'tag_name')
  if (typeof tag !== 'string' || !TAG.test(tag)) return null
  const commit = await getJson(fetchImpl, `/repos/${REPO}/commits/${tag}`)
  const sha = field(commit, 'sha')
  if (typeof sha !== 'string' || !SHA.test(sha)) return null
  const file = await getJson(fetchImpl, `/repos/${REPO}/contents/${WORKFLOW_PATH}?ref=${sha}`)
  if (field(file, 'type') !== 'file') return null
  return { sha, version: tag }
}

/** The latest release's workflow commit, cached, with the constant as the fallback. */
export function releaseLatestSource(options: ReleaseLatestOptions = {}): LatestFixWorkflowSource {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? nowMs
  const fallback = options.fallback === undefined ? LATEST_FIX_WORKFLOW : options.fallback
  let cached: { value: LatestFixWorkflow | null; until: number } | null = null
  let pending: Promise<LatestFixWorkflow | null> | null = null
  return {
    get() {
      if (cached && now() < cached.until) return Promise.resolve(cached.value)
      pending ??= fetchLatestFixWorkflow(fetchImpl)
        .catch(() => null)
        .then((found) => {
          cached = {
            value: found ?? fallback,
            until: now() + (found ? LATEST_TTL_MS : LATEST_RETRY_MS),
          }
          pending = null
          return cached.value
        })
      return pending
    },
  }
}
