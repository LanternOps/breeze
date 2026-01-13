import { cn, formatRelativeTime } from '@/lib/utils';

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export type PortalTicket = {
  id: string;
  number: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  updatedAt: string;
};

type TicketListProps = {
  tickets: PortalTicket[];
  onSelect?: (ticket: PortalTicket) => void;
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

export default function TicketList({ tickets, onSelect }: TicketListProps) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Support Tickets</h2>
          <p className="text-xs text-muted-foreground">Recent activity and updates</p>
        </div>
      </div>

      <div className="divide-y">
        {tickets.map(ticket => (
          <button
            key={ticket.id}
            type="button"
            onClick={() => onSelect?.(ticket)}
            className="flex w-full flex-col gap-2 px-4 py-3 text-left transition hover:bg-muted md:flex-row md:items-center md:justify-between"
          >
            <div>
              <div className="text-xs text-muted-foreground">#{ticket.number}</div>
              <div className="text-sm font-medium text-foreground">{ticket.subject}</div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium',
                  statusStyles[ticket.status]
                )}
              >
                {ticket.status}
              </span>
              <span className={cn('text-xs font-medium capitalize', priorityStyles[ticket.priority])}>
                {ticket.priority}
              </span>
              <span className="text-xs text-muted-foreground">
                Updated {formatRelativeTime(new Date(ticket.updatedAt))}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
