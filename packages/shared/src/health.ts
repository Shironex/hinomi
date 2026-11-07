import { z } from 'zod'

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  /** The running version: a release like `0.3.0`, or `dev`. */
  version: z.string(),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>
