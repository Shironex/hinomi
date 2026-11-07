// Building blocks of the receivers on the internet facing paths (the GitHub webhook and the
// webhook runner callback): a capped body read and a replay log of delivery ids.

/** Reads at most `max` bytes of the body; null when it is longer. */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  // Leaving the loop early cancels the stream, so an oversized body is not read to its end.
  for await (const chunk of request.body as ReadableStream<Uint8Array>) {
    size += chunk.byteLength
    if (size > max) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Delivery ids seen in the replay window, oldest first. */
export class DeliveryLog {
  readonly #seen = new Map<string, number>()
  readonly #windowMs: number
  readonly #max: number

  constructor(windowMs: number, max: number) {
    this.#windowMs = windowMs
    this.#max = max
  }

  /** True when the id was seen inside the window; remembers it otherwise. */
  replayed(id: string, at: number): boolean {
    for (const [seenId, seenAt] of this.#seen) {
      if (seenAt > at - this.#windowMs) break
      this.#seen.delete(seenId)
    }
    if (this.#seen.has(id)) return true
    this.#seen.set(id, at)
    while (this.#seen.size > this.#max) {
      const oldest = this.#seen.keys().next()
      if (oldest.done) break
      this.#seen.delete(oldest.value)
    }
    return false
  }

  /** Forgets an id, so a retry of a delivery that could not be handled is not a replay. */
  forget(id: string): void {
    this.#seen.delete(id)
  }
}
