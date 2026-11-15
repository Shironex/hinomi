import { DockerError } from './errors.js'
import { containerListPath } from './inventory.js'
import { versionSchema } from './schemas.js'
import type { DockerTransport } from './transport.js'

// The connection test of a Docker source (docs/design/phase-2.md section 9.3, Q21). It reads the
// endpoints the inventory needs, then `GET /info`, which a GET only socket proxy refuses: when it
// answers, the connection gives more than Hinomi needs, so the test says to put a proxy in front.
// Nothing but GET is ever sent, so no write is tried to find out.

export type DockerTestResult =
  | { ok: true; version: string | null; containers: number; warning: string | null }
  | { ok: false; code: string; message: string }

export const BROAD_ACCESS_WARNING =
  'This connection allows more than Hinomi needs: GET /info answered, so it is likely the raw Docker socket or a proxy that allows more than containers. Docker access is root on the host. Put a GET only socket proxy in front that allows /containers, /version and /_ping.'

export async function testDockerConnection(
  transport: DockerTransport,
  optIn: boolean,
): Promise<DockerTestResult> {
  try {
    await transport.get('/_ping')
    const version = versionSchema.safeParse(await transport.get('/version'))
    const list = await transport.get(containerListPath(optIn))
    const containers = Array.isArray(list) ? list.length : 0
    let broad = false
    try {
      await transport.get('/info')
      broad = true
    } catch (error) {
      // Refused or unknown: the expected answer of a proxy. A timeout says nothing either way.
      if (!(error instanceof DockerError)) throw error
    }
    return {
      ok: true,
      version: version.success ? (version.data.Version ?? null) : null,
      containers,
      warning: broad ? BROAD_ACCESS_WARNING : null,
    }
  } catch (error) {
    if (error instanceof DockerError) return { ok: false, code: error.code, message: error.message }
    return { ok: false, code: 'network', message: 'Unexpected error while testing the connection' }
  }
}
