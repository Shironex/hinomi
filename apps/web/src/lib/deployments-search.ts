import { z } from 'zod'
import { splitSearchSchema } from './split-search'

/**
 * Search params of /deployments. With neither param it is the exposure map (on a phone, the
 * list). `order` opens the list, grouped by server or ranked by exposed findings across
 * servers; `sel` opens an app's detail beside the list (by server unless `order` says else).
 */
export const deploymentsSearchSchema = z
  .object({ order: z.enum(['server', 'exposure']).optional().catch(undefined) })
  .extend(splitSearchSchema.shape)

export type DeploymentsSearch = z.infer<typeof deploymentsSearchSchema>
