import { apiErrorSchema, CSRF_HEADER } from '@hinomi/shared'
import type { z } from 'zod'

export const API_BASE = '/api'

export type ApiErrorKind = 'network' | 'http' | 'parse'

/** Every failure from `api` is an ApiError, so views can branch on `kind` and `status`. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | undefined
  readonly path: string
  /** The server's error code (for example `validation_failed`), when it sent one. */
  readonly code: string | undefined
  /** The parsed error body, for answers that carry more than the message (a 409 with `previous`). */
  readonly body: unknown

  constructor(
    kind: ApiErrorKind,
    path: string,
    message: string,
    {
      status,
      cause,
      code,
      body,
    }: { status?: number; cause?: unknown; code?: string; body?: unknown } = {},
  ) {
    super(message, { cause })
    this.name = 'ApiError'
    this.kind = kind
    this.path = path
    this.status = status
    this.code = code
    this.body = body
  }
}

/**
 * The session's CSRF token (GET /api/auth/session sets it), sent with every change while the
 * built in login is on. Null when the login is off or nobody is signed in.
 */
let csrfToken: string | null = null
export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

/** Called when the server says the session is gone, so the app can go to the login page. */
let onUnauthenticated: (() => void) | null = null
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** Serialized as JSON with the matching content type. */
  json?: unknown
}

async function readBody(res: Response, path: string): Promise<unknown> {
  if (res.status === 204) return undefined
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new ApiError('parse', path, 'The server sent a response that is not JSON', {
      status: res.status,
      cause,
    })
  }
}

/** The server answers errors as `{ error: { code, message } }` (see apiErrorSchema). */
function serverError(body: unknown): { code?: string; message?: string } {
  const parsed = apiErrorSchema.safeParse(body)
  if (parsed.success) return parsed.data.error
  // Older or foreign servers may send a bare string.
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return { message: body.error }
  }
  return {}
}

/**
 * Fetches `${API_BASE}${path}` and parses the JSON body with `schema`, so callers get typed data
 * that matches the shared contract or an ApiError, never an unchecked shape.
 */
export async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  { json, headers, ...init }: RequestOptions = {},
): Promise<z.output<S>> {
  const finalHeaders = new Headers(headers)
  finalHeaders.set('accept', 'application/json')
  if (json !== undefined) finalHeaders.set('content-type', 'application/json')
  const method = (init.method ?? 'GET').toUpperCase()
  if (csrfToken && !SAFE_METHODS.has(method)) finalHeaders.set(CSRF_HEADER, csrfToken)

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: finalHeaders,
      body: json === undefined ? undefined : JSON.stringify(json),
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError('network', path, 'Could not reach the Hinomi server', { cause })
  }

  if (!res.ok) {
    // An error page from a proxy is often HTML; fall back to the status line.
    const body = await readBody(res, path).catch(() => undefined)
    const { code, message } = serverError(body)
    if (res.status === 401 && code === 'unauthenticated') onUnauthenticated?.()
    throw new ApiError('http', path, message ?? `The server answered ${res.status}`, {
      status: res.status,
      ...(code !== undefined && { code }),
      body,
    })
  }

  const body = await readBody(res, path)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ApiError('parse', path, 'The server response did not match the expected shape', {
      status: res.status,
      cause: parsed.error,
    })
  }
  return parsed.data
}

export const api = {
  get: <S extends z.ZodType>(path: string, schema: S, init?: Omit<RequestOptions, 'method'>) =>
    request(path, schema, { ...init, method: 'GET' }),
  post: <S extends z.ZodType>(
    path: string,
    schema: S,
    json?: unknown,
    init?: Omit<RequestOptions, 'method' | 'json'>,
  ) => request(path, schema, { ...init, method: 'POST', json }),
}
