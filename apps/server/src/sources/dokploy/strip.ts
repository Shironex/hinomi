// Dokploy answers with secrets next to the inventory: `project.all` returns database passwords
// in plain text on older versions, and the per resource routes return environment variables,
// registry credentials and webhook tokens (docs/design/phase-2.md section 9.4). Every response
// goes through here while it is parsed, so nothing secret looking is ever logged, parsed
// further or stored.

/** Keys whose value is dropped wherever they appear, at any depth. */
export const SECRET_KEY_PATTERN = /password|secret|token|key/i

/**
 * Keys that hold environment variables, build arguments or a raw compose file. They do not look
 * like secrets by name but carry them, so they are dropped too.
 */
const PRIVATE_KEYS = new Set(['env', 'previewEnv', 'buildArgs', 'previewBuildArgs', 'composeFile'])

/** True when a key's value must never be kept. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || PRIVATE_KEYS.has(key)
}

/** A copy of a parsed JSON value without any secret key, at any depth. */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (typeof value !== 'object' || value === null) return value
  // fromEntries defines own properties, so a `__proto__` key cannot reach the prototype.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSecretKey(key))
      .map(([key, inner]) => [key, stripSecrets(inner)]),
  )
}

/**
 * Parses a Dokploy response body and drops every secret key while parsing (the reviver runs
 * before the object exists for anyone else). Throws a SyntaxError on bad JSON, whose message
 * can quote the body, so callers drop it rather than pass it on.
 */
export function parseStripped(body: string): unknown {
  return JSON.parse(body, (key, inner: unknown) => (isSecretKey(key) ? undefined : inner))
}
