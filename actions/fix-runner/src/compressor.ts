import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import type { FixPayloadCompressor } from '@hinomi/shared'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/**
 * Most bytes a decoded plan may have. The input itself is at most 65,535 characters, and a
 * dispatch of 200 steps is well under 1 MiB, so anything larger is a zip bomb.
 */
export const MAX_DECODED_BYTES = 4 * 1024 * 1024

/** gzip plus base64 on node:zlib, with the decompressed size capped. */
export const nodeCompressor: FixPayloadCompressor = {
  async compress(text) {
    return (await gzipAsync(Buffer.from(text, 'utf8'))).toString('base64')
  },
  async decompress(base64) {
    const compact = base64.replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error('not base64')
    const bytes = await gunzipAsync(Buffer.from(compact, 'base64'), {
      maxOutputLength: MAX_DECODED_BYTES,
    })
    return bytes.toString('utf8')
  },
}
