import type { ApiErrorBody, ApiErrorCode } from '@hinomi/shared'
import type { Context, ErrorHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { SecretDecryptError, SecretKeyMissingError } from '../crypto/secret-box.js'
import type { Logger } from '../log.js'

/** Thrown by handlers for an expected failure; becomes `{ error: { code, message } }`. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode
  readonly code: ApiErrorCode

  constructor(status: ContentfulStatusCode, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`)

export function errorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } }
}

/**
 * Validation messages without the values that were sent: a rejected field
 * may be a token.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ` : '') + issue.message)
    .join('; ')
}

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new HttpError(
      400,
      'validation_failed',
      `Invalid ${where}: ${describeIssues(result.error)}`,
    )
  }
  return result.data
}

/** Reads and validates a JSON body. An empty body counts as `{}`. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const raw = await c.req.text()
  if (raw.trim() === '') return parseOrThrow(schema, {}, 'request body')
  const type = c.req.header('content-type') ?? ''
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the body as application/json')
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON')
  }
  return parseOrThrow(schema, body, 'request body')
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parseOrThrow(schema, c.req.query(), 'query')
}

export function readParams<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.param())
  // A malformed id can never match a row.
  if (!result.success) throw new HttpError(404, 'not_found', 'Not found')
  return result.data
}

/**
 * Validates the response against its contract before sending it. A mismatch
 * is a server bug and ends as a 500, never as an unchecked body.
 */
export function send<S extends z.ZodType>(
  c: Context,
  schema: S,
  data: z.input<S>,
  status: ContentfulStatusCode = 200,
) {
  return c.json(schema.parse(data) as object, status)
}

/**
 * Error message for logs. Database errors from drizzle append the query
 * parameters, which may hold encrypted tokens; everything after them is cut.
 */
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cut = message.search(/\bparams:/i)
  return (cut === -1 ? message : message.slice(0, cut)).trim().slice(0, 500)
}

export function errorHandler(log: Logger): ErrorHandler {
  return (error, c) => {
    if (error instanceof HttpError) {
      return c.json(errorBody(error.code, error.message), error.status)
    }
    if (error instanceof SecretKeyMissingError) {
      return c.json(errorBody('secret_key_missing', error.message), 400)
    }
    if (error instanceof SecretDecryptError) {
      return c.json(errorBody('bad_request', error.message), 400)
    }
    log.error('api: unhandled error', {
      method: c.req.method,
      path: c.req.path,
      error: safeErrorMessage(error),
    })
    return c.json(errorBody('internal', 'Something went wrong on the server'), 500)
  }
}
