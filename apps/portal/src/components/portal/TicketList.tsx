import { withBase } from '@/lib/basePath';
import React from 'react';
import { Ticket, Plus, AlertCircle } from 'lucide-react';
import { type TicketSummary, type TicketPriority, type TicketStatus } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface TicketListProps {
  tickets: TicketSummary[];
  error?: string | null;
}

// Below `sm` the row reflows from a table row into a stacked card; the old
// `overflow-hidden` wrapper clipped the rightmost columns on a phone with no
// scrollbar to reach them. At `sm` and up the real table semantics come back.
// One DOM tree either way, so data-testids and header scopes stay unique.
const ROW = 'flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/50 sm:table-row sm:p-0';
const CELL = 'block sm:table-cell sm:px-4 sm:py-3';
const TH = 'px-4 py-3 text-left text-sm font-medium text-muted-foreground';

export function TicketList({ tickets, error }: TicketListProps) {
  const getPriorityColor = (priority: TicketPriority) => {
    switch (priority) {
      case 'urgent':
        return 'bg-destructive text-destructive-foreground';
      case 'high':
        return 'bg-warning text-warning-foreground';
      case 'normal':
        return 'bg-primary text-primary-foreground';
      case 'low':
        return 'bg-muted text-muted-foreground';
    }
  };

  // `-on-tint` foregrounds: the base status tokens are tuned as backgrounds and
  // fail WCAG AA when set as text on their own /10 tint.
  const getStatusColor = (status: TicketStatus) => {
    switch (status) {
      case 'open':
        return 'bg-primary/10 text-primary-on-tint';
      case 'in_progress':
        return 'bg-warning/10 text-warning-on-tint';
      case 'resolved':
        return 'bg-success/10 text-success-on-tint';
      case 'closed':
        return 'bg-muted text-muted-foreground';
    }
  };

  const getStatusLabel = (status: TicketStatus) => {
    switch (status) {
      case 'open':
        return 'Open';
      case 'in_progress':
        return 'In Progress';
      case 'resolved':
        return 'Resolved';
      case 'closed':
        return 'Closed';
    }
  };

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-destructive/10 p-4 text-center text-destructive-on-tint">
        <AlertCircle className="mx-auto h-8 w-8" />
        <p className="mt-2">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Support Tickets</h2>
        <a
          href={withBase("/tickets/new")}
          className={cn(
            'flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
            'hover:bg-primary/90'
          )}
        >
          <Plus className="h-4 w-4" />
          New Ticket
        </a>
      </div>

      {tickets.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center">
          <Ticket className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium">No tickets</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You haven't submitted any support tickets yet.
          </p>
          <a
            href={withBase("/tickets/new")}
            className={cn(
              'mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
              'hover:bg-primary/90'
            )}
          >
            <Plus className="h-4 w-4" />
            Create your first ticket
          </a>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="overflow-x-auto">
            <table className="block w-full sm:table sm:min-w-[36rem]">
              <thead className="hidden bg-muted/50 sm:table-header-group">
                <tr>
                  <th scope="col" className={TH}>
                    Title
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Priority
                  </th>
                  <th scope="col" className={TH}>
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody className="block divide-y sm:table-row-group">
                {tickets.map((ticket) => (
                  <tr
                    key={ticket.id}
                    className={ROW}
                  >
                    {/* order-* reorders the card: subject and status share the
                        first line, priority and the update time trail below. */}
                    <td className={cn(CELL, 'order-1 grow')}>
                      <div>
                        <a className="font-medium hover:underline" href={withBase(`/tickets/${ticket.id}`)}>
                          {ticket.subject}
                        </a>
                        <p className="text-sm text-muted-foreground">
                          #{ticket.ticketNumber}
                        </p>
                      </div>
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-1 text-xs font-medium',
                          getStatusColor(ticket.status)
                        )}
                      >
                        {getStatusLabel(ticket.status)}
                      </span>
                    </td>
                    <td className={cn(CELL, 'order-3')}>
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-1 text-xs font-medium capitalize',
                          getPriorityColor(ticket.priority)
                        )}
                      >
                        {ticket.priority}
                      </span>
                    </td>
                    <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Updated </span>
                      {formatRelativeTime(ticket.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default TicketList;
