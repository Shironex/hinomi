import { z } from 'zod'

export const coolifyConnectionConfigSchema = z.object({
  /** Name used as `source` on every record. */
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  token: z.string().min(1),
})
export type CoolifyConnectionConfig = z.infer<typeof coolifyConnectionConfigSchema>

export const coolifyErrorCodeSchema = z.enum([
  'invalid_config',
  'unauthorized',
  'forbidden',
  'not_found',
  'server_error',
  'http_error',
  'rate_limited',
  'network',
  'timeout',
  'invalid_response',
])
export type CoolifyErrorCode = z.infer<typeof coolifyErrorCodeSchema>

export const coolifyConnectionTestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), version: z.string().nullable() }),
  z.object({ ok: z.literal(false), code: coolifyErrorCodeSchema, message: z.string() }),
])
export type CoolifyConnectionTestResult = z.infer<typeof coolifyConnectionTestResultSchema>
