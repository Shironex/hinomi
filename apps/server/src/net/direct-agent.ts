import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'

// Agents that always connect straight to the host. With NODE_USE_ENV_PROXY set, Node's global
// agents send requests through HTTP_PROXY or HTTPS_PROXY, and the proxy then resolves the host:
// the public address check in the connection's DNS lookup would never run. Requests to a host a
// user named use these agents, so a proxy setting can never switch that check off.

export const directHttpAgent = new HttpAgent({ keepAlive: false })
export const directHttpsAgent = new HttpsAgent({ keepAlive: false })

export function directAgent(url: URL): HttpAgent {
  return url.protocol === 'https:' ? directHttpsAgent : directHttpAgent
}
