import { IconExternalLink, IconKey } from '@tabler/icons-react'
import { FineGrainedToken } from '@/components/token/fine-grained-token'
import { Button } from '@/components/ui/button'

/** The classic token form, prefilled with the scopes Hinomi reads and a name. */
export const CLASSIC_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,security_events&description=Hinomi'

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
      <FineGrainedToken
        preset="reading"
        label="Create a fine grained token"
        intro="Opens GitHub with the read permissions below ticked."
      />
      <p className="text-foreground-2">
        If the repos belong to an organization with SAML SSO, open the token on GitHub and use
        Configure SSO to authorize it for that organization, or its repos stay hidden.
      </p>
    </section>
  )
}
