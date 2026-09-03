import { withBase } from '@/lib/basePath';
import React from 'react';
import { Ticket, Plus } from 'lucide-react';
import { type TicketSummary } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { ROW, CELL, TH, BTN_PRIMARY, PageHeader, StatusMark, EmptyState, ErrorNotice } from './ui';
import { isTicketOpen, ticketStatusLabel, ticketStatusTone } from './ticketMarks';

interface TicketListProps {
  tickets: TicketSummary[];
  error?: string | null;
  enableSupportUsage?: boolean;
}

const SLA_LABELS = {
  breached: 'SLA breached',
  at_risk: 'SLA at risk',
  paused: 'SLA paused',
  on_track: 'SLA on track',
  met: 'SLA met',
  not_configured: 'No SLA configured',
} as const;

export function TicketSlaBadge({
  sla,
  testId,
}: {
  sla: TicketSummary['sla'];
  testId: string;
}) {
  return <span data-testid={testId}>{SLA_LABELS[sla.status]}</span>;
}

export function TicketList({ tickets, error, enableSupportUsage = false }: TicketListProps) {
  if (error) {
    return <ErrorNotice>{error}</ErrorNotice>;
  }

  const openCount = tickets.filter((t) => isTicketOpen(t.status)).length;

  return (
    <div>
      {/* No page-level "New ticket" here: the header quick action is on every
          page, and two identical primary buttons on one screen read as noise. */}
      <PageHeader title="Support" lede="Tell us what you need — we'll take it from there." />

      {tickets.length === 0 ? (
        <EmptyState icon={<Ticket className="h-10 w-10" strokeWidth={1.5} />} title="No tickets">
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing here yet. When you need a hand, this is where it starts.
          </p>
          <a href={withBase('/tickets/new')} className={cn(BTN_PRIMARY, 'mt-5')}>
            <Plus className="h-4 w-4" />
            Create your first ticket
          </a>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="block w-full sm:table sm:min-w-[36rem]">
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Title
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Status
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Priority
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Updated
                </th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {tickets.map((ticket) => {
                const tone = ticketStatusTone(ticket.status);
                return (
                  <tr key={ticket.id} className={ROW}>
                    {/* order-* reorders the card: subject and status share the
                        first line, priority and the update time trail below. */}
                    <td className={cn(CELL, 'order-1 grow')}>
                      <div>
                        <a className="font-semibold text-foreground underline-offset-4 hover:underline" href={withBase(`/tickets/${ticket.id}`)}>
                          {ticket.subject}
                        </a>
                        <p className="text-figures text-sm text-muted-foreground">
                          #{ticket.ticketNumber}
                        </p>
                      </div>
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <StatusMark tone={tone}>
                        {ticketStatusLabel(ticket.status)}
                      </StatusMark>
                      {enableSupportUsage && ticket.sla && (
                        <TicketSlaBadge
                          sla={ticket.sla}
                          testId={`portal-ticket-sla-${ticket.id}`}
                        />
                      )}
                    </td>
                    <td className={cn(CELL, 'order-3')}>
                      {/* Priority is context, not state: plain text so the row
                          keeps ONE mark (status). Urgent and high keep their
                          tinted text; routine priorities stay muted. */}
                      <span
                        className={cn(
                          'text-xs font-medium',
                          ticket.priority === 'urgent'
                            ? 'text-destructive-on-tint'
                            : ticket.priority === 'high'
                              ? 'text-warning-on-tint'
                              : 'text-muted-foreground'
                        )}
                      >
                        {ticket.priority.charAt(0).toUpperCase() + ticket.priority.slice(1)} priority
                      </span>
                    </td>
                    <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Updated </span>
                      {formatRelativeTime(ticket.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div
            className="border-t border-border px-4 pt-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
            data-testid="ticket-ledger-foot"
          >
            {openCount === 0
              ? 'No open requests'
              : openCount === 1
                ? '1 open request'
                : `${openCount} open requests`}
          </div>
        </div>
      )}
    </div>
  );
}

export default TicketList;
