import {
  createRegistryCredentialRequestSchema,
  idParamSchema,
  registryCredentialSchema,
  registryCredentialsResponseSchema,
  updateRegistryCredentialRequestSchema,
} from '@hinomi/shared'
import { Hono } from 'hono'
import type { RegistryCredential } from '../../repository/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, send } from '../http.js'

const toDto = (credential: RegistryCredential) => ({
  id: credential.id,
  host: credential.host,
  username: credential.username,
  secretSet: credential.secretSet,
  createdAt: credential.createdAt.toISOString(),
  updatedAt: credential.updatedAt.toISOString(),
})

/**
 * Credentials for private registries, read by the registry SBOM image scan, under
 * /api/settings/registry-credentials. The secret is write only: no route returns it.
 */
export function registryCredentialsRoutes(deps: ApiDeps) {
  const app = new Hono()
  const store = deps.repositories.registryCredentials

  app.get('/', (c) =>
    send(c, registryCredentialsResponseSchema, {
      items: store.list().map(toDto),
      canStoreSecrets: store.canStoreSecrets,
    }),
  )

  app.post('/', async (c) => {
    const body = await readJson(c, createRegistryCredentialRequestSchema)
    const credential = store.create(body)
    if (!credential) {
      throw new HttpError(
        409,
        'conflict',
        `A credential for ${body.host} already exists; edit it instead`,
      )
    }
    return send(c, registryCredentialSchema, toDto(credential), 201)
  })

  app.patch('/:id', async (c) => {
    const { id } = readParams(c, idParamSchema)
    const body = await readJson(c, updateRegistryCredentialRequestSchema)
    const credential = store.update(id, body)
    if (!credential) throw notFound('Registry credential')
    return send(c, registryCredentialSchema, toDto(credential))
  })

  app.delete('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    if (!store.remove(id)) throw notFound('Registry credential')
    return c.body(null, 204)
  })

  return app
}
