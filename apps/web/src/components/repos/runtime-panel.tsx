import { useEffect, useId, useState } from 'react'
import type {
  FixHint,
  RepoDetail,
  RepoRuntimePin,
  Runtime,
  RuntimeSupportEntry,
} from '@hinomi/shared'
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconCpu,
  IconInfoCircle,
} from '@tabler/icons-react'
import { GuardResultBadge } from '@/components/guards/guard-badges'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import { fileAt, PIN_SOURCE_LABEL, RUNTIME_LABEL } from '@/lib/guard-meta'
import {
  behindAllowance,
  hintText,
  PIN_SCOPE_LABEL,
  pinNote,
  pinsByRuntime,
  ruleNote,
  supportHeadline,
} from '@/lib/runtime-meta'
import { cn } from '@/lib/utils'

/** The worst result of the runtimes, null when none was judged. */
function worstResult(entries: readonly RuntimeSupportEntry[]) {
  for (const result of ['fail', 'warn', 'unknown'] as const) {
    if (entries.some((e) => e.result === result)) return result
  }
  return entries.length > 0 ? ('pass' as const) : null
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }}
    >
      {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
    </Button>
  )
}

/** The edits that move a runtime to its target line, as a checklist to tick off by hand. */
function FixHints({ hints, runtime }: { hints: readonly FixHint[]; runtime: Runtime }) {
  const name = useId()
  if (!hints.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold text-foreground-2">
        Edits to make for {RUNTIME_LABEL[runtime]}
      </h4>
      <ul
        aria-label={`${RUNTIME_LABEL[runtime]} edits`}
        className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-border bg-card p-0"
      >
        {hints.map((hint) => {
          const id = `${name}-${hint.path}-${hint.line ?? 0}`
          return (
            <li
              key={id}
              className="flex items-center gap-2 border-t border-border py-1 pr-1 pl-3 first:border-t-0"
            >
              <input
                id={id}
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                aria-label={`Done: ${hintText(hint)}`}
              />
              <label
                htmlFor={id}
                className="min-w-0 flex-1 font-mono text-xs break-words text-foreground-2 cursor-pointer"
              >
                {fileAt(hint.path, hint.line)}: {hint.from} <span aria-label="to">→</span>{' '}
                <b className="font-semibold text-success">{hint.to}</b>
              </label>
              <CopyButton text={hint.to} label={`Copy ${hint.to}`} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** One pin: the file and line, what it says, where it applies, and what is special about it. */
function PinItem({ pin }: { pin: RepoRuntimePin }) {
  const note = pinNote(pin)
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 text-sm first:border-t-0',
        pin.disagrees && 'bg-sev-moderate-soft',
      )}
    >
      <span className="min-w-0 font-mono text-[13px] break-all">{fileAt(pin.path, pin.line)}</span>
      <span className="flex items-center gap-1.5">
        {pin.disagrees ? (
          <Badge variant="moderate" title="Names another line than the rest of this runtime">
            <IconAlertTriangle aria-hidden="true" stroke={2} />
            Disagrees
          </Badge>
        ) : null}
        <Badge variant={pin.scope === 'production' ? 'accent' : 'outline'}>
          {PIN_SCOPE_LABEL[pin.scope]}
        </Badge>
      </span>
      <span className="col-span-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>{PIN_SOURCE_LABEL[pin.source]}</span>
        <code className="rounded-sm bg-muted px-1.5 py-px font-mono text-[13px] text-foreground">
          {pin.raw}
        </code>
        {pin.lineName && pin.kind !== 'floating' ? <span>line {pin.lineName}</span> : null}
        {note ? <span>{note}</span> : null}
      </span>
    </li>
  )
}

function RuntimeBlock({
  runtime,
  pins,
  entry,
}: {
  runtime: Runtime
  pins: readonly RepoRuntimePin[]
  entry: RuntimeSupportEntry | undefined
}) {
  const label = RUNTIME_LABEL[runtime]
  return (
    <section aria-label={label} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="text-md">{label}</h3>
        {entry ? <GuardResultBadge result={entry.result} /> : null}
      </div>
      {entry ? (
        <div className="flex max-w-[68ch] flex-col gap-1 text-sm">
          <p className="font-medium">{supportHeadline(entry)}</p>
          {entry.rule === 'support_window' && entry.target && entry.result !== 'unknown' ? (
            <p className="text-foreground-2">
              {entry.result === 'pass' ? 'Newest LTS line' : 'Move to line'}{' '}
              <b className="font-mono font-semibold">{entry.target.line}</b>
              {entry.target.latest ? `, latest ${entry.target.latest}` : ''}.
            </p>
          ) : null}
          {entry.reason && entry.support ? (
            <p className="text-foreground-2">{entry.reason}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {ruleNote(entry)} {behindAllowance(entry)}
          </p>
        </div>
      ) : (
        <p className="max-w-[68ch] text-sm text-foreground-2">
          No pin decides what production runs, so no support line is judged.
        </p>
      )}
      <ul
        aria-label={`${label} pins`}
        className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-border bg-card p-0"
      >
        {pins.map((pin) => (
          <PinItem key={`${pin.path}:${pin.line ?? 0}:${pin.source}:${pin.job ?? ''}`} pin={pin} />
        ))}
      </ul>
      {entry ? <FixHints hints={entry.fixHints} runtime={runtime} /> : null}
    </section>
  )
}

/**
 * The runtime pins of one repo and where each runtime stands: every pin Hinomi found with its
 * file and line, the support line of the runtime that production runs (an end date for Node,
 * releases behind the latest for Rust and Bun), the pins that disagree, and the edits that move
 * it to a supported line.
 */
export function RuntimePanel({ repo }: { repo: RepoDetail }) {
  const headingId = useId()
  const { runtimePins: pins, supportLines } = repo
  const groups = pinsByRuntime(pins)
  const worst = worstResult(supportLines.runtimes)
  const ref = pins[0]?.ref ?? null
  return (
    <section aria-labelledby={headingId}>
      <Panel>
        <PanelHeader title={<span id={headingId}>Runtime</span>} icon={IconCpu}>
          {worst ? <GuardResultBadge result={worst} /> : null}
        </PanelHeader>
        <PanelBody className="flex flex-col gap-5">
          {groups.length === 0 ? (
            <p className="max-w-[68ch] text-sm text-foreground-2">
              No Node, Bun or Rust pin found in this repo. Hinomi reads version files, package
              manifests, Dockerfiles and workflow files at the branch it scans.
            </p>
          ) : (
            <>
              {!supportLines.available ? (
                <Callout variant="info" icon={IconInfoCircle} title="No support dates yet">
                  The pins are listed, but runtimes are not judged until Hinomi has fetched the
                  support data from endoflife.date.
                </Callout>
              ) : null}
              {groups.map((group) => (
                <RuntimeBlock
                  key={group.runtime}
                  runtime={group.runtime}
                  pins={group.pins}
                  entry={supportLines.runtimes.find((e) => e.runtime === group.runtime)}
                />
              ))}
              {ref ? <p className="text-xs text-muted-foreground">Read at {ref}.</p> : null}
            </>
          )}
        </PanelBody>
      </Panel>
    </section>
  )
}
