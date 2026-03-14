import React from 'react';
import { ArrowLeft, AlertCircle, Clock, Tag } from 'lucide-react';
import { type TicketDetails as TicketDetailsType, type TicketPriority, type TicketStatus } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface TicketDetailsProps {
  ticket: TicketDetailsType | null;
  error?: string | null;
}

export function TicketDetails({ ticket, error }: TicketDetailsProps) {
  const getStatusColor = (status: TicketStatus) => {
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
              <h1 className="text-xl font-semibold">{ticket.subject}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Ticket #{ticket.ticketNumber}
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
