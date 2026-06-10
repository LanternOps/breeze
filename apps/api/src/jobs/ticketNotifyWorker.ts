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
 * (retries per the job options set in emitTicketEvent (ticketEvents.ts)).
 * The retry window gives the committing transaction time to become visible.
 *
 * EXCEPTION: a missing ASSIGNEE user row is terminal (the user was deleted),
 * not retryable — silently return for that case only. The assignee lookup
 * is performed BEFORE the userNotifications insert so we never attempt the
 * FK-constrained insert for a non-existent user.
 *
 * Email sends happen OUTSIDE the system DB context (see pool-poison issue #1105):
 * DB reads + in-app inserts are collected inside the context, emails are sent
 * after the context exits.
 */

import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { tickets, userNotifications, users } from '../db/schema';
import { getEmailService } from '../services/email';
import { escapeHtml } from '../services/emailLayout';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { TICKET_EVENTS_QUEUE, type TicketEvent } from '../services/ticketEvents';

const { db } = dbModule;

// Mirror the alertWorker pattern: wrap in withSystemDbAccessContext if available.
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    console.error('[TicketNotify] withSystemDbAccessContext unavailable — running without system DB context');
    return fn();
  }
  return withSystem(fn);
};

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  bestEffort?: boolean; // if true, swallow send errors
}

async function getTicket(ticketId: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Returns collected email payloads (does not send). The assignee lookup is
 * done BEFORE the userNotifications insert so an FK-violation can never occur
 * for a deleted user.
 */
async function collectAssigneeNotification(
  event: TicketEvent,
  assigneeId: string
): Promise<EmailPayload[]> {
  // Self-assign: skip notification entirely.
  if (!assigneeId || assigneeId === event.actorUserId) return [];

  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  // Assignee lookup FIRST — if no user row, terminal condition (deleted user).
  const assigneeRows = await db.select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, assigneeId))
    .limit(1);
  const assignee = assigneeRows[0];
  if (!assignee) {
    // User was deleted — silently skip, no insert, no email (terminal).
    return [];
  }

  // Assignee exists — safe to insert FK-constrained notification row.
  await db.insert(userNotifications).values({
    userId: assigneeId,
    orgId: event.orgId,
    type: 'ticket',
    priority: 'normal',
    title: `Ticket assigned: ${label}`,
    message: ticket.subject,
    link: `/tickets#${ticket.internalNumber ?? ticket.id}`
  }).returning();

  if (!assignee.email) return [];

  return [{
    to: assignee.email,
    subject: `[${label}] Assigned to you: ${ticket.subject}`,
    html: `<p>You have been assigned ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(ticket.subject)}</p>`,
    bestEffort: true
  }];
}

/**
 * Returns collected email payloads (does not send).
 */
async function collectRequesterEmail(
  event: TicketEvent,
  bodyHtml: string,
  subjectPrefix: string
): Promise<EmailPayload[]> {
  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  if (!ticket.submitterEmail) return [];

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  return [{
    to: ticket.submitterEmail,
    subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
    html: bodyHtml
  }];
}

/**
 * Core handler: runs DB work inside the system context, collects email payloads,
 * then sends emails after the context exits.
 */
export async function handleTicketEvent(event: TicketEvent): Promise<void> {
  let emailPayloads: EmailPayload[] = [];

  await runWithSystemDbAccess(async () => {
    switch (event.type) {
      case 'ticket.created':
      case 'ticket.assigned': {
        const assigneeId = event.payload.assigneeId;
        if (assigneeId) {
          emailPayloads = await collectAssigneeNotification(event, assigneeId);
        }
        return;
      }
      case 'ticket.commented': {
        if (event.payload.isPublic) {
          emailPayloads = await collectRequesterEmail(
            event,
            '<p>Your ticket has a new reply. Sign in to the portal to view it.</p>',
            'New reply'
          );
        }
        return;
      }
      case 'ticket.updated': {
        // Plain field edits (subject, priority, …) notify no one in Phase 1 —
        // explicit no-op case so the exhaustiveness default stays meaningful.
        return;
      }
      case 'ticket.status_changed': {
        if (event.payload.to === 'resolved') {
          const note = event.payload.resolutionNote ?? '';
          emailPayloads = await collectRequesterEmail(
            event,
            `<p>Your ticket has been resolved.</p>${note ? `<p>${escapeHtml(note)}</p>` : ''}`,
            'Resolved'
          );
        }
        return;
      }
      default: {
        const _exhaustive: never = event as never;
        console.warn('[TicketNotify] Unhandled event type:', (_exhaustive as TicketEvent).type);
      }
    }
  });

  // Send emails OUTSIDE the DB context to avoid idle-in-transaction pool poison (#1105).
  const email = getEmailService();
  if (!email || emailPayloads.length === 0) return;

  for (const payload of emailPayloads) {
    if (payload.bestEffort) {
      try {
        await email.sendEmail({ to: payload.to, subject: payload.subject, html: payload.html });
      } catch (err) {
        console.error('[TicketNotify] email send failed', err instanceof Error ? err.message : err);
      }
    } else {
      // Non-best-effort: let throw bubble up so BullMQ can retry.
      await email.sendEmail({ to: payload.to, subject: payload.subject, html: payload.html });
    }
  }
}

let worker: Worker<TicketEvent> | null = null;

export function initializeTicketNotifyWorker(): Promise<void> {
  if (worker) return Promise.resolve();

  worker = new Worker<TicketEvent>(
    TICKET_EVENTS_QUEUE,
    async (job: Job<TicketEvent>) => handleTicketEvent(job.data),
    { connection: getBullMQConnection(), concurrency: 5 }
  );

  worker.on('error', (error) => {
    console.error('[TicketNotify] Worker error:', error);
  });

  worker.on('failed', (job, error) => {
    const type = job?.data?.type;
    const ticketId = job?.data?.ticketId;
    const attempts = job?.attemptsMade;
    console.error(`[TicketNotify] Job ${job?.id} failed (type=${type}, ticketId=${ticketId}, attempts=${attempts}):`, error);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return Promise.resolve();
}

export async function shutdownTicketNotifyWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
