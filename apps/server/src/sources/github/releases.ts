import { z } from 'zod'
import type { GithubClient } from './client.js'
import type { ConditionalRead } from './runs.js'
import { parsePayload } from './schemas.js'

// The latest release of a repo, for the desktop release tier.

const restReleaseSchema = z.object({
  tag_name: z.string().min(1),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullable().optional(),
  assets: z.array(z.object({ name: z.string() })).default([]),
})

/** The latest final release of a repo: its tag, when it was published and its asset names. */
export interface GithubRelease {
  tag: string
  publishedAt: string | null
  assetNames: string[]
}

/**
 * GET /repos/{owner}/{repo}/releases/latest with the last ETag. GitHub answers the most recent
 * release that is neither a draft nor a prerelease, or 404 when there is none (value null). A
 * 304 (`modified: false`) means nothing changed and does not count against the rate limit.
 */
export async function fetchLatestRelease(
  client: GithubClient,
  owner: string,
  name: string,
  etag: string | null | undefined,
): Promise<ConditionalRead<GithubRelease | null>> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`
  const result = await client.rest(path, {
    acceptStatus: [304, 404],
    ...(etag && { ifNoneMatch: etag }),
  })
  const next = result.headers.get('etag')
  if (result.status === 304) return { modified: false, etag: next ?? etag ?? null }
  if (result.status === 404) return { modified: true, etag: null, value: null }
  const raw = parsePayload(restReleaseSchema, result.data, 'release')
  // The endpoint already leaves drafts and prereleases out; this guards against a proxy that does not.
  if (raw.draft === true || raw.prerelease === true) {
    return { modified: true, etag: next, value: null }
  }
  return {
    modified: true,
    etag: next,
    value: {
      tag: raw.tag_name,
      publishedAt: raw.published_at ?? null,
      assetNames: raw.assets.map((a) => a.name),
    },
  }
}
