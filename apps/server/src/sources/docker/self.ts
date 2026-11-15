import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

// Hinomi's own container, when it runs on the Docker host it reads (docs/design/phase-2.md
// section 9.3): it is skipped by its id. Docker sets the hostname to the short id unless it is
// overridden, and the cgroup and mount tables of the process name the full id.

const FULL_ID = /\b([0-9a-f]{64})\b/g

/** Ids (full or the 12 character short form) this process may be running under. */
export function ownContainerIds(
  read: (path: string) => string | null = readText,
  host: string = hostname(),
): string[] {
  const ids = new Set<string>()
  if (/^[0-9a-f]{12,64}$/.test(host)) ids.add(host)
  for (const path of ['/proc/self/cgroup', '/proc/self/mountinfo']) {
    const text = read(path)
    if (!text) continue
    // Only ids inside a container path, not any 64 hex run (overlay layers have those too).
    for (const line of text.split('\n')) {
      if (!/docker|containers|containerd|libpod/.test(line)) continue
      for (const match of line.matchAll(FULL_ID)) ids.add(match[1]!)
    }
  }
  return [...ids]
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** True when a container id is one of `ids` (a short id matches as a prefix). */
export function isOwnContainer(id: string, ids: readonly string[]): boolean {
  return ids.some((own) => id === own || (own.length < 64 && id.startsWith(own)))
}
