import type { DeploymentDetail } from '@hinomi/shared'
import { IconAlertOctagon, IconBox, IconCalendarOff } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { ImageSecurityChip } from '@/components/views/image-security-chip'
import { Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import { formatRelative } from '@/lib/format'
import { IMAGE_SECURITY_INFO, safeHttpUrl } from '@/lib/image-security-meta'

/** Text from Coolify is untrusted: it renders as plain text, and only an http(s) value links. */
function PlainOrLink({ value }: { value: string }) {
  const href = safeHttpUrl(value)
  if (!href) return <>{value}</>
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent-ink hover:underline"
    >
      {value}
    </a>
  )
}

/**
 * What Coolify's image scan says about the images of one deployment: its verdict, how many
 * findings are known exploited, the version moves it recommends and an end of life OS.
 * Shown only once an image scan has read the deployment.
 */
export function ImageSecurityPanel({ d }: { d: DeploymentDetail }) {
  const s = d.imageSecurity
  if (!s) return null
  return (
    <Panel aria-labelledby="dep-image-security">
      <PanelHeader title={<span id="dep-image-security">Image security</span>} icon={IconBox}>
        {s.exploitedCount > 0 ? (
          <Badge variant="critical">
            <IconAlertOctagon aria-hidden="true" stroke={2} />
            {s.exploitedCount} exploited
          </Badge>
        ) : null}
        <ImageSecurityChip security={s} />
      </PanelHeader>
      <PanelBody className="flex flex-col gap-3 text-sm">
        <p className="m-0 text-foreground-2">{IMAGE_SECURITY_INFO[s.status].explain}</p>
        {s.actions.length ? (
          <ul aria-label="Recommended actions" className="m-0 flex list-none flex-col p-0">
            {s.actions.map((a, i) => (
              <li
                key={`${a.type}:${a.image ?? ''}:${a.target ?? ''}:${i}`}
                className="flex flex-col gap-1 border-t border-border py-2.5 first:border-t-0 first:pt-0 last:pb-0"
              >
                <span className="break-words text-foreground">
                  <PlainOrLink value={a.sentence} />
                </span>
                {a.image || a.target ? (
                  <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs break-all text-muted-foreground">
                    {a.image ? <span>{a.image}</span> : null}
                    {a.image && a.target ? <span aria-hidden="true">&#8594;</span> : null}
                    {a.target ? <b className="font-medium text-success">{a.target}</b> : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {s.eol ? (
          <p className="m-0 flex items-start gap-2 text-foreground-2">
            <IconCalendarOff
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-sev-moderate"
              stroke={1.75}
            />
            <span className="min-w-0 break-words">
              End of life OS:{' '}
              <b className="font-semibold text-foreground">
                {s.eol.name} {s.eol.version}
              </b>
              {s.eol.fixed ? ', an action above moves off it' : ', it gets no security fixes'}
            </span>
          </p>
        ) : null}
        {s.checkedAt ? (
          <small className="text-xs text-muted-foreground">
            Rated by Coolify {formatRelative(s.checkedAt)}
          </small>
        ) : null}
      </PanelBody>
    </Panel>
  )
}
