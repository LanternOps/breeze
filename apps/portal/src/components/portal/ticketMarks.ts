import type { TicketPriority, TicketStatus } from '@/lib/api';

/**
 * The one source for how a ticket's status and priority render as StatusMarks
 * (ui.tsx): a dot of the background-tuned token beside text in the AA-safe
 * `-on-tint` foreground. Shared by TicketList and TicketDetails so the same
 * datum never wears two treatments (the detail page used to show filled pills
 * while the list showed marks).
 *
 * Urgent keeps its weight through the destructive hue; everything routine
 * stays quiet — a fresh "normal" ticket must not shout at the person who
 * filed it.
 */
export function ticketStatusMark(status: TicketStatus): { dot: string; text: string } {
  switch (status) {
    case 'open':
      return { dot: 'bg-primary', text: 'text-primary-on-tint' };
    case 'in_progress':
      return { dot: 'bg-warning', text: 'text-warning-on-tint' };
    case 'resolved':
      return { dot: 'bg-success', text: 'text-success-on-tint' };
    case 'closed':
      return { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' };
  }
}

export function ticketPriorityMark(priority: TicketPriority): { dot: string; text: string } {
  switch (priority) {
    case 'urgent':
      return { dot: 'bg-destructive', text: 'text-destructive-on-tint' };
    case 'high':
      return { dot: 'bg-warning', text: 'text-warning-on-tint' };
    case 'normal':
      return { dot: 'bg-primary', text: 'text-primary-on-tint' };
    case 'low':
      return { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' };
  }
}

export function ticketStatusLabel(status: TicketStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'in_progress':
      return 'In progress';
    case 'resolved':
      return 'Resolved';
    case 'closed':
      return 'Closed';
  }
}
