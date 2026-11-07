// Prefilled links to GitHub's fine grained token form. GitHub reads `name`, `description`,
// `target_name` (the resource owner), `expires_in` (days) and one parameter per permission from
// the URL. The repository selection cannot be prefilled: the person picks "Only select
// repositories" on GitHub and chooses the repos. (Checks is not a fine grained token permission.)

export const FINE_GRAINED_TOKEN_FORM_URL = 'https://github.com/settings/personal-access-tokens/new'

/** Days a prefilled token lives, GitHub's own suggestion. */
const EXPIRES_IN_DAYS = 90

export type TokenPermissionLevel = 'read' | 'write'

export interface TokenPermission {
  /** GitHub's URL parameter name for the permission. */
  param: string
  level: TokenPermissionLevel
  /** As GitHub's form shows it. */
  label: string
  /** What Hinomi uses it for. */
  purpose: string
  /** Prefilled, but the token works without it. */
  optional?: boolean
}

export type TokenPreset = 'reading' | 'runner'

/** Reading a repo's alerts and lockfiles (onboarding and the GitHub source). */
export const READING_PERMISSIONS: readonly TokenPermission[] = [
  { param: 'metadata', level: 'read', label: 'Metadata', purpose: 'lists the repos' },
  {
    param: 'contents',
    level: 'read',
    label: 'Contents',
    purpose: 'reads lockfiles for the OSV.dev scan',
  },
  {
    param: 'vulnerability_alerts',
    level: 'read',
    label: 'Dependabot alerts',
    purpose: 'reads the alerts',
  },
  {
    param: 'administration',
    level: 'read',
    label: 'Administration',
    purpose: 'tells whether Dependabot alerts are switched on',
    optional: true,
  },
]

/** The fix runner: dispatch the workflow, push the fix branch, open its pull request. */
export const RUNNER_PERMISSIONS: readonly TokenPermission[] = [
  {
    param: 'actions',
    level: 'write',
    label: 'Actions',
    purpose: 'dispatches the fix workflow and follows its runs',
  },
  { param: 'contents', level: 'write', label: 'Contents', purpose: 'pushes the fix branch' },
  {
    param: 'workflows',
    level: 'write',
    label: 'Workflows',
    purpose: 'only for the setup PR that adds the caller workflow',
    optional: true,
  },
  {
    param: 'pull_requests',
    level: 'write',
    label: 'Pull requests',
    purpose: 'opens and updates the fix pull request',
  },
  {
    param: 'statuses',
    level: 'read',
    label: 'Commit statuses',
    purpose: 'follows the checks on the pull request',
  },
  {
    param: 'vulnerability_alerts',
    level: 'read',
    label: 'Dependabot alerts',
    purpose: 'reads the alerts the plan targets',
  },
  { param: 'metadata', level: 'read', label: 'Metadata', purpose: 'lists the repos' },
]

interface PresetInfo {
  name: string
  description: string
  permissions: readonly TokenPermission[]
}

export const TOKEN_PRESETS: Record<TokenPreset, PresetInfo> = {
  reading: {
    name: 'Hinomi',
    description: 'Hinomi reads advisories, lockfiles and Dependabot alerts',
    permissions: READING_PERMISSIONS,
  },
  runner: {
    name: 'Hinomi runner',
    description: 'The Hinomi fix runner opens fix pull requests',
    permissions: RUNNER_PERMISSIONS,
  },
}

export interface FineGrainedTokenOptions {
  name: string
  description: string
  /** The user or organization that owns the repos; GitHub preselects it as resource owner. */
  owner?: string | null
  permissions: readonly TokenPermission[]
}

/** The fine grained token form with the name, owner, expiry and permissions filled in. */
export function fineGrainedTokenUrl(options: FineGrainedTokenOptions): string {
  const params = new URLSearchParams()
  params.set('name', options.name)
  params.set('description', options.description)
  if (options.owner) params.set('target_name', options.owner)
  params.set('expires_in', String(EXPIRES_IN_DAYS))
  for (const permission of options.permissions) params.set(permission.param, permission.level)
  return `${FINE_GRAINED_TOKEN_FORM_URL}?${params.toString()}`
}

/** The prefilled link of a preset, with the repo owner when known. */
export function presetTokenUrl(preset: TokenPreset, owner?: string | null): string {
  const { name, description, permissions } = TOKEN_PRESETS[preset]
  return fineGrainedTokenUrl({ name, description, owner, permissions })
}

/** The owner part of `owner/name`, or null when it is not one. */
export function ownerOf(fullName: string | null | undefined): string | null {
  const owner = fullName?.split('/')[0]
  return owner ? owner : null
}
