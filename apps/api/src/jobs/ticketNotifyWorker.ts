/**
 * Ticket Notification Fan-out Worker
 *
 * Consumes the `ticket-events` BullMQ queue and fans out in-app and email
 * notifications according to Phase 1 rules (spec §3):
 *   - ticket.assigned / ticket.created (with assignee) → in-app + email to assignee
 *   - ticket.commented (isPublic) → email to requester
 *   - ticket.status_changed → resolved → email to requester
 *   - ticket.sla_breached → in-app + email to assignee
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
import { partners, tickets, userNotifications, users } from '../db/schema';
import { getEmailService } from '../services/email';
import { escapeHtml } from '../services/emailLayout';
import { buildThreadingHeaders, partnerInboundAddress, ticketThreadAnchor } from '../services/inboundEmail/outboundThreading';
import { buildAutoresponseEmail } from '../services/inboundEmail/autoresponseTemplate';
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
  replyTo?: string;
  headers?: Record<string, string>;
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
 *
 * Threading is OPT-IN per call (Phase 4 §5): pass a `commentId` to thread the
 * email (technician public-comment reply). When `commentId` is absent (e.g. the
 * `ticket.status_changed` 'Resolved' email) the function behaves exactly as
 * before — no Reply-To, no headers, no anchor stamp. This keeps the Resolved
 * email from emitting a bare-anchor Message-ID that would collide with the
 * autoresponse's Message-ID and confuse the requester's mail client + PR1's
 * thread-key resolver.
 */
async function collectRequesterEmail(
  event: TicketEvent,
  bodyHtml: string,
  subjectPrefix: string,
  commentId?: string
): Promise<EmailPayload[]> {
  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  if (!ticket.submitterEmail) return [];

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  // Un-threaded path (e.g. ticket.status_changed 'Resolved'): unchanged from before.
  if (!commentId) {
    return [{
      to: ticket.submitterEmail,
      subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
      html: bodyHtml
    }];
  }

  // Threaded path (Phase 4 §5): partner inbound address as Reply-To + deterministic
  // Message-ID/In-Reply-To/References so the requester's client threads the reply.
  let replyTo: string | undefined;
  if (ticket.partnerId) {
    const partnerRows = await db
      .select({ slug: partners.slug, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ticket.partnerId))
      .limit(1);
    const slug = partnerRows[0]?.slug;
    const override = (partnerRows[0]?.settings as
      | { ticketing?: { inbound?: { address?: string } } }
      | undefined)?.ticketing?.inbound?.address;
    if (slug) replyTo = partnerInboundAddress(slug, override) ?? undefined;
  }

  const built = buildThreadingHeaders({ ticketId: ticket.id, commentId });
  const headers = Object.keys(built).length > 0 ? built : undefined;

  // Stamp the thread anchor onto the ticket the FIRST time so inbound replies match
  // PR1's email_thread_key resolver (round-trips with the In-Reply-To/References above).
  const anchor = ticketThreadAnchor(ticket.id);
  if (anchor && !ticket.emailThreadKey) {
    await db.update(tickets).set({ emailThreadKey: anchor }).where(eq(tickets.id, ticket.id));
  }

  return [{
    to: ticket.submitterEmail,
    subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
    html: bodyHtml,
    replyTo,
    headers
  }];
}

/**
 * One-time autoresponse acknowledgement (spec §5). The autoresponder gate
 * (inboundEmail/autoresponder.ts) already applied loop-prevention + the per-sender
 * cap before emitting; here we just compose + send. The body is the hardcoded v1
 * template (PR4 swaps it). Loop hygiene: stamp Auto-Submitted: auto-replied and set
 * the ticket thread anchor as Message-ID so the requester's reply threads. Reply-To
 * is the partner inbound address (self-hosted override honored).
 */
async function collectAutoresponse(
  event: Extract<TicketEvent, { type: 'ticket.autoresponse' }>
): Promise<EmailPayload[]> {
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  const tpl = buildAutoresponseEmail({
    internalNumber: event.payload.internalNumber,
    subject: event.payload.subject
  });

  let replyTo: string | undefined;
  if (ticket.partnerId) {
    const partnerRows = await db
      .select({ slug: partners.slug, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ticket.partnerId))
      .limit(1);
    const slug = partnerRows[0]?.slug;
    const override = (partnerRows[0]?.settings as
      | { ticketing?: { inbound?: { address?: string } } }
      | undefined)?.ticketing?.inbound?.address;
    if (slug) replyTo = partnerInboundAddress(slug, override) ?? undefined;
  }

  // Anchor as Message-ID so the requester's reply threads; Auto-Submitted for loop hygiene.
  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
  const anchor = ticketThreadAnchor(ticket.id);
  if (anchor) headers['Message-ID'] = anchor;

  return [{ to: event.payload.to, subject: tpl.subject, html: tpl.html, replyTo, headers, bestEffort: true }];
}

async function collectSlaBreachNotification(
  event: Extract<TicketEvent, { type: 'ticket.sla_breached' }>,
  assigneeId: string
): Promise<EmailPayload[]> {
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  const assigneeRows = await db.select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, assigneeId))
    .limit(1);
  const assignee = assigneeRows[0];
  if (!assignee) {
    return [];
  }

  const label = event.payload.internalNumber ?? event.ticketId;
  const target = event.payload.target;

  await db.insert(userNotifications).values({
    userId: assigneeId,
    orgId: event.orgId,
    type: 'ticket',
    priority: 'normal',
    title: `SLA breached: ${label}`,
    message: `${target} SLA breached for ${event.payload.subject}`,
    link: `/tickets#${event.payload.internalNumber ?? event.ticketId}`
  }).returning();

  if (!assignee.email) return [];

  return [{
    to: assignee.email,
    subject: `SLA breached: ${label} — ${event.payload.subject}`,
    html: `<p>The ${escapeHtml(target)} SLA breached for ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(event.payload.subject)}</p>`,
    bestEffort: true
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
      case 'ticket.sla_breached': {
        const assigneeId = event.payload.assigneeId;
        if (assigneeId) {
          emailPayloads = await collectSlaBreachNotification(event, assigneeId);
        }
        return;
      }
      case 'ticket.commented': {
        // Skip requester email for inbound comments — the comment originated FROM the
        // requester's email, so echoing it back would create a mail loop.
        if (event.payload.isPublic && !event.payload.inbound) {
          emailPayloads = await collectRequesterEmail(
            event,
            '<p>Your ticket has a new reply. Sign in to the portal to view it.</p>',
            'New reply',
            event.payload.commentId
          );
        }
        return;
      }
      case 'ticket.updated': {
        // Plain field edits (subject, priority, …) notify no one in Phase 1 —
        // explicit no-op case so the exhaustiveness default stays meaningful.
        return;
      }
      case 'ticket.autoresponse': {
        emailPayloads = await collectAutoresponse(event);
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
    const sendArgs = {
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      replyTo: payload.replyTo,
      headers: payload.headers
    };
    if (payload.bestEffort) {
      try {
        await email.sendEmail(sendArgs);
      } catch (err) {
        console.error('[TicketNotify] email send failed', err instanceof Error ? err.message : err);
      }
    } else {
      // Non-best-effort: let throw bubble up so BullMQ can retry.
      await email.sendEmail(sendArgs);
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
