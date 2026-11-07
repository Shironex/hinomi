import { IconExternalLink, IconKey } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { presetTokenUrl, TOKEN_PRESETS, type TokenPreset } from '@/lib/github-token-url'

/**
 * A prefilled fine grained token link with the permissions it ticks and the one thing GitHub
 * cannot prefill: which repositories the token reaches.
 */
export function FineGrainedToken({
  preset,
  owner,
  label,
  intro,
}: {
  preset: TokenPreset
  /** The repo owner, preselected as the token's resource owner when known. */
  owner?: string | null
  label: string
  intro: string
}) {
  const { permissions } = TOKEN_PRESETS[preset]
  return (
    <div className="flex flex-col gap-2 text-sm text-foreground-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="outline">
          <a href={presetTokenUrl(preset, owner)} target="_blank" rel="noreferrer noopener">
            <IconKey aria-hidden="true" stroke={1.75} />
            {label}
            <IconExternalLink aria-hidden="true" stroke={1.75} />
          </a>
        </Button>
        <span>{intro}</span>
      </div>
      <ul className="m-0 list-disc pl-5">
        {permissions.map((permission) => (
          <li key={permission.param}>
            <b className="font-medium text-foreground">
              {permission.label}: {permission.level}
            </b>
            : {permission.purpose}
            {permission.optional ? ' (optional, untick it to skip)' : null}
          </li>
        ))}
      </ul>
      <p>
        GitHub cannot prefill the repositories: choose{' '}
        <b className="font-medium text-foreground">Only select repositories</b> and pick the repos{' '}
        {preset === 'runner' ? 'the runner works on' : 'to watch'}.
      </p>
    </div>
  )
}
