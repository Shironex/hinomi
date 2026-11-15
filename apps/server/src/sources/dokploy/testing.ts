import { readFileSync } from 'node:fs'

// A fake Dokploy instance for tests, answering from the recorded fixtures. Every name, host and
// secret in them is fictional; every secret value starts with FAKE-SECRET so a test can prove
// none of them is kept.

export const SECRET_MARKER = 'FAKE-SECRET'

export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')

/** Answers by route and id; anything else is a 404. */
export function dokployRoutes(): Record<string, string> {
  return {
    'project.all': fixture('project-all'),
    'application.one?applicationId=app-harbor-0001': fixture('application-harbor'),
    'application.one?applicationId=app-proxy-0002': fixture('application-proxy'),
    'application.one?applicationId=app-lantern-0003': fixture('application-lantern'),
    'compose.one?composeId=cmp-docs-0001': fixture('compose-docs'),
    'settings.getDokployVersion': '"v0.25.0"',
  }
}

export interface AskedRequest {
  route: string
  method: string
  apiKey: string | undefined
}

export function fakeDokployFetch(routes: Record<string, string | Response> = dokployRoutes()): {
  impl: typeof fetch
  asked: AskedRequest[]
} {
  const asked: AskedRequest[] = []
  const impl = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const route = url.pathname.replace(/^\/api\//, '') + url.search
    const headers = init.headers as Record<string, string>
    asked.push({ route, method: init.method ?? 'GET', apiKey: headers['x-api-key'] })
    const body = routes[route]
    if (body instanceof Response) return Promise.resolve(body)
    return Promise.resolve(
      body === undefined ? new Response('not found', { status: 404 }) : new Response(body),
    )
  }) as typeof fetch
  return { impl, asked }
}
