/**
 * Ticket Notification Fan-out Worker
 *
 * Consumes the `ticket-events` BullMQ queue and fans out in-app and email
 * notifications according to Phase 1 rules (spec §3):
 *   - ticket.assigned / ticket.created (with assignee) → in-app + email to assignee
 *   - ticket.commented (isPublic) → email to requester
 *   - ticket.status_changed → resolved → email to requester
 *
 * Pre-commit emission contract: ticketService emits events while the request
 * transaction is still open (see emitTicketEvent usage in ticketService.ts).
 * A fast worker may dequeue an event before the ticket row is visible — when
 * the ticket lookup returns no row, we THROW so BullMQ retries the job
 * (attempts: 3, exponential back-off). The retry window gives the committing
 * transaction time to become visible.
 *
 * EXCEPTION: a missing ASSIGNEE user row is terminal (the user was deleted),
 * not retryable — silently return for that case only.
 */

import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { tickets, userNotifications, users } from '../db/schema';
import { getEmailService } from '../services/email';
import { escapeHtml } from '../services/emailLayout';
import { getBullMQConnection } from '../services/redis';
import { TICKET_EVENTS_QUEUE, type TicketEvent } from '../services/ticketEvents';

const { db } = dbModule;

// Mirror the alertWorker pattern: wrap in withSystemDbAccessContext if available.
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

async function getTicket(ticketId: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  return rows[0] ?? null;
}

async function notifyAssignee(event: TicketEvent, assigneeId: string): Promise<void> {
  // Self-assign: skip notification entirely.
  if (!assigneeId || assigneeId === event.actorUserId) return;

  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  await db.insert(userNotifications).values({
    userId: assigneeId,
    orgId: event.orgId,
    type: 'ticket',
    priority: 'normal',
    title: `Ticket assigned: ${label}`,
    message: ticket.subject,
    link: `/tickets#${ticket.internalNumber ?? ticket.id}`
  }).returning();

  const email = getEmailService();
  if (!email) return;

  // A missing assignee user row is a terminal condition (deleted user) — silently return.
  const assigneeRows = await db.select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, assigneeId))
    .limit(1);
  const assignee = assigneeRows[0];
  if (!assignee?.email) return;

  try {
    await email.sendEmail({
      to: assignee.email,
      subject: `[${label}] Assigned to you: ${ticket.subject}`,
      html: `<p>You have been assigned ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(ticket.subject)}</p>`
    });
  } catch (err) {
    console.error('[TicketNotify] email send failed', err instanceof Error ? err.message : err);
  }
}

async function emailRequester(event: TicketEvent, bodyHtml: string, subjectPrefix: string): Promise<void> {
  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  if (!ticket.submitterEmail) return;

  const email = getEmailService();
  if (!email) return;

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  await email.sendEmail({
    to: ticket.submitterEmail,
    subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
    html: bodyHtml
  });
}

export async function handleTicketEvent(event: TicketEvent): Promise<void> {
  switch (event.type) {
    case 'ticket.created':
    case 'ticket.assigned': {
      const assigneeId = event.payload.assigneeId as string | null;
      if (assigneeId) await notifyAssignee(event, assigneeId);
      return;
    }
    case 'ticket.commented': {
      if (event.payload.isPublic === true) {
        await emailRequester(
          event,
          '<p>Your ticket has a new reply. Sign in to the portal to view it.</p>',
          'New reply'
        );
      }
      return;
    }
    case 'ticket.status_changed': {
      if (event.payload.to === 'resolved') {
        const note = String(event.payload.resolutionNote ?? '');
        await emailRequester(
          event,
          `<p>Your ticket has been resolved.</p>${note ? `<p>${escapeHtml(note)}</p>` : ''}`,
          'Resolved'
        );
      }
      return;
    }
  }
}

let worker: Worker<TicketEvent> | null = null;

export function initializeTicketNotifyWorker(): Promise<void> {
  if (worker) return Promise.resolve();

  worker = new Worker<TicketEvent>(
    TICKET_EVENTS_QUEUE,
    async (job: Job<TicketEvent>) => runWithSystemDbAccess(() => handleTicketEvent(job.data)),
    { connection: getBullMQConnection(), concurrency: 5 }
  );

  worker.on('error', (error) => {
    console.error('[TicketNotify] Worker error:', error);
  });

  worker.on('failed', (job, error) => {
    console.error(`[TicketNotify] Job ${job?.id} failed:`, error);
  });

  return Promise.resolve();
}

export async function shutdownTicketNotifyWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
