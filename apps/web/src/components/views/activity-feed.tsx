import type { ActivityItem, BlindSpotType } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import { eventIcon, eventTone } from '@/components/findings/event-icon'
import { BLIND_SPOT_INFO, COVERAGE_NOTE_INFO, eventSentence } from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { Feed, Panel, PanelBody, PanelHeader } from './panel'

/** Blind spots and coverage notes arrive titled by their type ("alerts disabled"); show the plain label instead. */
function activityTitle(finding: { kind: string; title: string }): string {
  if (finding.kind === 'advisory') return finding.title
  if (finding.kind === 'coverage_note') return COVERAGE_NOTE_INFO.image_only.short
  const type = finding.title.replace(/ /g, '_')
  return type in BLIND_SPOT_INFO ? BLIND_SPOT_INFO[type as BlindSpotType].short : finding.title
}

/** The latest finding events across every repo, newest first. */
export function ActivityPanel({ items }: { items: readonly ActivityItem[] }) {
  return (
    <Panel>
      <PanelHeader title="Recent activity" />
      <PanelBody>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Scans, snoozes and fixes show up here.
          </p>
        ) : (
          <Feed
            label="Recent activity"
            items={items.slice(0, 8).map((event) => ({
              key: event.id,
              icon: eventIcon(event.type),
              tone: eventTone(event.type),
              body: (
                <>
                  {eventSentence(event)}
                  <span className="block truncate text-foreground-2">
                    <Link
                      to="/finding/$id"
                      params={{ id: String(event.finding.id) }}
                      className={`text-accent-ink hover:underline ${event.finding.kind === 'advisory' ? 'font-mono text-[12.5px]' : ''}`}
                    >
                      {activityTitle(event.finding)}
                    </Link>
                    {event.finding.repo ? (
                      <span className="text-muted-foreground"> in {event.finding.repo}</span>
                    ) : null}
                  </span>
                </>
              ),
              time: <time dateTime={event.at}>{formatRelative(event.at)}</time>,
            }))}
          />
        )}
      </PanelBody>
    </Panel>
  )
}
