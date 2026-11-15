import type { RegistryCredentialsResponse } from '@hinomi/shared'
import { ago } from './dataset'

/** Registry credentials for the SBOM image scan. Fictional hosts and users; no secret is ever served. */
export const REGISTRY_CREDENTIALS: RegistryCredentialsResponse = {
  items: [
    {
      id: 1,
      host: 'ghcr.io',
      username: 'kestrel-bot',
      secretSet: true,
      createdAt: ago(24 * 9),
      updatedAt: ago(24 * 9),
    },
    {
      id: 2,
      host: 'registry.example.com:5000',
      username: 'scanner',
      secretSet: true,
      createdAt: ago(24 * 30),
      updatedAt: ago(26),
    },
  ],
  canStoreSecrets: true,
}
