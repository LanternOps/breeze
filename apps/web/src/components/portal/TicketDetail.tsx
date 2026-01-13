import { cn, formatRelativeTime } from '@/lib/utils';
import type { PortalTicket, TicketPriority, TicketStatus } from './TicketList';
import type { TicketComment } from './TicketComments';

type TicketDetailProps = {
  ticket: PortalTicket & {
    description?: string;
    createdAt?: string;
    deviceName?: string;
  };
  comments: TicketComment[];
};

const statusStyles: Record<TicketStatus, string> = {
  open: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  pending: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  resolved: 'bg-sky-500/15 text-sky-700 border-sky-500/30',
  closed: 'bg-gray-500/15 text-gray-700 border-gray-500/30'
};

const priorityStyles: Record<TicketPriority, string> = {
  low: 'text-muted-foreground',
  medium: 'text-foreground',
  high: 'text-amber-700',
  urgent: 'text-rose-700'
};

export default function TicketDetail({ ticket, comments }: TicketDetailProps) {
  const visibleComments = comments.filter(comment => comment.isPublic);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs text-muted-foreground">Ticket #{ticket.number}</div>
            <h2 className="text-lg font-semibold text-foreground">{ticket.subject}</h2>
            {ticket.description && (
              <p className="mt-2 text-sm text-muted-foreground whitespace-pre-line">
                {ticket.description}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 text-xs">
            <span
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium',
                statusStyles[ticket.status]
              )}
            >
              {ticket.status}
            </span>
            <span className={cn('text-xs font-medium capitalize', priorityStyles[ticket.priority])}>
              {ticket.priority} priority
            </span>
            {ticket.updatedAt && (
              <span className="text-xs text-muted-foreground">
                Updated {formatRelativeTime(new Date(ticket.updatedAt))}
              </span>
            )}
          </div>
        </div>
        <div className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
          {ticket.createdAt && (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Created</div>
              <div>{new Date(ticket.createdAt).toLocaleDateString()}</div>
            </div>
          )}
          {ticket.deviceName && (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Device</div>
              <div>{ticket.deviceName}</div>
            </div>
          )}
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Status</div>
            <div className="capitalize">{ticket.status}</div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-foreground">Timeline</h3>
          <p className="text-xs text-muted-foreground">
            Public replies from your support team
          </p>
        </div>

        {visibleComments.length === 0 ? (
          <div className="text-sm text-muted-foreground">No public replies yet.</div>
        ) : (
          <div className="relative space-y-6 border-l border-muted pl-6">
            {visibleComments.map(comment => (
              <div key={comment.id} className="relative">
                <span className="absolute -left-[9px] top-1.5 h-3 w-3 rounded-full bg-primary" />
                <div className="rounded-md border bg-background p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-foreground">{comment.author}</div>
                      {comment.authorRole && (
                        <div className="text-xs text-muted-foreground">{comment.authorRole}</div>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatRelativeTime(new Date(comment.createdAt))}
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-foreground whitespace-pre-line">
                    {comment.message}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
