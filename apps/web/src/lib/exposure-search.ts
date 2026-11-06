import { z } from 'zod'
import { splitSearchSchema } from './split-search'

/** The tabs of the exposure list. Needs action is the default and is left out of the URL. */
export const EXPOSURE_TABS = ['action', 'blind', 'progress', 'fixes'] as const
export type ExposureTab = (typeof EXPOSURE_TABS)[number]

export const exposureSearchSchema = z
  .object({ tab: z.enum(EXPOSURE_TABS).optional().catch(undefined) })
  .extend(splitSearchSchema.shape)

export type ExposureSearch = z.infer<typeof exposureSearchSchema>
