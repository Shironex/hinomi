import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import type { FixPayloadCompressor } from '@hinomi/shared'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/**
 * Most bytes a decompressed plan may have. A full plan of 200 steps is well under 1 MiB, and the
 * cap stops a small payload from inflating without bound.
 */
export const MAX_DECOMPRESSED_PLAN_BYTES = 4 * 1024 * 1024

/** gzip plus base64 on node:zlib, for encodeFixDispatch and decodeFixDispatch. */
export const zlibCompressor: FixPayloadCompressor = {
  async compress(text) {
    const packed = await gzipAsync(Buffer.from(text, 'utf8'))
    return packed.toString('base64')
  },
  async decompress(base64) {
    const unpacked = await gunzipAsync(Buffer.from(base64, 'base64'), {
      maxOutputLength: MAX_DECOMPRESSED_PLAN_BYTES,
    })
    return unpacked.toString('utf8')
  },
}
