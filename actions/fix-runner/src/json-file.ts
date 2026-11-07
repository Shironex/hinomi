// package.json edits that keep the file's own layout: the indent it uses, its key order and
// whether it ends with a newline. Keys keep their place because JSON.parse keeps insertion
// order; a new key goes at the end of its object.

export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject

export interface JsonFile {
  data: JsonObject
  indent: string
  eol: string
  finalNewline: boolean
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses a JSON object file and remembers its layout. Throws on anything else. */
export function parseJsonFile(text: string): JsonFile {
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!isJsonObject(data)) throw new Error('Expected a JSON object')
  const indent = /^[{[][\r\n]+([ \t]+)\S/.exec(text)?.[1] ?? '  '
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { data, indent, eol, finalNewline: /\n$/.test(text) }
}

export function stringifyJsonFile(file: JsonFile): string {
  const body = JSON.stringify(file.data, null, file.indent)
  const text = file.eol === '\n' ? body : body.replace(/\n/g, file.eol)
  return file.finalNewline ? text + file.eol : text
}

/** The object at `key` of `parent`, created at the end of `parent` when missing. */
export function objectAt(parent: JsonObject, key: string): JsonObject {
  const current = parent[key]
  if (isJsonObject(current)) return current
  const created: JsonObject = {}
  parent[key] = created
  return created
}
