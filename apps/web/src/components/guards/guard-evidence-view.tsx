import type { ReactNode } from 'react'
import type {
  ActionRuntimeEvidence,
  DockerSocketEvidence,
  FixHint,
  FrameworkSupportEvidence,
  GuardEvidence,
  GuardResult,
  RootUserEvidence,
  RuntimePin,
  RuntimePinsDisagreeEvidence,
  RuntimeSupportEvidence,
  SharedNetworkEvidence,
  WatchPathsSkipEvidence,
} from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import { IconDatabase, IconHelpCircle, IconInfoCircle } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Callout } from '@/components/ui/callout'
import { KeyValues } from '@/components/views/panel'
import {
  fileAt,
  MOUNT_SOURCE_LABEL,
  NETWORK_BASIS_LABEL,
  PIN_SOURCE_LABEL,
  RUNTIME_LABEL,
  supportDate,
} from '@/lib/guard-meta'
import { cn } from '@/lib/utils'
import { GuardResultBadge } from './guard-badges'

/**
 * The evidence of a guard finding, readable per check: where the signal came from, the values
 * read and the files and lines to change. Never raw JSON. An unknown result leads with why.
 */

const CODE = 'rounded-sm bg-muted px-1.5 py-px font-mono text-[13px] text-foreground'
const LIST =
  'm-0 flex list-none flex-col overflow-hidden rounded-lg border border-border bg-card p-0'
const ITEM =
  'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-border px-4 py-3 text-sm first:border-t-0'

function Code({ children }: { children: ReactNode }) {
  return <code className={CODE}>{children}</code>
}

/** One entry of a list with a result badge on the right and details under it. */
function ResultItem({
  title,
  result,
  children,
}: {
  title: ReactNode
  result: GuardResult
  children?: ReactNode
}) {
  return (
    <li className={ITEM}>
      <span className="min-w-0 font-medium break-words">{title}</span>
      <GuardResultBadge result={result} />
      {children ? (
        <span className="col-span-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {children}
        </span>
      ) : null}
    </li>
  )
}

function Hints({ hints }: { hints: readonly FixHint[] }) {
  if (!hints.length) return null
  return (
    <ul aria-label="Edits to make" className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
      {hints.map((h) => (
        <li key={`${h.path}:${h.line ?? 0}`} className="font-mono text-xs text-foreground-2">
          {fileAt(h.path, h.line)}: {h.from} <span aria-label="to">→</span>{' '}
          <b className="font-semibold text-success">{h.to}</b>
        </li>
      ))}
    </ul>
  )
}

function RootUser({ e }: { e: RootUserEvidence }) {
  const source = {
    docker_inspect: 'Docker inspect of the running container',
    run_options: 'The run options of the deployment',
    compose: 'The compose file',
    dockerfile: e.path ? fileAt(e.path, e.line) : 'The inline Dockerfile',
    none: 'No source reports it',
  }[e.source]
  return (
    <div className="flex flex-col gap-3">
      <KeyValues
        className="max-w-[560px]"
        items={[
          { label: 'Read from', value: source, mono: e.source === 'dockerfile' && !!e.path },
          {
            label: 'User',
            value: e.user === null ? 'None set' : e.user === '' || e.user === '0' ? 'root' : e.user,
            mono: e.user !== null,
          },
          ...(e.from ? [{ label: 'Base image', value: e.from, mono: true }] : []),
          ...(e.stage ? [{ label: 'Final stage', value: e.stage, mono: true }] : []),
          ...(e.commit ? [{ label: 'At commit', value: e.commit.slice(0, 7), mono: true }] : []),
        ]}
      />
      {e.services.length ? (
        <ul aria-label="Compose services" className={LIST}>
          {e.services.map((s) => (
            <ResultItem
              key={s.name}
              title={<span className="font-mono">{s.name}</span>}
              result={s.result}
            >
              <span>
                User {s.user ? <Code>{s.user}</Code> : 'not set'}
                {s.image ? (
                  <>
                    , image <Code>{s.image}</Code>
                  </>
                ) : (
                  ', built from the repo'
                )}
              </span>
            </ResultItem>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function DockerSocket({ e }: { e: DockerSocketEvidence }) {
  return (
    <div className="flex flex-col gap-3">
      {e.mounts.length ? (
        <ul aria-label="Socket mounts" className={LIST}>
          {e.mounts.map((m, i) => (
            <li key={i} className={ITEM}>
              <span className="min-w-0 font-mono text-[13px] break-all">
                {m.hostPath}
                {m.containerPath ? (
                  <>
                    {' '}
                    <span aria-label="mounted at">→</span> {m.containerPath}
                  </>
                ) : null}
              </span>
              {m.readOnly ? <Badge variant="outline">Read only</Badge> : <span />}
              <span className="col-span-2 text-xs text-muted-foreground">
                From {MOUNT_SOURCE_LABEL[m.source].toLowerCase()}
                {m.service ? `, service ${m.service}` : ''}
                {m.readOnly ? '. Read only still allows every Docker API call.' : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {e.checked.length
          ? `Checked: ${e.checked.map((s) => MOUNT_SOURCE_LABEL[s]).join(', ')}.`
          : 'No mount source could be read.'}
      </p>
    </div>
  )
}

function SharedNetwork({ e }: { e: SharedNetworkEvidence }) {
  const dest = e.destination
  return (
    <div className="flex flex-col gap-3">
      <KeyValues
        className="max-w-[560px]"
        items={[
          ...(e.basis ? [{ label: 'How', value: NETWORK_BASIS_LABEL[e.basis] }] : []),
          ...(e.network ? [{ label: 'Network', value: e.network, mono: true }] : []),
          ...(dest
            ? [
                {
                  label: 'Destination',
                  value: `${dest.type ?? 'destination'} ${dest.id}${dest.server ? ` on ${dest.server}` : ''}`,
                  mono: true,
                },
              ]
            : []),
          ...(e.project ? [{ label: 'Its project', value: e.project, mono: true }] : []),
        ]}
      />
      {e.peers.length ? (
        <ul aria-label="Other projects on the network" className={LIST}>
          {e.peers.map((p) => (
            <li key={`${p.deploymentId ?? p.name}`} className={ITEM}>
              <span className="min-w-0 truncate font-medium">
                {p.deploymentId ? (
                  <Link
                    to="/deployments/$id"
                    params={{ id: String(p.deploymentId) }}
                    className="text-foreground hover:underline"
                  >
                    {p.name}
                  </Link>
                ) : (
                  p.name
                )}
              </span>
              {p.database ? (
                <Badge variant="high">
                  <IconDatabase aria-hidden="true" />
                  Database
                </Badge>
              ) : (
                <span />
              )}
              <span className="col-span-2 text-xs text-muted-foreground">
                Project <span className="font-mono">{p.project ?? 'unknown'}</span>
                {p.deploymentId ? '' : ', not in the deployment list'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function WatchPaths({ e }: { e: WatchPathsSkipEvidence }) {
  const skipped = new Set(e.skipped)
  return (
    <div className="flex flex-col gap-3">
      <KeyValues
        className="max-w-[560px]"
        items={[
          {
            label: 'Auto deploy',
            value: e.autoDeploy === null ? 'Not reported' : e.autoDeploy ? 'On' : 'Off',
          },
          {
            label: 'Watch paths',
            value: e.patterns.length ? e.patterns.join(', ') : 'None',
            mono: e.patterns.length > 0,
          },
        ]}
      />
      {e.checked.length ? (
        <ul aria-label="Files checked" className={LIST}>
          {e.checked.map((path) => (
            <li key={path} className={ITEM}>
              <span className="min-w-0 font-mono text-[13px] break-all">{path}</span>
              <span
                className={cn(
                  'text-xs font-medium',
                  skipped.has(path) ? 'text-sev-moderate' : 'text-success',
                )}
              >
                {skipped.has(path) ? 'Skipped, no deploy' : 'Triggers a deploy'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Frameworks({ e }: { e: FrameworkSupportEvidence }) {
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Frameworks" className={LIST}>
        {e.frameworks.map((f) => (
          <ResultItem
            key={f.purl}
            result={f.result}
            title={
              <span className="font-mono">
                {f.packageName} {f.installedVersion}
              </span>
            }
          >
            <span>
              {f.support
                ? `Line ${f.support.line}, security support ${supportDate(f.support)}`
                : 'No release line in the support data matches this version'}
              {f.manifestPath ? `. ${f.manifestPath}` : ''}
            </span>
            {f.target ? (
              <span>
                Move to line <Code>{f.target.line}</Code>
                {f.target.latest ? (
                  <>
                    , latest <Code>{f.target.latest}</Code>
                  </>
                ) : null}
              </span>
            ) : null}
          </ResultItem>
        ))}
      </ul>
      {e.ref ? <p className="text-xs text-muted-foreground">Read at {e.ref}.</p> : null}
    </div>
  )
}

function pinText(pin: RuntimePin): string {
  return `${PIN_SOURCE_LABEL[pin.source]} in ${fileAt(pin.path, pin.line)}`
}

function RuntimeSupport({ e }: { e: RuntimeSupportEvidence }) {
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Runtimes" className={LIST}>
        {e.runtimes.map((r) => (
          <ResultItem
            key={r.runtime}
            result={r.result}
            title={`${RUNTIME_LABEL[r.runtime]} ${r.support?.line ?? r.pin?.lineName ?? r.resolvedTo ?? ''}`.trim()}
          >
            {r.pin ? (
              <span>
                Pinned by <Code>{r.pin.raw}</Code> ({pinText(r.pin)})
                {r.pin.floating && r.resolvedTo ? `, resolves to ${r.resolvedTo} today` : ''}
              </span>
            ) : (
              <span>No pin decides what production runs.</span>
            )}
            {r.support ? (
              <span>
                {r.support.basis === 'security' ? 'Security support' : 'Release cycle'}{' '}
                {supportDate(r.support)}
                {r.support.basis === 'release_cycle'
                  ? '. No security support dates are published, so the release cycle is used.'
                  : ''}
              </span>
            ) : null}
            {r.target ? (
              <span>
                Move to line <Code>{r.target.line}</Code>
                {r.target.latest ? (
                  <>
                    , latest <Code>{r.target.latest}</Code>
                  </>
                ) : null}
              </span>
            ) : null}
            <Hints hints={r.fixHints} />
          </ResultItem>
        ))}
      </ul>
      {e.ref ? <p className="text-xs text-muted-foreground">Read at {e.ref}.</p> : null}
    </div>
  )
}

function PinsDisagree({ e }: { e: RuntimePinsDisagreeEvidence }) {
  return (
    <div className="flex flex-col gap-3">
      {e.runtimes.map((r) => (
        <div key={r.runtime} className="flex flex-col gap-2">
          <p className="text-sm text-foreground-2">
            <b className="font-semibold text-foreground">{RUNTIME_LABEL[r.runtime]}</b>
            {r.productionLine
              ? `: production runs ${r.productionLine}`
              : ': no production pin found'}
          </p>
          <ul aria-label={`${RUNTIME_LABEL[r.runtime]} pins`} className={LIST}>
            {r.pins.map((p) => {
              const off =
                !p.floating && r.productionLine !== null && p.lineName !== r.productionLine
              return (
                <li key={`${p.path}:${p.line ?? 0}:${p.source}`} className={ITEM}>
                  <span className="min-w-0 font-mono text-[13px] break-all">
                    {fileAt(p.path, p.line)}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-xs font-semibold',
                      off ? 'text-sev-moderate' : 'text-foreground-2',
                    )}
                  >
                    {p.lineName ?? '?'}
                    {off ? <span className="sr-only">, disagrees</span> : null}
                  </span>
                  <span className="col-span-2 text-xs text-muted-foreground">
                    {PIN_SOURCE_LABEL[p.source]}: <Code>{p.raw}</Code>
                    {p.floating ? ', floating, not compared' : ''}
                  </span>
                </li>
              )
            })}
          </ul>
          <Hints hints={r.fixHints} />
        </div>
      ))}
    </div>
  )
}

function ActionRuntime({ e }: { e: ActionRuntimeEvidence }) {
  return (
    <ul aria-label="Actions" className={LIST}>
      {e.actions.map((a) => (
        <ResultItem
          key={`${a.action}:${a.workflowPath ?? ''}:${a.workflowLine ?? 0}`}
          result={a.result}
          title={
            <span className="font-mono">
              {a.action === 'self' ? 'action.yml (this repo)' : a.action}
            </span>
          }
        >
          <span>
            Runs <Code>{a.using}</Code>
            {a.support ? `, Node ${a.support.line} ${supportDate(a.support)}` : ''}
          </span>
          {a.workflowPath ? <span>Used in {fileAt(a.workflowPath, a.workflowLine)}</span> : null}
        </ResultItem>
      ))}
    </ul>
  )
}

export function GuardEvidenceView({
  evidence,
  level,
}: {
  evidence: GuardEvidence
  level: GuardResult | null
}) {
  const body = (() => {
    switch (evidence.check) {
      case 'root_user':
        return <RootUser e={evidence} />
      case 'docker_socket':
        return <DockerSocket e={evidence} />
      case 'shared_network':
        return <SharedNetwork e={evidence} />
      case 'watch_paths_skip':
        return <WatchPaths e={evidence} />
      case 'framework_support':
        return evidence.frameworks.length ? <Frameworks e={evidence} /> : null
      case 'runtime_support':
        return evidence.runtimes.length ? <RuntimeSupport e={evidence} /> : null
      case 'runtime_pins_disagree':
        return evidence.runtimes.length ? <PinsDisagree e={evidence} /> : null
      case 'action_runtime':
        return evidence.actions.length ? <ActionRuntime e={evidence} /> : null
    }
  })()
  return (
    <div className="flex flex-col gap-3" data-check={evidence.check}>
      {evidence.reason ? (
        level === 'unknown' ? (
          <Callout icon={IconHelpCircle} title="Why the result is unknown">
            {evidence.reason}
          </Callout>
        ) : (
          <p className="flex items-start gap-1.5 text-sm text-foreground-2">
            <IconInfoCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" stroke={1.75} />
            {evidence.reason}
          </p>
        )
      ) : null}
      {body}
    </div>
  )
}
