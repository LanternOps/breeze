import React, { useEffect, useState } from 'react';
import { Ticket, Plus, Loader2, AlertCircle } from 'lucide-react';
import { portalApi, type Ticket as TicketType } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

export function TicketList() {
  const [tickets, setTickets] = useState<TicketType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTickets() {
      const result = await portalApi.getTickets();
      if (result.data) {
        setTickets(result.data);
      } else {
        setError(result.error || 'Failed to load tickets');
      }
      setIsLoading(false);
    }

    fetchTickets();
  }, []);

  const getPriorityColor = (priority: TicketType['priority']) => {
    switch (priority) {
      case 'critical':
        return 'bg-destructive text-destructive-foreground';
      case 'high':
        return 'bg-warning text-warning-foreground';
      case 'medium':
        return 'bg-primary text-primary-foreground';
      case 'low':
        return 'bg-muted text-muted-foreground';
    }
  };

  const getStatusColor = (status: TicketType['status']) => {
    switch (status) {
      case 'open':
        return 'bg-primary/10 text-primary';
      case 'in_progress':
        return 'bg-warning/10 text-warning';
      case 'resolved':
        return 'bg-success/10 text-success';
      case 'closed':
        return 'bg-muted text-muted-foreground';
    }
  };

  const getStatusLabel = (status: TicketType['status']) => {
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-center text-destructive">
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
          href="/tickets/new"
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
            href="/tickets/new"
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
          <table className="w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                  Title
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                  Priority
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {tickets.map((ticket) => (
                <tr
                  key={ticket.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => (window.location.href = `/tickets/${ticket.id}`)}
                >
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium">{ticket.title}</p>
                      <p className="text-sm text-muted-foreground line-clamp-1">
                        {ticket.description}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 py-1 text-xs font-medium',
                        getStatusColor(ticket.status)
                      )}
                    >
                      {getStatusLabel(ticket.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 py-1 text-xs font-medium capitalize',
                        getPriorityColor(ticket.priority)
                      )}
                    >
                      {ticket.priority}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatRelativeTime(ticket.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default TicketList;
