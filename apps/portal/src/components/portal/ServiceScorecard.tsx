import { useState } from 'react';
import type {
  PortalArtifactState,
  PortalDeliverableCadence,
  PortalDeliverableDto,
  PortalDeliverableStatus,
  PortalDeliveryRecord,
  PortalEvidenceRef,
  PortalOccurrenceDto,
  PortalOccurrenceStatus,
  PortalServiceGroupDto,
  PortalServiceOverviewDto,
} from '@breeze/shared';
import { Download } from 'lucide-react';
import { portalApi } from '@/lib/api';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import {
  BTN_SECONDARY,
  CELL,
  EmptyState,
  ErrorNotice,
  PageHeader,
  ROW,
  StatusMark,
  TH,
  type MarkTone,
} from './ui';

const CADENCE_LABEL: Record<PortalDeliverableCadence, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Twice a year',
  annual: 'Yearly',
  one_time: 'One time',
};

const STATUS_TONE: Record<PortalDeliverableStatus, MarkTone> = {
  on_track: 'success',
  due_soon: 'primary',
  late: 'warning',
  missed: 'destructive',
};

const STATUS_LABEL: Record<PortalDeliverableStatus, string> = {
  on_track: 'On track',
  due_soon: 'Due soon',
  late: 'Late',
  missed: 'Missed',
};

/**
 * Spec §8: what the customer can actually open for a delivery. The blank
 * states (attached/report/none) say nothing extra — the evidence links, or
 * their absence, already tell the story. Only the MSP-held state needs a
 * sentence, because with no link to show, silence there would read as
 * nothing having been delivered at all.
 */
const ARTIFACT_COPY: Record<PortalArtifactState, string | null> = {
  attached: null,
  report: null,
  none: null,
  held_by_msp: 'Delivered (artifact held by your IT team)',
};

/**
 * Customer-facing occurrence labels. `awaiting_evidence` has no arm here —
 * the read model already folds it into `in_progress` (spec D10: curated
 * delivery records only, never the internal workflow behind them).
 */
const OCCURRENCE_LABEL: Record<PortalOccurrenceStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  delivered: 'Delivered',
  missed: 'Missed',
  waived: 'Not required this period',
};

const OCCURRENCE_TONE: Record<PortalOccurrenceStatus, MarkTone> = {
  scheduled: 'neutral',
  in_progress: 'primary',
  delivered: 'success',
  missed: 'destructive',
  waived: 'neutral',
};

/** Evidence anchors shared by the last-delivered block and the history list —
 *  always a browser-navigable path (session cookie authenticates it), never a
 *  presigned URL (spec §8). */
function EvidenceList({ evidence, ownerId }: { evidence: PortalEvidenceRef[]; ownerId: string }) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {evidence.map((ev, i) => (
        <a
          key={`${ev.kind}-${ev.documentId ?? ev.reportRunId}`}
          data-testid={`portal-service-evidence-${i}-${ownerId}`}
          href={
            ev.kind === 'document'
              ? portalApi.documentContentUrl(ev.documentId!)
              : portalApi.reportArtifactUrl(ev.reportRunId!, 'pdf')
          }
          download
          className={cn(BTN_SECONDARY, 'min-h-11 py-1.5 text-xs sm:min-h-0')}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {ev.title}
        </a>
      ))}
    </div>
  );
}

function DeliveredBlock({
  last,
  timezone,
  deliverableId,
}: {
  last: PortalDeliveryRecord;
  timezone: string;
  deliverableId: string;
}) {
  const artifactNote = ARTIFACT_COPY[last.artifactState];
  return (
    <div className="mt-1.5 text-sm text-muted-foreground">
      <p>
        {`Delivered ${formatDate(last.at)} (${timezone})`}
        {last.late && (
          <>
            {' '}
            <StatusMark tone="warning">Late</StatusMark>
          </>
        )}
      </p>
      {last.note && <p className="mt-1">{last.note}</p>}
      {artifactNote && <p className="mt-1">{artifactNote}</p>}
      <EvidenceList evidence={last.evidence} ownerId={deliverableId} />
    </div>
  );
}

function OccurrenceHistory({ occurrences, deliverableId }: { occurrences: PortalOccurrenceDto[]; deliverableId: string }) {
  return (
    <ul
      data-testid={`portal-service-occurrences-${deliverableId}`}
      className="mt-2 divide-y divide-border/70 border-t border-border/70"
    >
      {occurrences.map((o) => (
        <li key={o.id} data-testid={`portal-service-occurrence-row-${o.id}`} className="py-2 text-sm">
          <p className="font-medium text-foreground">
            {formatDate(o.periodStart)} – {formatDate(o.periodEnd)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{`Due ${formatDate(o.dueAt)}`}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusMark tone={OCCURRENCE_TONE[o.status]}>{OCCURRENCE_LABEL[o.status]}</StatusMark>
            {o.rescheduled && (
              <span className="text-xs font-medium text-muted-foreground">Rescheduled</span>
            )}
          </div>
          {o.note && <p className="mt-1 text-xs text-muted-foreground">{o.note}</p>}
          {ARTIFACT_COPY[o.artifactState] && (
            <p className="mt-1 text-xs text-muted-foreground">{ARTIFACT_COPY[o.artifactState]}</p>
          )}
          <EvidenceList evidence={o.evidence} ownerId={o.id} />
        </li>
      ))}
    </ul>
  );
}

function DeliverableRow({
  deliverable,
  timezone,
}: {
  deliverable: PortalDeliverableDto;
  timezone: string;
}) {
  const [history, setHistory] = useState<PortalOccurrenceDto[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  async function loadHistory() {
    setLoadingHistory(true);
    setHistoryError(null);
    const response = await portalApi.getServiceOccurrences(deliverable.id);
    setLoadingHistory(false);
    if (!response.data) {
      setHistoryError(response.error ?? "Could not load this deliverable's history.");
      return;
    }
    setHistory(response.data.occurrences);
  }

  return (
    <tr className={ROW} data-testid={`portal-service-row-${deliverable.id}`}>
      <td className={cn(CELL, 'order-1 grow')}>
        <p className="font-semibold text-foreground">{deliverable.name}</p>
        {deliverable.description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{deliverable.description}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{CADENCE_LABEL[deliverable.cadence]}</p>
      </td>
      <td className={cn(CELL, 'order-2')}>
        <StatusMark
          tone={STATUS_TONE[deliverable.status]}
          data-testid={`portal-service-status-${deliverable.id}`}
        >
          {STATUS_LABEL[deliverable.status]}
        </StatusMark>
        <p className="mt-1 text-xs text-muted-foreground">
          {`Next due: ${deliverable.nextDue ? formatDate(deliverable.nextDue) : 'Not scheduled'}`}
        </p>
      </td>
      <td className={cn(CELL, 'order-3 basis-full sm:basis-auto')}>
        {deliverable.lastDelivered ? (
          <DeliveredBlock
            last={deliverable.lastDelivered}
            timezone={timezone}
            deliverableId={deliverable.id}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Not yet delivered.</p>
        )}
        <button
          type="button"
          data-testid={`portal-service-history-toggle-${deliverable.id}`}
          onClick={() => void loadHistory()}
          disabled={loadingHistory}
          className={cn(BTN_SECONDARY, 'mt-2 py-1.5 text-xs')}
        >
          {loadingHistory ? 'Loading…' : 'Show history'}
        </button>
        {historyError && <ErrorNotice>{historyError}</ErrorNotice>}
        {history && <OccurrenceHistory occurrences={history} deliverableId={deliverable.id} />}
      </td>
    </tr>
  );
}

function ServiceGroupSection({ group, timezone }: { group: PortalServiceGroupDto; timezone: string }) {
  const groupId = group.contract?.id ?? 'standalone';
  const heading = group.contract?.name ?? 'Other services';
  return (
    <section data-testid={`portal-service-group-${groupId}`}>
      <h2 className="font-display text-lg font-semibold text-foreground">{heading}</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="block w-full sm:table sm:min-w-[40rem]" data-testid={`portal-service-table-${groupId}`}>
          <thead className="hidden border-b border-border sm:table-header-group">
            <tr>
              <th scope="col" className={cn(TH, 'text-left')}>Deliverable</th>
              <th scope="col" className={cn(TH, 'text-left')}>Status</th>
              <th scope="col" className={cn(TH, 'text-left')}>Last delivered</th>
            </tr>
          </thead>
          <tbody className="block divide-y divide-border/70 sm:table-row-group">
            {group.deliverables.map((d) => (
              <DeliverableRow key={d.id} deliverable={d} timezone={timezone} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ServiceScorecard({ overview }: { overview: PortalServiceOverviewDto }) {
  const isEmpty = overview.groups.length === 0 && overview.keyDates.length === 0;

  return (
    <div>
      <PageHeader title="Service" lede="What we look after for you, and what we delivered." />

      {isEmpty ? (
        <EmptyState data-testid="portal-service-empty" title="Nothing scheduled yet">
          <p className="mt-1 text-sm text-muted-foreground">
            Your IT team has not published a service schedule for this account.
          </p>
        </EmptyState>
      ) : (
        <>
          <div data-testid="portal-service-groups" className="space-y-8">
            {overview.groups.map((group) => (
              <ServiceGroupSection
                key={group.contract?.id ?? 'standalone'}
                group={group}
                timezone={overview.timezone}
              />
            ))}
          </div>

          {overview.keyDates.length > 0 && (
            <section data-testid="portal-service-key-dates" className="mt-8 border-t border-border/70 pt-6">
              <h2 className="font-display text-lg font-semibold text-foreground">Key dates</h2>
              <ul className="mt-3 divide-y divide-border/70">
                {overview.keyDates.map((kd) => (
                  <li
                    key={kd.id}
                    data-testid={`portal-service-key-date-${kd.id}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm"
                  >
                    <span className="text-foreground">{kd.label}</span>
                    <span className="text-muted-foreground">
                      {formatDate(kd.date)}
                      {kd.source === 'contract_end' && ' — Agreement ends'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <p className="text-figures mt-8 border-t border-border/70 pt-4 text-xs text-muted-foreground">
        {`As of ${formatDateTime(overview.asOf, overview.timezone)} (${overview.timezone}).`}
      </p>
    </div>
  );
}

export default ServiceScorecard;
