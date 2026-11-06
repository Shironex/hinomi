import { IconExternalLink, IconKey } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

/** The classic token form, prefilled with the scopes Hinomi reads and a name. */
export const CLASSIC_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,security_events&description=Hinomi'
export const FINE_GRAINED_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

/** Read permissions a fine grained token needs on the repos to watch. */
const FINE_GRAINED_PERMISSIONS = [
  ['Metadata', 'lists the repos'],
  ['Contents', 'reads lockfiles for the OSV.dev scan'],
  ['Dependabot alerts', 'reads the alerts'],
  ['Administration', 'optional, tells whether Dependabot alerts are switched on'],
] as const

const linkClass =
  'inline-flex items-center gap-1 text-accent-ink underline-offset-2 hover:underline'

/** Where to get a GitHub token, shown above the token form in setup. */
export function GithubTokenHelp() {
  return (
    <section
      aria-label="Create a GitHub token"
      className="flex flex-col gap-3 rounded-lg border border-border bg-sidebar px-5 py-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="outline">
          <a href={CLASSIC_TOKEN_URL} target="_blank" rel="noreferrer noopener">
            <IconKey aria-hidden="true" stroke={1.75} />
            Create a classic token
            <IconExternalLink aria-hidden="true" stroke={1.75} />
          </a>
        </Button>
        <span className="text-foreground-2">
          Opens GitHub with the repo and security_events scopes ticked.
        </span>
      </div>
      <div className="text-foreground-2">
        <p>
          Or{' '}
          <a
            href={FINE_GRAINED_TOKEN_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={linkClass}
          >
            create a fine grained token
            <IconExternalLink aria-hidden="true" className="size-3.5" stroke={1.75} />
          </a>{' '}
          with read access on the repos to watch:
        </p>
        <ul className="mt-1 list-disc pl-5">
          {FINE_GRAINED_PERMISSIONS.map(([name, why]) => (
            <li key={name}>
              <b className="font-medium text-foreground">{name}</b>: {why}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-foreground-2">
        If the repos belong to an organization with SAML SSO, open the token on GitHub and use
        Configure SSO to authorize it for that organization, or its repos stay hidden.
      </p>
    </section>
  )
}
