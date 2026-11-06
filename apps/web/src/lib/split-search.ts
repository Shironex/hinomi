import { z } from 'zod'

/**
 * The search param that holds a split view's selection. Routes with a SplitView merge this into
 * their validateSearch schema (`schema.extend(splitSearchSchema.shape)`). The router parses
 * `?sel=12` as a number, so both are accepted.
 */
export const splitSearchSchema = z.object({
  sel: z.union([z.string(), z.number()]).optional(),
})

export type SplitSearch = z.infer<typeof splitSearchSchema>
