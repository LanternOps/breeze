import React, { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, AlertCircle, Clock, Tag } from 'lucide-react';
import { portalApi, type Ticket } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface TicketDetailsProps {
  ticketId: string;
}

export function TicketDetails({ ticketId }: TicketDetailsProps) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTicket() {
      const result = await portalApi.getTicket(ticketId);
      if (result.data) {
        setTicket(result.data);
      } else {
        setError(result.error || 'Failed to load ticket');
      }
      setIsLoading(false);
    }

    fetchTicket();
  }, [ticketId]);

  const getStatusColor = (status: Ticket['status']) => {
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

  const getStatusLabel = (status: Ticket['status']) => {
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

  const getPriorityColor = (priority: Ticket['priority']) => {
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="text-center">
        <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
        <h3 className="mt-4 text-lg font-medium">Ticket not found</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {error || 'The ticket you are looking for does not exist.'}
        </p>
        <a
          href="/tickets"
          className="mt-4 inline-flex items-center gap-2 text-sm text-primary hover:text-primary/80"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tickets
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <a
          href="/tickets"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tickets
        </a>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold">{ticket.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Ticket #{ticket.id}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex rounded-full px-3 py-1 text-xs font-medium',
                  getStatusColor(ticket.status)
                )}
              >
                {getStatusLabel(ticket.status)}
              </span>
              <span
                className={cn(
                  'inline-flex rounded-full px-3 py-1 text-xs font-medium capitalize',
                  getPriorityColor(ticket.priority)
                )}
              >
                {ticket.priority}
              </span>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-6 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              Created {formatDateTime(ticket.createdAt)}
            </div>
            <div className="flex items-center gap-1">
              <Tag className="h-4 w-4" />
              Updated {formatDateTime(ticket.updatedAt)}
            </div>
          </div>
        </div>

        <div className="p-6">
          <h2 className="text-sm font-medium text-muted-foreground">
            Description
          </h2>
          <div className="mt-2 whitespace-pre-wrap text-sm">
            {ticket.description}
          </div>
        </div>

        {/* Future: Add comments/replies section here */}
        <div className="border-t p-6">
          <h2 className="text-sm font-medium text-muted-foreground">
            Activity
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            No activity yet. Our support team will respond to your ticket soon.
          </p>
        </div>
      </div>
    </div>
  );
}

export default TicketDetails;
