import { randomUUID } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import {
  RUNNER_DELIVERY_HEADER,
  RUNNER_EVENT_HEADER,
  RUNNER_SIGNATURE_HEADER,
  currentTime,
  type WebhookDispatchBody,
} from '@hinomi/shared'
import { checkRunnerUrl, isPublicAddress } from './ssrf.js'
import { secretProblem, type WebhookRunnerSettings } from './runner-settings.js'
import { signRunnerPayload } from './signature.js'

// Posts a fix plan to the webhook runner. The request is signed with the shared secret, never
// follows a redirect (the signed body would travel to a second host), gives up after a short
// timeout, and reads at most a few KiB of the answer for the failure reason. Unless private
// addresses are allowed, the address check runs inside the connection's own DNS lookup, so a
// host cannot resolve to a public address for a check and a private one for the request.
//
// node:http and node:https instead of fetch: fetch offers no hook into the address it connects
// to, and that hook is the whole point here.

/** How long a dispatch may take before it counts as failed. */
export const RUNNER_DISPATCH_TIMEOUT_MS = 15_000
/** Bytes of the answer kept for the failure reason. */
const MAX_ANSWER_BYTES = 4096
const MAX_ANSWER_CHARS = 200

export interface RunnerPostRequest {
  url: URL
  body: string
  headers: Record<string, string>
  /** Allows private addresses (the URL check already allowed plain http). */
  allowPrivate: boolean
  timeoutMs: number
}

export interface RunnerPostAnswer {
  status: number
  /** At most MAX_ANSWER_BYTES of the answer, as text. */
  body: string
  location: string | null
}

/** Sends one request. Replaced in tests. Rejects on network errors and refused addresses. */
export type RunnerPoster = (request: RunnerPostRequest) => Promise<RunnerPostAnswer>

/** An error whose message is safe to store as the run's failure reason. */
function refusedAddress(hostname: string, address: string): Error {
  return Object.assign(
    new Error(
      `${hostname} resolves to ${address}, which is not a public address. Allow private addresses to use it.`,
    ),
    { code: 'ENOTPUBLIC' },
  )
}

/** dns.lookup that refuses names resolving to any address that is not public. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 4)
      return
    }
    const bad = addresses.find((entry) => !isPublicAddress(entry.address))
    const first = addresses[0]
    if (bad || !first) {
      callback(refusedAddress(hostname, bad?.address ?? 'nothing'), '', 4)
      return
    }
    if (options.all) {
      ;(callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses)
      return
    }
    callback(null, first.address, first.family)
  })
}

function readAnswer(response: IncomingMessage): Promise<RunnerPostAnswer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const done = () => {
      const location = response.headers.location
      resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        location: typeof location === 'string' ? location : null,
      })
    }
    response.on('data', (chunk: Buffer) => {
      if (size >= MAX_ANSWER_BYTES) return
      chunks.push(chunk.subarray(0, MAX_ANSWER_BYTES - size))
      size += chunk.length
      if (size < MAX_ANSWER_BYTES) return
      // Enough for a reason; the rest of the answer is not read.
      response.destroy()
      done()
    })
    response.on('end', done)
    response.on('error', done)
  })
}

/** The real poster: one request, no redirects, the address guard unless private is allowed. */
export const nodeRunnerPoster: RunnerPoster = (input) =>
  new Promise((resolve, reject) => {
    const send = input.url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(
      input.url,
      {
        method: 'POST',
        headers: { ...input.headers, 'content-length': String(Buffer.byteLength(input.body)) },
        timeout: input.timeoutMs,
        ...(!input.allowPrivate && { lookup: publicOnlyLookup }),
      },
      (response) => {
        readAnswer(response).then(resolve, reject)
      },
    )
    request.on('timeout', () => {
      request.destroy(
        new Error(`no answer within ${Math.max(1, Math.round(input.timeoutMs / 1000))} s`),
      )
    })
    request.on('error', reject)
    request.end(input.body)
  })

/** The plan to post, without the callback URL the settings add. */
export type RunnerDispatchPayload = Omit<WebhookDispatchBody, 'callbackUrl'>

export type RunnerDeliveryOutcome = { ok: true } | { ok: false; reason: string }

export interface WebhookRunnerTransport {
  /** Why nothing can be posted (no URL, no secret, a refused URL), or null when ready. */
  problem(): string | null
  /** Posts the plan. Never throws. */
  deliver(payload: RunnerDispatchPayload): Promise<RunnerDeliveryOutcome>
}

export interface WebhookRunnerTransportOptions {
  settings: WebhookRunnerSettings
  post?: RunnerPoster
  now?: () => Date
  timeoutMs?: number
  /** The delivery id. Random by default. */
  deliveryId?: () => string
}

function oneLine(text: string): string {
  const flat = text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > MAX_ANSWER_CHARS ? `${flat.slice(0, MAX_ANSWER_CHARS - 1)}.` : flat
}

export function createWebhookRunnerTransport(
  options: WebhookRunnerTransportOptions,
): WebhookRunnerTransport {
  const { settings } = options
  const post = options.post ?? nodeRunnerPoster
  const now = options.now ?? currentTime

  function target():
    | { ok: true; url: URL; secret: string; allowPrivate: boolean; callbackUrl: string | null }
    | { ok: false; message: string } {
    const config = settings.read()
    if (!config.url) return { ok: false, message: 'Set the webhook runner URL first.' }
    const secret = settings.secret()
    if (!secret.ok) return { ok: false, message: secretProblem(secret.reason) }
    const checked = checkRunnerUrl(config.url, config.allowPrivate)
    if (!checked.ok) return { ok: false, message: checked.message }
    return {
      ok: true,
      url: checked.url,
      secret: secret.secret,
      allowPrivate: config.allowPrivate,
      callbackUrl: config.callbackUrl,
    }
  }

  return {
    problem() {
      const resolved = target()
      return resolved.ok ? null : resolved.message
    },

    async deliver(payload) {
      const resolved = target()
      if (!resolved.ok) return { ok: false, reason: resolved.message }
      const body = JSON.stringify({ ...payload, callbackUrl: resolved.callbackUrl })
      const host = resolved.url.host
      try {
        const answer = await post({
          url: resolved.url,
          body,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'hinomi-webhook-runner',
            [RUNNER_EVENT_HEADER]: 'dispatch',
            [RUNNER_DELIVERY_HEADER]: (options.deliveryId ?? randomUUID)(),
            [RUNNER_SIGNATURE_HEADER]: signRunnerPayload(resolved.secret, body, now()),
          },
          allowPrivate: resolved.allowPrivate,
          timeoutMs: options.timeoutMs ?? RUNNER_DISPATCH_TIMEOUT_MS,
        })
        if (answer.status >= 200 && answer.status < 300) return { ok: true }
        if (answer.status >= 300 && answer.status < 400) {
          return {
            ok: false,
            reason: `The webhook runner at ${host} answered with a redirect (${answer.status}); Hinomi never follows redirects with a signed plan. Set the final URL in the settings.`,
          }
        }
        const detail = oneLine(answer.body)
        return {
          ok: false,
          reason: `The webhook runner at ${host} refused the plan with HTTP ${answer.status}${detail ? `: ${detail}` : '.'}`,
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          reason: `The webhook runner at ${host} could not be reached: ${oneLine(detail)}`,
        }
      }
    },
  }
}
