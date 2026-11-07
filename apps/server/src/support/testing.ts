import { readFileSync } from 'node:fs'
import { parseProductsFull, type ParsedSupportData } from './products.js'

// Test helpers for the support data. The fixture is a trimmed recording of
// https://endoflife.date/api/v1/products/full (MIT licensed data) taken 2026-11-07: nodejs, bun,
// rust, nextjs and angular with a few release lines each. Tests never reach the network.

/** The day the fixture was recorded; the lines' states are asserted against it. */
export const FIXTURE_NOW = new Date('2026-11-07T12:00:00.000Z')

export const FIXTURE_ETAG = 'W/"2360c620beea417922ac552461e66261-ssl"'

export function fixtureText(): string {
  return readFileSync(new URL('./fixtures/products-full.json', import.meta.url), 'utf8')
}

export function fixtureData(): ParsedSupportData {
  return parseProductsFull(fixtureText())
}

/** A `products/full` body with these products (each given as a raw API object). */
export function bodyOf(...products: unknown[]): string {
  return JSON.stringify({
    schema_version: '1.2.1',
    generated_at: '2026-11-07T02:38:40+00:00',
    result: products,
  })
}
