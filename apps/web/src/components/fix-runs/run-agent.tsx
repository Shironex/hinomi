import type { FixAgentReport, FixRun } from '@hinomi/shared'
import { StatusText } from '@/components/findings/finding-state'
import { KeyValues, Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import { AGENT_OUTCOME_INFO, formatCost, formatDuration } from '@/lib/fix-run-meta'

const PRESET_LABEL: Record<FixAgentReport['preset'], string> = {
  'claude-code': 'Claude Code',
  stub: 'Test stub',
}

const number = new Intl.NumberFormat('en-US')

/**
 * What the coding agent of a majors run did: how it ended, its turns and cost when it reported
 * them, its closing message and the paths the patch left out. While the run is going there is
 * nothing to show yet, and a run that never got to an agent says so.
 */
export function RunAgent({ run }: { run: Pick<FixRun, 'state' | 'terminal' | 'result'> }) {
  const agent = run.result?.agent
  if (!agent) {
    return (
      <Panel>
        <PanelHeader title="Agent" />
        <PanelBody>
          <p className="text-sm text-muted-foreground">
            {run.terminal
              ? 'The run ended before the agent reported.'
              : 'The agent is working. Its outcome, turns and cost arrive when the run finishes.'}
          </p>
        </PanelBody>
      </Panel>
    )
  }
  const outcome = AGENT_OUTCOME_INFO[agent.outcome]
  return (
    <Panel>
      <PanelHeader title="Agent">
        <StatusText icon={outcome.icon} tone={outcome.tone}>
          {outcome.label}
        </StatusText>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-3">
        <KeyValues
          items={[
            { label: 'Agent', value: PRESET_LABEL[agent.preset] },
            {
              label: 'Turns',
              value: agent.turns === null ? 'Not reported' : number.format(agent.turns),
            },
            {
              label: 'Cost',
              value:
                agent.costUsd === null ? 'Not reported' : `${formatCost(agent.costUsd)} estimated`,
            },
            { label: 'Time', value: formatDuration(agent.durationMs) },
          ]}
        />
        {agent.detail ? <p className="text-sm text-sev-critical">{agent.detail}</p> : null}
        {agent.summary ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-foreground-2">Its closing message</h3>
            <pre
              tabIndex={0}
              aria-label="Closing message of the agent"
              className="m-0 max-h-[220px] overflow-auto rounded-md border border-border bg-sidebar px-3 py-2 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-foreground-2"
            >
              {agent.summary}
            </pre>
          </div>
        ) : null}
        {agent.refusedPaths.length ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-foreground-2">
              Left out of the patch ({number.format(agent.refusedPaths.length)})
            </h3>
            <ul
              aria-label="Paths left out of the patch"
              className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-xs text-foreground-2"
            >
              {agent.refusedPaths.map((path) => (
                <li key={path} className="truncate" title={path}>
                  {path}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              The majors patch never carries workflows, hooks or tool configuration.
            </p>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  )
}
