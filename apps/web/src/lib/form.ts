import type { z } from 'zod'
import { ApiError } from './api'
import { describeError } from './errors'

/**
 * Checks one value against a schema from the shared contract and returns the
 * first issue as a sentence, or null when it passes. `empty` is used for a
 * blank value so required fields say what to enter instead of "Too small".
 */
export function checkField(schema: z.ZodType, value: string, empty?: string): string | null {
  if (empty !== undefined && value.trim() === '') return empty
  const result = schema.safeParse(value)
  if (result.success) return null
  const message = result.error.issues[0]?.message ?? 'This value is not valid'
  return message.endsWith('.') ? message : `${message}.`
}

/** True when the server refused to store a token because HINOMI_SECRET_KEY is not set. */
export function isSecretKeyMissing(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'secret_key_missing'
}

/** A server answer about the input itself (bad value, duplicate name), safe to show by the field. */
export function isInputError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && (error.code === 'validation_failed' || error.code === 'conflict')
  )
}

/** The server's message for input errors, otherwise the general description. */
export function mutationMessage(error: unknown): string {
  if (isInputError(error)) {
    // Strip the generic prefix of schema errors: "Invalid request body: url: ..." reads badly by a field.
    const message = error.message.replace(/^Invalid request body: (?:[\w.]+: )?/, '')
    return message.endsWith('.') ? message : `${message}.`
  }
  return describeError(error)
}

/** "coolify.example.dev" from a URL, for a default source name. Falls back to the input. */
export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host || url.trim()
  } catch {
    return url.trim()
  }
}
