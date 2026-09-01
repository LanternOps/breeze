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
import { organizations, partners, tickets } from '../db/schema';
import { getEmailService } from '../services/email';
import { escapeHtml } from '../services/emailLayout';
import { buildThreadingHeaders, partnerInboundAddress, ticketThreadAnchor } from '../services/inboundEmail/outboundThreading';
import { buildAutoresponseEmail } from '../services/inboundEmail/autoresponseTemplate';
import { resolveOutboundMailbox } from '../services/ticketMailbox/resolveOutboundMailbox';
import { sendThreadedReply, sendNewMail } from '../services/ticketMailbox/graphReplySender';
import type { TicketTemplateVars } from '@breeze/shared';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { TICKET_EVENTS_QUEUE, type TicketEvent } from '../services/ticketEvents';
import { createNotification } from '../services/userNotifications';
import { buildTicketPush, dispatchPushToTokens } from '../services/expoPush';
import {
  admitPush,
  assertSamePartner,
  isAuthorisedForTicket,
  listAnySlaSubscribers,
  loadTicketPushPrefs,
  loadUserCandidate,
  resolvePushJobs,
  type PendingPush,
} from '../services/ticketPush';

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
  // Customer-facing only: when the partner has a connected M365 mailbox, the reply
  // is sent FROM that mailbox via Graph (native threading) instead of EmailService.
  // Tech/assignee payloads never set this, so they always use EmailService.
  graphMailbox?: { tenantId: string; mailbox: string; originalMessageId: string | null };
}

async function getTicket(ticketId: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  return rows[0] ?? null;
}

async function getOrgName(orgId: string): Promise<string> {
  const rows = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return rows[0]?.name ?? '';
}

/** Resolved once per event; collected results are sent after the context exits. */
interface Collected {
  emails: EmailPayload[];
  /**
   * Recipients that SHOULD be pushed. Deliberately not resolved jobs: the
   * transport gates (Redis throttle) and the device read happen after the
   * collection context closes — see handleTicketEvent (#1105).
   */
  pushes: PendingPush[];
}

/**
 * Returns collected email payloads AND push jobs (sends neither). The assignee
 * lookup is done BEFORE the notification row so an FK violation can never occur
 * for a deleted user.
 *
 * W07 (#3901): the row is written through createNotification with a dedupeKey —
 * that is the idempotency anchor. A null return means "already written by a
 * previous attempt", so a BullMQ retry re-pushes nothing and re-emails nobody.
 */
async function collectAssigneeNotification(
  event: TicketEvent,
  assigneeId: string,
  eventId: string
): Promise<Collected> {
  const none: Collected = { emails: [], pushes: [] };
  // Self-assign: skip notification entirely.
  if (!assigneeId || assigneeId === event.actorUserId) return none;

  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  // Assignee lookup FIRST — if no user row, terminal condition (deleted user).
  // Then the D5 partner assertion: this worker runs with RLS bypassed, so the
  // tenant boundary is entirely app-layer from here on.
  const assignee = await loadUserCandidate(assigneeId);
  if (!assignee) return none;
  // A NULL event.partnerId is NOT a mismatch. `tickets.partner_id` is
  // deliberately nullable (2026-06-09-a-native-ticketing-core.sql: "old API
  // code may still insert tickets without it during a rolling deploy") and both
  // emitters propagate the null verbatim, so treating it as a forged recipient
  // would drop the row AND the email main writes unconditionally — and raise a
  // Sentry error for a legacy row. When the event carries no partner the PUSH
  // is withheld (it is gated on event.partnerId below); the inbox row and email
  // are not.
  if (event.partnerId && !assertSamePartner(assignee, event.partnerId, { ticketId: ticket.id })) return none;

  // Idempotency anchor (D2): null = replay -> nothing else happens.
  const id = await createNotification({
    userId: assigneeId,
    orgId: event.orgId,
    type: 'ticket',
    priority: 'normal',
    title: `Ticket assigned: ${label}`,
    message: ticket.subject,
    link: `/tickets#${ticket.internalNumber ?? ticket.id}`,
    dedupeKey: `ticket:${ticket.id}:assigned:${assigneeId}:${eventId}`,
  });
  if (id === null) return none;

  const emails: EmailPayload[] = assignee.email
    ? [{
        to: assignee.email,
        subject: `[${label}] Assigned to you: ${ticket.subject}`,
        html: `<p>You have been assigned ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(ticket.subject)}</p>`,
        bestEffort: true,
      }]
    : [];

  // Account status (D5) gates the PHONE only — a device cannot be registered
  // without a login, so a non-active user has nothing to push to. It must never
  // suppress the inbox row or the email: an invited technician assigned a
  // ticket before accepting their invite still has to be told.
  const pushes: PendingPush[] = [];
  const prefs = await loadTicketPushPrefs(assigneeId);
  if (
    prefs.assignedEnabled &&
    assignee.status === 'active' &&
    event.partnerId &&
    (await isAuthorisedForTicket(assigneeId, event.partnerId, event.orgId))
  ) {
    pushes.push({
      userId: assigneeId,
      spec: buildTicketPush({
        ticketId: ticket.id,
        reason: 'assigned',
        internalNumber: ticket.internalNumber ?? null,
        orgName: await getOrgName(event.orgId),
      }),
    });
  }
  return { emails, pushes };
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
 *
 * `bodyHtml` accepts a plain string OR a builder `(ticket) => string` (#3828
 * wave-6-3 task 2). The builder form exists so the Resolved-email caller can
 * compose its body from `ticket.resolutionNote` — fetched here from the DB —
 * instead of from the event payload, which no longer carries that field.
 */
async function collectRequesterEmail(
  event: TicketEvent,
  bodyHtml: string | ((ticket: NonNullable<Awaited<ReturnType<typeof getTicket>>>) => string),
  subjectPrefix: string,
  commentId?: string
): Promise<EmailPayload[]> {
  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  if (!ticket.submitterEmail) return [];

  const html = typeof bodyHtml === 'function' ? bodyHtml(ticket) : bodyHtml;
  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  // Customer-facing reply routing: if this partner has a connected M365 mailbox, send
  // FROM that mailbox via Graph (native threading). Tech/assignee notifications never
  // call collectRequesterEmail, so they never carry graphMailbox.
  const graphMailbox = (await resolveOutboundMailbox(ticket.id, ticket.partnerId)) ?? undefined;

  // Un-threaded path (e.g. ticket.status_changed 'Resolved'): unchanged from before.
  if (!commentId) {
    return [{
      to: ticket.submitterEmail,
      subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
      html,
      graphMailbox
    }];
  }

  // Threaded path (Phase 4 §5): partner inbound address as Reply-To + deterministic
  // Message-ID/In-Reply-To/References so the requester's client threads the reply.
  let replyTo: string | undefined;
  if (ticket.partnerId) {
    const partnerRows = await db
      .select({ slug: partners.slug, inboundLocalPart: partners.inboundLocalPart, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ticket.partnerId))
      .limit(1);
    const slug = partnerRows[0]?.slug;
    const override = (partnerRows[0]?.settings as
      | { ticketing?: { inbound?: { address?: string } } }
      | undefined)?.ticketing?.inbound?.address;
    if (slug) replyTo = partnerInboundAddress(partnerRows[0]?.inboundLocalPart ?? slug, override) ?? undefined;
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
    html,
    replyTo,
    headers,
    graphMailbox
  }];
}

/**
 * One-time autoresponse acknowledgement (spec §5). The autoresponder gate
 * (inboundEmail/autoresponder.ts) already applied loop-prevention + the per-sender
 * cap before emitting; here we just compose + send. The body is the partner's
 * customized auto-reply template when set (settings.ticketing.inbound.autoresponse
 * {Subject,Body}, rendered with the ticket's merge variables), otherwise the default
 * acknowledgement — see buildAutoresponseEmail. Loop hygiene: stamp Auto-Submitted: auto-replied and set
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

  let replyTo: string | undefined;
  let custom: { subject: string | null; body: string | null } | undefined;
  let partnerName = '';
  if (ticket.partnerId) {
    const partnerRows = await db
      .select({ slug: partners.slug, name: partners.name, inboundLocalPart: partners.inboundLocalPart, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ticket.partnerId))
      .limit(1);
    const slug = partnerRows[0]?.slug;
    partnerName = partnerRows[0]?.name ?? '';
    const inbound = (partnerRows[0]?.settings as
      | { ticketing?: { inbound?: { address?: string; autoresponseSubject?: string | null; autoresponseBody?: string | null } } }
      | undefined)?.ticketing?.inbound;
    if (slug) replyTo = partnerInboundAddress(partnerRows[0]?.inboundLocalPart ?? slug, inbound?.address) ?? undefined;
    custom = { subject: inbound?.autoresponseSubject ?? null, body: inbound?.autoresponseBody ?? null };
  }

  let orgName = '';
  if (ticket.orgId) {
    const orgRows = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, ticket.orgId))
      .limit(1);
    orgName = orgRows[0]?.name ?? '';
  }

  const vars: TicketTemplateVars = {
    ticket_number: ticket.internalNumber ?? '',
    ticket_subject: ticket.subject ?? event.payload.subject,
    requester_name: ticket.submitterName ?? '',
    requester_email: event.payload.to,
    org_name: orgName,
    partner_name: partnerName,
  };

  const tpl = buildAutoresponseEmail({
    internalNumber: event.payload.internalNumber,
    subject: event.payload.subject,
    custom,
    vars,
  });

  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
  const anchor = ticketThreadAnchor(ticket.id);
  if (anchor) headers['Message-ID'] = anchor;

  // Customer-facing: route the autoresponse through the partner's M365 mailbox when
  // connected (Graph manages threading; the SMTP Auto-Submitted/Message-ID headers
  // are only used on the EmailService fallback path).
  const graphMailbox = (await resolveOutboundMailbox(ticket.id, ticket.partnerId)) ?? undefined;

  return [{ to: event.payload.to, subject: tpl.subject, html: tpl.html, replyTo, headers, bestEffort: true, graphMailbox }];
}

async function collectSlaBreachNotification(
  event: Extract<TicketEvent, { type: 'ticket.sla_breached' }>
): Promise<Collected> {
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  const label = event.payload.internalNumber ?? event.ticketId;
  const target = event.payload.target;
  const emails: EmailPayload[] = [];
  const pushes: PendingPush[] = [];
  const notified = new Set<string>();
  let orgName: string | null = null;
  const spec = async () =>
    buildTicketPush({
      ticketId: ticket.id,
      reason: 'sla_breached',
      target,
      internalNumber: event.payload.internalNumber,
      orgName: orgName ?? (orgName = await getOrgName(event.orgId)),
    });

  /**
   * The in-app row is ALWAYS written for a candidate that reaches here; `push`
   * governs the phone only (spec D6: the throttle applies to every push, never
   * to in-app rows, and every push-drop row in the spec's failure-modes table
   * keeps "in-app row + email written"). Suppressing the inbox row would also
   * be a silent behaviour regression: the owner's SLA row is unconditional on
   * main today.
   */
  const notify = async (userId: string, opts: { push: boolean }): Promise<boolean> => {
    if (notified.has(userId)) return false;
    notified.add(userId);
    const id = await createNotification({
      userId,
      orgId: event.orgId,
      type: 'ticket',
      priority: 'normal',
      title: `SLA breached: ${label}`,
      message: `${target} SLA breached for ${event.payload.subject}`,
      link: `/tickets#${event.payload.internalNumber ?? event.ticketId}`,
      dedupeKey: `ticket:${ticket.id}:sla:${target}:${userId}`,
    });
    if (id === null) return false; // replay — nothing further, INCLUDING the email
    if (opts.push) pushes.push({ userId, spec: await spec() });
    return true;
  };

  // Owner: email and in-app row as before (unconditional). slaScope governs the
  // PUSH only — 'off' means "stop buzzing my phone", not "hide it from my inbox".
  const assigneeId = event.payload.assigneeId;
  if (assigneeId) {
    const assignee = await loadUserCandidate(assigneeId);
    // Same null-partner rule as the assigned branch: a legacy ticket with no
    // partner_id is not a forged recipient, it just cannot be pushed.
    const partnerOk = assignee && (!event.partnerId || assertSamePartner(assignee, event.partnerId, { ticketId: ticket.id }));
    if (assignee && partnerOk) {
      const prefs = await loadTicketPushPrefs(assigneeId);
      // Short-circuit deliberately: skip the permission round-trip when the
      // preference (or a non-active account) already rules the push out.
      const pushOwner =
        prefs.slaScope !== 'off' &&
        assignee.status === 'active' &&
        !!event.partnerId &&
        (await isAuthorisedForTicket(assigneeId, event.partnerId, event.orgId));
      // The email is queued only AFTER the dedupe anchor confirms this is not a
      // replay. Queuing it first (as this branch originally did) meant a
      // redelivered BullMQ job re-emailed the owner while the row and the push
      // both deduped — breaking the wave's "a retry re-emails nobody" contract
      // that the assigned branch already honours.
      const wrote = await notify(assigneeId, { push: pushOwner });
      if (wrote && assignee.email) {
        emails.push({
          to: assignee.email,
          subject: `SLA breached: ${label} — ${event.payload.subject}`,
          html: `<p>The ${escapeHtml(target)} SLA breached for ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(event.payload.subject)}</p>`,
          bestEffort: true,
        });
      }
    }
  }

  // 'any' subscribers (D5): partner-filtered in SQL, re-authorised per user.
  // Push only — no email.
  //
  // NOTE the asymmetry with the owner branch above, and it is intentional: an
  // 'any' subscriber gets NO row at all when unauthorised, because they would
  // not otherwise be a recipient of this ticket — writing an inbox row for
  // someone who cannot access the org would leak the ticket's existence. The
  // owner is already a legitimate recipient, so only their push is gated.
  if (event.partnerId) {
    const { users: subs } = await listAnySlaSubscribers(event.partnerId);
    for (const sub of subs) {
      if (notified.has(sub.userId)) continue;
      if (!assertSamePartner(sub, event.partnerId, { ticketId: ticket.id })) continue;
      if (!(await isAuthorisedForTicket(sub.userId, event.partnerId, event.orgId))) continue;
      await notify(sub.userId, { push: true });
    }
  }

  return { emails, pushes };
}

/**
 * Core handler: runs DB work inside the system context, collects email payloads,
 * then sends emails after the context exits.
 */
export async function handleTicketEvent(event: TicketEvent, jobId?: string): Promise<void> {
  // W07 (#3901): the dedupe anchor. Jobs queued before eventId shipped lack it,
  // so fall back to the BullMQ job id (stable across that job's retries).
  const eventId = event.eventId ?? jobId ?? `legacy:${event.ticketId}:${event.type}`;
  let emailPayloads: EmailPayload[] = [];
  let pending: PendingPush[] = [];

  await runWithSystemDbAccess(async () => {
    switch (event.type) {
      case 'ticket.created':
      case 'ticket.assigned': {
        const assigneeId = event.payload.assigneeId;
        if (assigneeId) {
          const collected = await collectAssigneeNotification(event, assigneeId, eventId);
          emailPayloads = collected.emails;
          pending = collected.pushes;
        }
        return;
      }
      case 'ticket.sla_breached': {
        // NOT gated on assigneeId any more: an UNASSIGNED breach still fans out
        // to partner-wide ('any') SLA subscribers.
        const collected = await collectSlaBreachNotification(event);
        emailPayloads = collected.emails;
        pending = collected.pushes;
        return;
      }
      case 'ticket.commented': {
        // Payload-trust contract: the worker TRUSTS event.payload.isPublic — the
        // EMITTER is the sole authority on visibility. inboundEmailService always
        // emits isPublic:true for an inbound customer comment; an internal note never
        // emits a public ticket.commented event. The composer is TEMPLATE-ONLY: it
        // never loads ticket_comments, so the comment's content is structurally
        // unreachable from any outbound body/subject (see ticketNotifyWorker.leak.test.ts).
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
        // #3828 wave-6-3 task 2: resolutionNote no longer rides the event
        // payload (it is free-text ticket content) — read it off the ticket
        // row that collectRequesterEmail fetches instead.
        if (event.payload.to === 'resolved') {
          emailPayloads = await collectRequesterEmail(
            event,
            (ticket) => {
              // Freshness guard (read-your-own-write race): the ticket row fetched
              // here can be STALE relative to the status_changed event that queued
              // this job — emitTicketEvent fires while the request transaction is
              // still open (ticketService.ts), and this queue's jobs carry no
              // delay. Retry ONLY while the row still reads the event's PRE-
              // transition status (`event.payload.from`) — that is the one case
              // that actually means "not yet committed" (`resolutionNote` here
              // can be null, or a previous resolution's stale text). The moment
              // the row reads anything else — including a status the ticket has
              // moved on to SINCE this resolve (e.g. resolve->closed, or a fast
              // reopen) — the transition described by THIS event committed, and
              // conflating that with "not yet visible" was the bug: with the
              // queue's `attempts: 3` / exponential backoff (~6s window), any
              // resolve->closed or resolve->reopen inside that window failed
              // every attempt and the requester never got the resolved email.
              // Once committed, compose from the row's current `resolutionNote`
              // — reopen does not clear it (changeTicketStatus's reopen branch),
              // so it still reflects the resolution this event is reporting.
              if (ticket.status === event.payload.from) {
                throw new Error(
                  `Ticket transition not yet visible (likely uncommitted): ${ticket.id}`
                );
              }
              const note = ticket.resolutionNote ?? '';
              return `<p>Your ticket has been resolved.</p>${note ? `<p>${escapeHtml(note)}</p>` : ''}`;
            },
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

  // Push materialisation and delivery — all OUTSIDE the collection context
  // (#1105). The collection transaction above is now bounded to permission
  // reads and notification inserts; the Redis throttle runs with no DB context
  // open at all, and the device read gets its own SHORT, batched system context
  // (the alertWorker pattern: one short context per DB read, never a blanket
  // wrap around a fan-out loop). Deliberately BEFORE the email early-return
  // below: a push-only recipient ('any' SLA subscriber) produces zero emails.
  const admitted = await admitPush(pending);
  const pushJobs = admitted.length > 0
    ? await runWithSystemDbAccess(() => resolvePushJobs(admitted))
    : [];

  for (const job of pushJobs) {
    const r = await dispatchPushToTokens(job.tokens, job.spec, 'ticket');
    if (r.errors > 0) {
      console.warn(`[TicketNotify] ticket push partial failure ticket=${event.ticketId} dispatched=${r.dispatched} errors=${r.errors}`);
    }
  }

  // Send emails OUTSIDE the DB context to avoid idle-in-transaction pool poison (#1105).
  if (emailPayloads.length === 0) return;
  // getEmailService() may be null (no platform transport configured). Graph payloads
  // must still send in that case, so the null-guard moved inside the loop's EmailService
  // branch rather than short-circuiting the whole send phase.
  const email = getEmailService();

  for (const payload of emailPayloads) {
    const send = async () => {
      // Customer-facing reply via the partner's connected M365 mailbox (Graph).
      if (payload.graphMailbox) {
        const { tenantId, mailbox, originalMessageId } = payload.graphMailbox;
        if (originalMessageId) {
          await sendThreadedReply({ tenantId, mailbox }, originalMessageId, payload.html);
        } else {
          await sendNewMail({ tenantId, mailbox }, payload.to, payload.subject, payload.html);
        }
        return;
      }
      // Platform EmailService path (tech/assignee notifications + customers on partners
      // with no connected mailbox). Skip silently if no transport is configured.
      if (!email) return;
      await email.sendEmail({
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        replyTo: payload.replyTo,
        headers: payload.headers
      });
    };

    if (payload.bestEffort) {
      try {
        await send();
      } catch (err) {
        console.error('[TicketNotify] email send failed', err instanceof Error ? err.message : err);
      }
    } else {
      // Non-best-effort: let throw bubble up so BullMQ can retry.
      await send();
    }
  }
}

let worker: Worker<TicketEvent> | null = null;

export function initializeTicketNotifyWorker(): Promise<void> {
  if (worker) return Promise.resolve();

  worker = new Worker<TicketEvent>(
    TICKET_EVENTS_QUEUE,
    async (job: Job<TicketEvent>) => handleTicketEvent(job.data, job.id),
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
