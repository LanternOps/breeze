import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { SlaTimers } from './SlaTimers';
import TicketChecklistCard from './TicketChecklistCard';
import TicketEndpointPanel from './TicketEndpointPanel';
import TicketRequesterBlock from './TicketRequesterBlock';
import TicketDetailsSections from './TicketDetailsSections';
import type { TicketDetail } from './ticketConfig';
import type { TicketType } from './ticketType';
import type { MergedIntoState } from './useMergedTicketRefs';
import type { TicketEndpoint } from './useTicketEndpoint';

interface Props {
  ticket: TicketDetail;
  merged: boolean;
  canEdit: boolean;
  mergedInto: MergedIntoState;
  categories: Array<{ id: string; name: string }>;
  currencyCode?: string;
  callerRevision: number;
  /** Deep-link for caller verification, only where the page does not own the hash. */
  verificationHash?: string;
  onCallerChanged: () => void;
  onFieldSave: (patch: Record<string, unknown>) => void;
  onTypeChange: (ticketType: TicketType) => void;
  onCategoryChange: (categoryId: string | null) => void;
  onChecklistCounts: (counts: { done: number; total: number; known: boolean }) => void;
  canSavePartnerWideChecklist: boolean;
  /** The host's read of the device, shared with the narrow endpoint line. */
  endpoint?: TicketEndpoint;
}

// Linked-alert severity reads as status: tint + ink, plus the printed word.
const ALERT_SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive-ink border-destructive/30',
  high: 'bg-warning/15 text-warning-ink border-warning/30',
  medium: 'bg-warning/10 text-warning-ink border-warning/20',
};
const KNOWN_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

/**
 * The situation beside the conversation, in the order a tech asks about it:
 * who asked, the machine's live state, how close to breach, what is alerting,
 * the work still to do, then the record (Details) one click away.
 */
export default function TicketSituationColumn({
  ticket, merged, canEdit, mergedInto, categories, currencyCode, callerRevision, verificationHash, onCallerChanged,
  onFieldSave, onTypeChange, onCategoryChange, onChecklistCounts, canSavePartnerWideChecklist, endpoint,
}: Props) {
  const { t } = useTranslation('tickets');
  const { t: tAlerts } = useTranslation('alerts');

  return (
    <div className="space-y-4 p-4 text-sm">
      <TicketRequesterBlock
        ticket={ticket}
        merged={merged}
        callerRevision={callerRevision}
        verificationHash={verificationHash}
        onCallerChanged={onCallerChanged}
        onSave={onFieldSave}
      />

      <div className="border-t pt-3">
        <h3 className="mb-1 text-xs text-muted-foreground">{t('common:labels.device')}</h3>
        <TicketEndpointPanel
          deviceId={ticket.deviceId}
          deviceHostname={ticket.deviceHostname}
          orgId={ticket.orgId}
          hasAssignee={!!ticket.assignedTo}
          readOnly={merged}
          onLinkDevice={(deviceId) => onFieldSave({ deviceId })}
          onUnlinkDevice={() => onFieldSave({ deviceId: null })}
          endpoint={endpoint}
        />
      </div>

      {/* Per-target SLA timers; renders nothing (no gap) when the ticket has no SLA targets. */}
      <div className="border-t pt-3 empty:hidden">
        <SlaTimers ticket={ticket} />
      </div>

      {/* #10073: time, budget and part writes on a tombstone all answer 409
          TICKET_MERGED, so the cards below go read-only and this says why,
          pointing at the ticket that took the work. */}
      {merged && ticket.mergedIntoTicketId && (
        <div className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1.5 text-xs" role="note" data-testid="ticket-rail-merged-readonly">
          <p>{t('ticketWorkbench.mergedBanner.railReadOnly')}</p>
          {mergedInto?.state !== 'missing' && (
            <a href={`/tickets/${ticket.mergedIntoTicketId}`} className="mt-0.5 inline-block font-medium text-primary-ink hover:underline" data-testid="ticket-rail-merged-link">
              {t('ticketWorkbench.mergedBanner.open', { number: mergedInto?.number ?? ticket.mergedIntoTicketId.slice(0, 8) })}
            </a>
          )}
        </div>
      )}

      <div className="border-t pt-3">
        <h3 className="text-xs text-muted-foreground">{t('ticketWorkbench.linkedAlerts')}</h3>
        {ticket.alertLinks.length === 0 ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{t('common:labels.none')}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {ticket.alertLinks.map((l) => {
              const sev = l.alertSeverity && KNOWN_SEVERITIES.has(l.alertSeverity.toLowerCase()) ? l.alertSeverity.toLowerCase() : null;
              return (
                <li key={l.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                  {sev && (
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 font-medium',
                        ALERT_SEVERITY_CLASS[sev] ?? 'bg-muted text-foreground/70 border-border dark:text-muted-foreground'
                      )}
                      data-testid={`ticket-alert-severity-${l.alertId}`}
                    >
                      {tAlerts(/* i18n-dynamic */ `alertDetails.severity.${sev}`)}
                    </span>
                  )}
                  <a href={`/alerts#${l.alertId}`} className="min-w-0 truncate hover:underline" title={l.alertTitle ?? l.alertId} data-testid={`ticket-alert-link-${l.alertId}`}>
                    {l.alertTitle ?? l.alertId}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Work still to do: rendered only when the ticket has (or can take) a checklist. */}
      <div className="empty:hidden [&>*]:mt-0 [&>*]:border-t [&>*]:pt-3">
        <TicketChecklistCard ticketId={ticket.id} onCountsChange={onChecklistCounts} canSavePartnerWide={canSavePartnerWideChecklist} readOnly={merged} />
      </div>

      <TicketDetailsSections
        ticket={ticket}
        merged={merged}
        canEdit={canEdit}
        categories={categories}
        currencyCode={currencyCode}
        onTypeChange={onTypeChange}
        onCategoryChange={onCategoryChange}
        onFieldSave={onFieldSave}
      />
    </div>
  );
}
