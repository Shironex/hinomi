import { z } from 'zod'

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  /**
   * The running version: a release like `0.3.0`, or `dev`. Left out while HINOMI_AUTH is on, so
   * the one public route says nothing about the instance.
   */
  version: z.string().optional(),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>
