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
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { organizations, partners, tickets, ticketComments } from '../db/schema';
import { getEmailService } from '../services/email';
import { escapeHtml } from '../services/emailLayout';
import { renderPartnerEmail, type PartnerEmailCustom } from '../services/emailTemplates/renderPartnerEmail';
import { resolveCommentNotificationPortalHref } from '../services/inboundEmail/commentNotificationPortalHref';
import { buildThreadingHeaders, partnerInboundAddress, ticketThreadAnchor } from '../services/inboundEmail/outboundThreading';
import { resolveOutboundMailbox } from '../services/ticketMailbox/resolveOutboundMailbox';
import { sendThreadedReply, sendNewMail } from '../services/ticketMailbox/graphReplySender';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { TICKET_EVENTS_QUEUE, type TicketEvent } from '../services/ticketEvents';
import { attachWorkerObservability } from './workerObservability';
import { createNotification } from '../services/userNotifications';
import { buildTicketPush, dispatchPushToTokens } from '../services/expoPush';
import {
  admitPush,
  assertSamePartner,
  isEligibleTicketRecipient,
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

interface EmailPayloadBase {
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

/**
 * Who this ticket email is FOR, in the sender contract's terms (spec §8.2).
 * Both audiences leave through the same send loop below, so the classification
 * has to travel with each payload rather than being decided at the transport.
 * Precedence for customer mail is unchanged: connected Graph mailbox first,
 * then the partner lane (W04), then the platform sender.
 */
type EmailPayloadSender =
  | { purpose: 'ticket.staff_notification' }
  | { purpose: 'ticket.customer_notification'; partnerId: string | null; partnerName: string | null };

type EmailPayload = EmailPayloadBase & EmailPayloadSender;

async function getTicket(ticketId: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  return rows[0] ?? null;
}

async function getOrgName(orgId: string): Promise<string> {
  const rows = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return rows?.[0]?.name ?? '';
}

const EMAIL_ONLY_HINT = 'If you do not have a portal account, reply to this email instead.';

type TicketRow = NonNullable<Awaited<ReturnType<typeof getTicket>>>;

type PartnerSettings = {
  ticketing?: {
    inbound?: {
      address?: string;
      autoresponseSubject?: string | null;
      autoresponseBody?: string | null;
      // When true, a public tech reply emails the customer the actual comment
      // text (for MSPs that do not run the client portal). Default/absent keeps
      // the portal-notification email and the leak guard. See the shared
      // ticketingInboundSettingsSchema (@breeze/shared).
      fullMessageReply?: boolean;
    };
  };
  emailTemplates?: {
    ticket_comment_notification?: unknown;
    ticket_autoresponse?: unknown;
    ticket_resolved?: unknown;
  };
};

interface PartnerMailBits {
  name: string;
  replyTo: string | undefined;
  emailTemplates: PartnerSettings['emailTemplates'];
  inbound: NonNullable<PartnerSettings['ticketing']>['inbound'];
}

async function loadPartnerMailBits(partnerId: string | null | undefined): Promise<PartnerMailBits> {
  const empty: PartnerMailBits = { name: '', replyTo: undefined, emailTemplates: undefined, inbound: undefined };
  if (!partnerId) return empty;
  const partnerRows = await db
    .select({
      slug: partners.slug,
      name: partners.name,
      inboundLocalPart: partners.inboundLocalPart,
      settings: partners.settings,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const row = partnerRows?.[0];
  if (!row) return empty;
  const settings = row.settings as PartnerSettings | undefined;
  const inbound = settings?.ticketing?.inbound;
  const replyTo = row.slug
    ? partnerInboundAddress(row.inboundLocalPart ?? row.slug, inbound?.address) ?? undefined
    : undefined;
  return {
    name: row.name ?? '',
    replyTo,
    emailTemplates: settings?.emailTemplates,
    inbound,
  };
}

function asPartnerEmailCustom(raw: unknown): PartnerEmailCustom | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    subject: typeof o.subject === 'string' ? o.subject : null,
    heading: typeof o.heading === 'string' ? o.heading : null,
    buttonLabel: typeof o.buttonLabel === 'string' ? o.buttonLabel : null,
    html: typeof o.html === 'string' ? o.html : null,
  };
}

async function composeLaidOutRequesterMail(
  ticket: TicketRow,
  id: 'ticket_comment_notification' | 'ticket_resolved',
): Promise<{ html: string; subject: string; replyTo: string | undefined; fullMessageReply: boolean; partnerName: string | null }> {
  let href = '';
  let hasPortalUser = false;
  try {
    const resolved = await resolveCommentNotificationPortalHref({
      ticketId: ticket.id,
      orgId: ticket.orgId,
      submitterEmail: ticket.submitterEmail ?? '',
    });
    href = resolved.href;
    hasPortalUser = resolved.hasPortalUser;
  } catch (err) {
    console.error('[TicketNotify] portal href unavailable; sending without CTA', err);
  }
  const partner = await loadPartnerMailBits(ticket.partnerId);
  const orgName = ticket.orgId ? await getOrgName(ticket.orgId) : '';
  const rendered = renderPartnerEmail({
    id,
    custom: asPartnerEmailCustom(partner.emailTemplates?.[id]),
    vars: {
      ticket_number: ticket.internalNumber ?? '',
      ticket_subject: ticket.subject ?? '',
      requester_name: ticket.submitterName ?? '',
      requester_email: ticket.submitterEmail ?? '',
      org_name: orgName,
      partner_name: partner.name,
      portal_url: href,
      email_only_hint: hasPortalUser ? '' : EMAIL_ONLY_HINT,
      ...(id === 'ticket_resolved' ? { resolution_note: ticket.resolutionNote ?? '' } : {}),
    },
    ctaUrl: href || undefined,
    brandName: partner.name,
    internalNumber: ticket.internalNumber,
    ticketSubject: ticket.subject,
  });
  return {
    html: rendered.html,
    subject: rendered.subject,
    replyTo: partner.replyTo,
    fullMessageReply: partner.inbound?.fullMessageReply === true,
    partnerName: partner.name.trim() || null,
  };
}

async function resolveCurrentTicketPartner(
  ticket: { partnerId?: string | null; orgId: string },
  testFixtureFallback?: string | null
): Promise<string | null> {
  if (ticket.partnerId) return ticket.partnerId;
  // Production full-row selects always include partnerId. This fallback keeps
  // older narrow unit fixtures compatible without weakening runtime behavior.
  if (ticket.partnerId === undefined) return testFixtureFallback ?? null;
  const rows = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, ticket.orgId)).limit(1);
  return rows[0]?.partnerId ?? null;
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
  if (ticket.deletedAt || (ticket.assignedTo !== undefined && ticket.assignedTo !== assigneeId)) return none;

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  // Assignee lookup FIRST — if no user row, terminal condition (deleted user).
  // Then the D5 partner assertion: this worker runs with RLS bypassed, so the
  // tenant boundary is entirely app-layer from here on.
  const assignee = await loadUserCandidate(assigneeId);
  if (!assignee) return none;
  const partnerId = await resolveCurrentTicketPartner(ticket, event.partnerId);
  // assertSamePartner stays for its telemetry only — a mismatch here is a
  // forged/moved user and must be reported, not merely refused. The AUTHORITY
  // decision is isEligibleTicketRecipient, the one predicate ticket assignment
  // uses, so the two surfaces cannot drift.
  if (!partnerId || !assertSamePartner(assignee, partnerId, { ticketId: ticket.id })) return none;
  if (!(await isEligibleTicketRecipient(assignee, partnerId, ticket.orgId, ticket.deviceId))) return none;

  // Idempotency anchor (D2): null = replay -> nothing else happens.
  const id = await createNotification({
    userId: assigneeId,
    orgId: ticket.orgId,
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
        purpose: 'ticket.staff_notification',
      }]
    : [];

  const pushes: PendingPush[] = [];
  const prefs = await loadTicketPushPrefs(assigneeId);
  if (prefs.assignedEnabled) {
    pushes.push({
      userId: assigneeId,
      spec: buildTicketPush({
        ticketId: ticket.id,
        reason: 'assigned',
        internalNumber: ticket.internalNumber ?? null,
        orgName: await getOrgName(ticket.orgId),
      }),
    });
  }
  return { emails, pushes };
}

/**
 * Returns collected email payloads (does not send).
 *
 * Threading is OPT-IN per call (Phase 4 §5): pass a `commentId` to thread the
 * email (technician public-comment reply). When `commentId` is absent (the
 * `ticket.status_changed` 'Resolved' email) there is no Reply-To, no headers,
 * no anchor stamp — that keeps Resolved from emitting a bare-anchor Message-ID
 * that would collide with the autoresponse.
 *
 * `beforeSend` is only for side effects (resolved freshness guard).
 * Customer html/subject come from renderPartnerEmail. `subjectOverride` replaces
 * the renderer subject when a caller needs to; comment/resolved pass the
 * renderer subject by default. Assignee mail never enters here.
 */
async function collectRequesterEmail(
  event: TicketEvent,
  commentId?: string,
  beforeSend?: (ticket: TicketRow) => void,
  subjectOverride?: string,
): Promise<EmailPayload[]> {
  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }
  // Run the guard first so the resolved freshness check retries even when we
  // later skip send (missing submitterEmail).
  beforeSend?.(ticket);
  if (!ticket.submitterEmail) return [];

  // Customer-facing reply routing: if this partner has a connected M365 mailbox, send
  // FROM that mailbox via Graph (native threading). Tech/assignee notifications never
  // call collectRequesterEmail, so they never carry graphMailbox.
  const graphMailbox = (await resolveOutboundMailbox(ticket.id, ticket.partnerId)) ?? undefined;

  if (!commentId) {
    const composed = await composeLaidOutRequesterMail(ticket, 'ticket_resolved');
    return [{
      to: ticket.submitterEmail,
      subject: subjectOverride ?? composed.subject,
      html: composed.html,
      graphMailbox,
      purpose: 'ticket.customer_notification',
      partnerId: ticket.partnerId ?? null,
      partnerName: composed.partnerName,
    }];
  }

  const composed = await composeLaidOutRequesterMail(ticket, 'ticket_comment_notification');

  // Reply-content mode (per-partner). By DEFAULT the customer gets the portal
  // "you have a new reply, sign in" notification and the comment text never
  // leaves the platform (leak guard). A partner that does NOT run the client
  // portal can opt in to `fullMessageReply`, which appends the actual public
  // comment text to the email so email becomes a real back-and-forth. Only the
  // just-posted PUBLIC comment is included; internal notes never reach this path
  // (the worker gates on event.payload.isPublic before calling here).
  let html = composed.html;
  // Full message text is appended ONLY on the platform EmailService path (which
  // sends to the resolved requester address, `ticket.submitterEmail`). On the
  // connected-M365 path the reply is a Graph createReply against the latest
  // inbound message, whose recipients can include an external Reply-To/CC we did
  // not validate; putting the actual comment text there would widen a possible
  // mis-routed reply from a bare portal notice to real content. Until that
  // recipient set is validated, M365-mailbox partners keep the notification.
  // (composed.fullMessageReply comes from the partner bits compose already loaded
  // — no second partner read here.)
  if (composed.fullMessageReply && !graphMailbox) {
    // Bound to THIS ticket (never another ticket's comment). deletedAt is SELECTED
    // (not filtered) so we can tell a soft-deleted comment (row present, deletedAt
    // set — terminal, skip the body) apart from a not-yet-committed one (no row —
    // transient, retry).
    const rows = await db
      .select({
        content: ticketComments.content,
        isPublic: ticketComments.isPublic,
        deletedAt: ticketComments.deletedAt,
      })
      .from(ticketComments)
      .where(and(eq(ticketComments.id, commentId), eq(ticketComments.ticketId, ticket.id)))
      .limit(1);
    const comment = rows[0];
    if (!comment) {
      // Pre-commit emission: the comment row may not be visible yet (the event is
      // emitted inside the posting transaction). Throw to retry — same contract as
      // the missing-ticket guard above — so the real reply eventually sends rather
      // than silently degrading to a portal-only notice for a no-portal partner.
      throw new Error(`Comment not found (likely uncommitted): ${commentId}`);
    }
    // Append the body only for a live, public comment on a LIVE ticket. A
    // soft-deleted comment (comment.deletedAt) or a soft-deleted ticket
    // (ticket.deletedAt) must NOT have its text emailed — it is no longer visible
    // in the product (the portal 404s a deleted ticket, routes/portal/tickets.ts
    // requires isNull(tickets.deletedAt)), so emailing the comment would disclose
    // content the customer can no longer see. Fall through to the portal
    // notification without the body. The staff (collectAssigneeNotification) and
    // SLA paths already skip deleted tickets; this mirrors that boundary at the one
    // point comment TEXT would leave the platform. Defense in depth on isPublic:
    // the emitter's gate is the authority; this is a second check.
    if (!ticket.deletedAt && !comment.deletedAt && comment.isPublic && comment.content.trim()) {
      html = appendFullReplyBody(html, comment.content);
    }
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
    subject: subjectOverride ?? composed.subject,
    html,
    replyTo: composed.replyTo,
    headers,
    graphMailbox,
    purpose: 'ticket.customer_notification',
    partnerId: ticket.partnerId ?? null,
    partnerName: composed.partnerName,
  }];
}

/**
 * Append the actual reply text to a comment-notification email (fullMessageReply
 * partners only). The body is HTML-escaped and newline-preserved, wrapped in a
 * quoted block below the rendered notification. Kept deliberately simple — the
 * comment `content` is plain text authored by a technician.
 */
function appendFullReplyBody(html: string, body: string): string {
  const safe = escapeHtml(body).replace(/\r?\n/g, '<br>');
  const block =
    '<div style="margin-top:16px;padding:12px 16px;border-left:3px solid #d1d5db;'
    + 'color:#374151;font-size:14px;line-height:1.5;white-space:normal;">'
    + `${safe}</div>`;
  // Splice the block INSIDE the rendered document, immediately before the closing
  // </body>, so the reply text sits within the email body. Concatenating after
  // </html> would place it outside the document, where some mail clients strip or
  // hide trailing content. Fall back to a plain append only if no </body> exists.
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return `${html}${block}`;
  return `${html.slice(0, idx)}${block}${html.slice(idx)}`;
}

/**
 * One-time autoresponse acknowledgement (spec §5). The autoresponder gate
 * (inboundEmail/autoresponder.ts) already applied loop-prevention before
 * emitting; here we just compose + send. Custom html comes from
 * settings.emailTemplates.ticket_autoresponse when set; otherwise inbound
 * autoresponseSubject/Body (plain text); otherwise the hardcoded ack. Loop
 * hygiene: stamp Auto-Submitted: auto-replied and set the ticket thread anchor
 * as Message-ID so the requester's reply threads. Reply-To is the partner
 * inbound address (self-hosted override honored).
 */
async function collectAutoresponse(
  event: Extract<TicketEvent, { type: 'ticket.autoresponse' }>
): Promise<EmailPayload[]> {
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }
  const partner = await loadPartnerMailBits(ticket.partnerId);
  const orgName = ticket.orgId ? await getOrgName(ticket.orgId) : '';

  const tpl = renderPartnerEmail({
    id: 'ticket_autoresponse',
    custom: asPartnerEmailCustom(partner.emailTemplates?.ticket_autoresponse),
    inboundAutoresponseFallback: {
      subject: partner.inbound?.autoresponseSubject ?? null,
      body: partner.inbound?.autoresponseBody ?? null,
    },
    vars: {
      ticket_number: ticket.internalNumber ?? '',
      ticket_subject: ticket.subject ?? event.payload.subject,
      requester_name: ticket.submitterName ?? '',
      requester_email: event.payload.to,
      org_name: orgName,
      partner_name: partner.name,
    },
    brandName: partner.name,
    internalNumber: event.payload.internalNumber,
    ticketSubject: event.payload.subject,
  });

  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
  const anchor = ticketThreadAnchor(ticket.id);
  if (anchor) headers['Message-ID'] = anchor;

  // Customer-facing: route the autoresponse through the partner's M365 mailbox when
  // connected (Graph manages threading; the SMTP Auto-Submitted/Message-ID headers
  // are only used on the EmailService fallback path).
  const graphMailbox = (await resolveOutboundMailbox(ticket.id, ticket.partnerId)) ?? undefined;

  return [{
    to: event.payload.to,
    subject: tpl.subject,
    html: tpl.html,
    replyTo: partner.replyTo,
    headers,
    bestEffort: true,
    graphMailbox,
    purpose: 'ticket.customer_notification',
    partnerId: ticket.partnerId ?? null,
    partnerName: partner.name.trim() || null,
  }];
}

async function collectSlaBreachNotification(
  event: Extract<TicketEvent, { type: 'ticket.sla_breached' }>
): Promise<Collected> {
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }
  if (ticket.deletedAt) return { emails: [], pushes: [] };
  const partnerId = await resolveCurrentTicketPartner(ticket, event.partnerId);
  if (!partnerId) return { emails: [], pushes: [] };

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;
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
      orgName: orgName ?? (orgName = await getOrgName(ticket.orgId)),
    });

  /** Once a recipient passes live eligibility, channel preference governs the phone only. */
  const notify = async (userId: string, opts: { push: boolean }): Promise<boolean> => {
    if (notified.has(userId)) return false;
    notified.add(userId);
    const id = await createNotification({
      userId,
      orgId: ticket.orgId,
      type: 'ticket',
      priority: 'normal',
      title: `SLA breached: ${label}`,
      message: `${target} SLA breached for ${ticket.subject}`,
      link: `/tickets#${event.payload.internalNumber ?? event.ticketId}`,
      dedupeKey: `ticket:${ticket.id}:sla:${target}:${userId}`,
    });
    if (id === null) return false; // replay — nothing further, INCLUDING the email
    if (opts.push) pushes.push({ userId, spec: await spec() });
    return true;
  };

  // Owner: live eligibility governs every channel. After that, slaScope still
  // controls only the phone — 'off' keeps the authorized inbox row and email.
  const assigneeId = event.payload.assigneeId;
  if (assigneeId) {
    const assignee = await loadUserCandidate(assigneeId);
    // Same split as the assigned branch: assertSamePartner reports a forged
    // recipient, isEligibleTicketRecipient decides.
    const partnerOk = assignee && assertSamePartner(assignee, partnerId, { ticketId: ticket.id });
    const currentOwner = ticket.assignedTo === undefined || ticket.assignedTo === assigneeId;
    const eligible = assignee && partnerOk && currentOwner &&
      await isEligibleTicketRecipient(assignee, partnerId, ticket.orgId, ticket.deviceId);
    if (assignee && eligible) {
      const prefs = await loadTicketPushPrefs(assigneeId);
      // Short-circuit deliberately: skip the permission round-trip when the
      // preference (or a non-active account) already rules the push out.
      const pushOwner = prefs.slaScope !== 'off';
      // The email is queued only AFTER the dedupe anchor confirms this is not a
      // replay. Queuing it first (as this branch originally did) meant a
      // redelivered BullMQ job re-emailed the owner while the row and the push
      // both deduped — breaking the wave's "a retry re-emails nobody" contract
      // that the assigned branch already honours.
      const wrote = await notify(assigneeId, { push: pushOwner });
      if (wrote && assignee.email) {
        emails.push({
          to: assignee.email,
          subject: `SLA breached: ${label} — ${ticket.subject}`,
          html: `<p>The ${escapeHtml(target)} SLA breached for ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(ticket.subject)}</p>`,
          bestEffort: true,
          purpose: 'ticket.staff_notification',
        });
      }
    }
  }

  // 'any' subscribers (D5): partner-filtered in SQL, re-authorised per user.
  // Push only — no email.
  //
  // Every subscriber is re-authorized against the current ticket before a row.
  if (partnerId) {
    const { users: subs } = await listAnySlaSubscribers(partnerId);
    for (const sub of subs) {
      if (notified.has(sub.userId)) continue;
      if (!assertSamePartner(sub, partnerId, { ticketId: ticket.id })) continue;
      if (!(await isEligibleTicketRecipient(sub, partnerId, ticket.orgId, ticket.deviceId))) continue;
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
        // emits a public ticket.commented event. The DEFAULT notification is
        // template-only (no comment content). The one path that loads ticket_comments
        // is the explicit per-partner fullMessageReply opt-in (see collectRequesterEmail),
        // gated on isPublic + not-deleted + non-graph and HTML-escaped; every other
        // outbound body/subject stays content-free (see ticketNotifyWorker.leak.test.ts).
        // Skip requester email for inbound comments — the comment originated FROM the
        // requester's email, so echoing it back would create a mail loop.
        if (event.payload.isPublic && !event.payload.inbound) {
          emailPayloads = await collectRequesterEmail(event, event.payload.commentId);
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
            undefined,
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
            },
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
      // Branch rather than spread: `purpose` is the discriminant of
      // SendEmailParams, so a union-typed value would not narrow.
      if (payload.purpose === 'ticket.customer_notification') {
        await email.sendEmail({
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          replyTo: payload.replyTo,
          headers: payload.headers,
          purpose: 'ticket.customer_notification',
          partnerId: payload.partnerId,
          partnerName: payload.partnerName,
        });
        return;
      }
      await email.sendEmail({
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        replyTo: payload.replyTo,
        headers: payload.headers,
        purpose: 'ticket.staff_notification'
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
  attachWorkerObservability(worker, 'ticketNotifyWorker');

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
