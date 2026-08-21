/**
 * Ticket list for the tech pane: the thread-matched ticket (if any) pinned on
 * top labeled "Matched to this thread", then open tickets, then recent
 * tickets. Rows are de-duplicated by id across sections so a ticket already
 * shown pinned/open never repeats lower in the list. Selection drives Task
 * 23's actions (create/link/draft) — this component only reports the pick.
 */
import type { AddinTicketSummary, MatchedTicket } from './api';

export interface TicketListProps {
  threadMatchedTicket: MatchedTicket | null;
  openTickets: AddinTicketSummary[];
  recentTickets: AddinTicketSummary[];
  onSelect: (ticket: AddinTicketSummary | MatchedTicket) => void;
}

function Row({
  ticket,
  label,
  onSelect,
}: {
  ticket: AddinTicketSummary | MatchedTicket;
  label?: string;
  onSelect: (ticket: AddinTicketSummary | MatchedTicket) => void;
}) {
  const subject = 'subject' in ticket ? ticket.subject : null;
  const number = ticket.internalNumber ?? ticket.id;
  return (
    <button
      type="button"
      data-testid={`ticket-row-${ticket.id}`}
      onClick={() => onSelect(ticket)}
      className="flex w-full flex-col items-start gap-0.5 rounded-md border border-gray-200 p-2 text-left text-sm hover:bg-gray-50"
    >
      {label && <span className="text-xs font-semibold text-blue-700">{label}</span>}
      <span className="font-medium text-gray-900">{number}</span>
      {subject && <span className="truncate text-xs text-gray-600">{subject}</span>}
      <span className="text-xs text-gray-400">{ticket.status}</span>
    </button>
  );
}

export function TicketList({ threadMatchedTicket, openTickets, recentTickets, onSelect }: TicketListProps) {
  const shownIds = new Set<string>();
  if (threadMatchedTicket) shownIds.add(threadMatchedTicket.id);

  const openRows = openTickets.filter((t) => !shownIds.has(t.id));
  for (const t of openRows) shownIds.add(t.id);

  const recentRows = recentTickets.filter((t) => !shownIds.has(t.id));

  if (!threadMatchedTicket && openRows.length === 0 && recentRows.length === 0) {
    return (
      <div data-testid="ticket-list-empty" className="text-sm text-gray-400">
        No tickets yet for this contact.
      </div>
    );
  }

  return (
    <div data-testid="ticket-list" className="flex flex-col gap-2">
      {threadMatchedTicket && (
        <Row ticket={threadMatchedTicket} label="Matched to this thread" onSelect={onSelect} />
      )}
      {openRows.map((t) => (
        <Row key={t.id} ticket={t} onSelect={onSelect} />
      ))}
      {recentRows.map((t) => (
        <Row key={t.id} ticket={t} onSelect={onSelect} />
      ))}
    </div>
  );
}
