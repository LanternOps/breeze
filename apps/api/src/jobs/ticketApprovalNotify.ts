/**
 * Customer work approval notifications (#4617 spec §6.4, W04 T3). Called by
 * ticketNotifyWorker's `ticket.approval_requested` / `ticket.approval_decided`
 * arms, inside the worker's system DB context; returns customer mail for the
 * worker to send after that context closes (#1105).
 *
 * COMMITTED-STATE CONTRACT. Some emitters queue these events while their
 * transaction is still open (the time-entry writers, the staff approval
 * routes); the portal decide route queues strictly after commit. So every
 * event is re-validated against the committed request row:
 * - requested: row missing, or row revision < event revision → THROW (not yet
 *   visible; BullMQ retries). Row revision > event revision → drop (a newer
 *   event owns it). Not pending any more → drop.
 * - decided: row missing → drop (erased with its ticket). Row still pending →
 *   THROW (uncommitted, or the decision rolled back — either way nothing is
 *   sent). Row status ≠ event status → drop.
 *
 * CUSTOMER EMAIL CONTENT is the approval summary only: ticket number and
 * subject, the ask, the snapshot figures, the deadline and a link to the
 * authenticated portal Approvals page (`/approvals#<request id>`; the id is
 * not a credential). Never ticket comments, the description, time-entry
 * detail, staff names, or the staff message (that is shown in the portal).
 * One message per recipient; nobody sees another recipient's address.
 *
 * THROTTLE. Approver/notify emails for a request are claimed with Redis
 * `SET NX EX` per request id for APPROVAL_NOTIFY_COOLDOWN_SECONDS, so a burst
 * of held entries (each bumps the revision) sends one email. A staff re-ask
 * creates a NEW request id, so it is never throttled by the old one; a re-ask
 * that joins an already-pending request is a revision bump and is throttled.
 * Redis unavailable → fail open (send). In-app staff rows are never throttled;
 * they dedupe per request through `user_notifications.dedupe_key`.
 *
 * PORTAL TICKETING OFF (`portal_branding.enable_tickets = false`): the
 * Approvals page 403-bounces, so no request email (and no portal link) is
 * sent; staff get an in-app notice to record the decision on the customer's
 * behalf. A missing branding row is fail-open, like the portal gate (#2345).
 */
import { and, eq } from 'drizzle-orm';
import { formatMoney, type EmailTemplateId } from '@breeze/shared';
import { db } from '../db';
import { organizations, partners, portalBranding, ticketApprovalRequests, tickets, type TicketApprovalRequest } from '../db/schema';
import { partnerEmailCustomFromSettings, renderPartnerEmail } from '../services/emailTemplates/renderPartnerEmail';
import { portalBase } from '../services/portalUrl';
import { resolveOrgTimezone } from '../services/portal/timezone';
import { getRedis } from '../services/redis';
import { assertSamePartner, isEligibleTicketRecipient, loadUserCandidate } from '../services/ticketPush';
import { createNotification } from '../services/userNotifications';
import type { TicketEvent } from '../services/ticketEvents';

export const APPROVAL_NOTIFY_COOLDOWN_SECONDS = 15 * 60;
/** A decision confirmation is sent once per request and status; the key outlives any retry. */
export const APPROVAL_DECIDED_DEDUPE_SECONDS = 7 * 24 * 3600;

const FORMAT_LOCALE = 'en-US';

type RequestedEvent = Extract<TicketEvent, { type: 'ticket.approval_requested' }>;
type DecidedEvent = Extract<TicketEvent, { type: 'ticket.approval_decided' }>;

export interface ApprovalMail {
  to: string;
  subject: string;
  html: string;
  partnerId: string | null;
  partnerName: string | null;
}

export interface ApprovalCollected {
  emails: ApprovalMail[];
  /** Claimed in Redis right before sending; a failed claim drops `emails`. */
  throttle: { key: string; ttlSeconds: number } | null;
}

const NONE: ApprovalCollected = { emails: [], throttle: null };

// ── Text ────────────────────────────────────────────────────────────────

export function formatApprovalMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} h ${m} m`;
  if (h) return `${h} h`;
  return `${m} m`;
}

type AskFields = Pick<TicketApprovalRequest,
  'trigger' | 'requestedExtensionMinutes' | 'requestedExtensionAmount' | 'currencyCode' | 'coverageStartsAt' | 'coverageEndsAt'>;

function formatWhen(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(FORMAT_LOCALE, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** "Up to 2 h 30 m ($375.00) more", or the after-hours window in words. */
export function approvalAskText(req: AskFields, timeZone = 'UTC'): string {
  if (req.trigger === 'after_hours') {
    if (req.coverageStartsAt && req.coverageEndsAt) {
      return `After-hours work from ${formatWhen(req.coverageStartsAt, timeZone)} to ${formatWhen(req.coverageEndsAt, timeZone)}`;
    }
    return 'After-hours work on this ticket';
  }
  const minutes = req.requestedExtensionMinutes ? formatApprovalMinutes(req.requestedExtensionMinutes) : null;
  const amount = req.requestedExtensionAmount && req.currencyCode && Number(req.requestedExtensionAmount) > 0
    ? formatMoney(req.requestedExtensionAmount, req.currencyCode, FORMAT_LOCALE) : null;
  if (minutes && amount) return `Up to ${minutes} (${amount}) more`;
  if (minutes || amount) return `Up to ${minutes ?? amount} more`;
  return 'Additional work on this ticket';
}

type SnapshotFields = Pick<TicketApprovalRequest,
  'budgetMinutesAtRequest' | 'consumedMinutesAtRequest' | 'budgetAmountAtRequest' | 'consumedAmountAtRequest' | 'currencyCode'>;

/** "Budget 10 h, used 9 h 45 m; Budget $1,500.00, used $1,462.50" — only axes the ticket budgets. */
export function approvalSnapshotText(req: SnapshotFields): string {
  const parts: string[] = [];
  if (req.budgetMinutesAtRequest != null) {
    parts.push(`Budget ${formatApprovalMinutes(req.budgetMinutesAtRequest)}, used ${formatApprovalMinutes(req.consumedMinutesAtRequest ?? 0)}`);
  }
  if (req.budgetAmountAtRequest != null && req.currencyCode) {
    parts.push(`Budget ${formatMoney(req.budgetAmountAtRequest, req.currencyCode, FORMAT_LOCALE)}, used ${formatMoney(req.consumedAmountAtRequest ?? '0', req.currencyCode, FORMAT_LOCALE)}`);
  }
  return parts.join('; ');
}

// ── Loading ─────────────────────────────────────────────────────────────

interface LoadedContext {
  req: TicketApprovalRequest;
  ticket: { id: string; orgId: string; internalNumber: string | null; ticketNumber: string | null; subject: string; assignedTo: string | null; deviceId: string | null; partnerId: string };
  label: string;
  orgName: string;
}

async function loadRequest(requestId: string): Promise<TicketApprovalRequest | null> {
  const [req] = await db.select().from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, requestId)).limit(1);
  return req ?? null;
}

/** The request's live ticket and its partner, or null when the ticket is gone. */
async function loadTicketContext(req: TicketApprovalRequest): Promise<LoadedContext | null> {
  const [t] = await db.select({
    id: tickets.id, orgId: tickets.orgId, partnerId: tickets.partnerId, internalNumber: tickets.internalNumber,
    ticketNumber: tickets.ticketNumber, subject: tickets.subject, assignedTo: tickets.assignedTo,
    deviceId: tickets.deviceId, deletedAt: tickets.deletedAt,
  }).from(tickets).where(and(eq(tickets.id, req.ticketId), eq(tickets.orgId, req.orgId))).limit(1);
  if (!t || t.deletedAt) return null;
  const [org] = await db.select({ name: organizations.name, partnerId: organizations.partnerId })
    .from(organizations).where(eq(organizations.id, req.orgId)).limit(1);
  const partnerId = t.partnerId ?? org?.partnerId ?? null;
  if (!partnerId) return null;
  return {
    req,
    ticket: { ...t, partnerId },
    label: t.internalNumber ?? t.ticketNumber ?? t.id,
    orgName: org?.name ?? '',
  };
}

async function portalTicketingEnabled(orgId: string): Promise<boolean> {
  const [row] = await db.select({ enableTickets: portalBranding.enableTickets })
    .from(portalBranding).where(eq(portalBranding.orgId, orgId)).limit(1);
  return row?.enableTickets !== false;
}

async function loadPartner(partnerId: string): Promise<{ name: string; settings: unknown }> {
  const [p] = await db.select({ name: partners.name, settings: partners.settings })
    .from(partners).where(eq(partners.id, partnerId)).limit(1);
  return { name: p?.name ?? '', settings: p?.settings ?? null };
}

// ── Staff in-app ────────────────────────────────────────────────────────

/** Ticket assignee and the requesting staff user, each re-authorised for this ticket, minus `exclude`. */
async function notifyStaff(ctx: LoadedContext, n: { kind: string; title: string; message: string; exclude?: string | null }): Promise<void> {
  const ids = [...new Set([ctx.ticket.assignedTo, ctx.req.requestedByUserId].filter((v): v is string => !!v))]
    .filter((id) => id !== n.exclude);
  for (const userId of ids) {
    const candidate = await loadUserCandidate(userId);
    if (!candidate || !assertSamePartner(candidate, ctx.ticket.partnerId, { ticketId: ctx.ticket.id })) continue;
    if (!(await isEligibleTicketRecipient(candidate, ctx.ticket.partnerId, ctx.ticket.orgId, ctx.ticket.deviceId))) continue;
    await createNotification({
      userId,
      orgId: ctx.ticket.orgId,
      type: 'ticket',
      priority: 'normal',
      title: n.title,
      message: n.message,
      link: `/tickets#${ctx.ticket.internalNumber ?? ctx.ticket.id}`,
      dedupeKey: `ticket-approval:${ctx.req.id}:${n.kind}:${userId}`,
    });
  }
}

// ── Customer mail ───────────────────────────────────────────────────────

function approvalsLink(requestId: string): string | undefined {
  try {
    return `${portalBase()}/approvals#${requestId}`;
  } catch (err) {
    // portalBase throws rather than emit a dead link; send without the button.
    console.error('[TicketApprovalNotify] portal URL unavailable; sending without a link', err instanceof Error ? err.message : err);
    return undefined;
  }
}

function composeMail(
  id: EmailTemplateId, ctx: LoadedContext, partner: { name: string; settings: unknown },
  extraVars: Record<string, string>, ctaUrl?: string,
): Omit<ApprovalMail, 'to'> {
  const rendered = renderPartnerEmail({
    id,
    custom: partnerEmailCustomFromSettings(partner.settings, id),
    vars: {
      ticket_number: ctx.label,
      ticket_subject: ctx.ticket.subject,
      org_name: ctx.orgName,
      partner_name: partner.name,
      portal_url: ctaUrl ?? '',
      ...extraVars,
    },
    ctaUrl,
    brandName: partner.name,
    internalNumber: ctx.label,
    ticketSubject: ctx.ticket.subject,
  });
  return { subject: rendered.subject, html: rendered.html, partnerId: ctx.ticket.partnerId, partnerName: partner.name.trim() || null };
}

const mailTo = (to: string[], m: Omit<ApprovalMail, 'to'>): ApprovalMail[] => to.map((address) => ({ ...m, to: address }));

// ── Arms ────────────────────────────────────────────────────────────────

export async function collectApprovalRequested(event: RequestedEvent): Promise<ApprovalCollected> {
  const req = await loadRequest(event.payload.requestId);
  if (!req || req.revision < event.payload.revision) {
    throw new Error(`Approval request not visible at revision ${event.payload.revision} (likely uncommitted): ${event.payload.requestId}`);
  }
  if (req.revision > event.payload.revision || req.status !== 'pending') return NONE;
  const ctx = await loadTicketContext(req);
  if (!ctx) return NONE;

  if (!(await portalTicketingEnabled(req.orgId))) {
    await notifyStaff(ctx, {
      kind: 'portal-off',
      title: `Portal approvals are off: ${ctx.label}`,
      message: 'Customer portal ticketing is off for this organization, so no approval email was sent. '
        + "Contact the customer and record the decision on the customer's behalf.",
    });
    return NONE;
  }
  if (req.approverEmails.length === 0) {
    await notifyStaff(ctx, {
      kind: 'no-approver',
      title: `No approver on file: ${ctx.label}`,
      message: "Add a billing contact for this customer, or record the decision on the customer's behalf.",
    });
  }

  const partner = await loadPartner(ctx.ticket.partnerId);
  const timeZone = await resolveOrgTimezone(req.orgId);
  const link = approvalsLink(req.id);
  const summary = { approval_ask: approvalAskText(req, timeZone), approval_snapshot: approvalSnapshotText(req) };
  const emails = [
    ...mailTo(req.approverEmails, composeMail('ticket_approval_requested_approver', ctx, partner,
      { ...summary, approval_expires: formatWhen(req.expiresAt, timeZone) }, link)),
    ...mailTo(req.notifyEmails.filter((e) => !req.approverEmails.includes(e)),
      composeMail('ticket_approval_requested_notify', ctx, partner, summary, link)),
  ];
  return { emails, throttle: { key: `ticket-approval-notify:${req.id}`, ttlSeconds: APPROVAL_NOTIFY_COOLDOWN_SECONDS } };
}

const DECIDED_TITLE: Record<DecidedEvent['payload']['status'], string> = {
  approved: 'Customer approved more work',
  denied: 'Customer denied more work',
  expired: 'Customer approval expired',
  cancelled: 'Customer approval withdrawn',
};

export async function collectApprovalDecided(event: DecidedEvent): Promise<ApprovalCollected> {
  const req = await loadRequest(event.payload.requestId);
  if (!req) return NONE;
  if (req.status === 'pending') {
    throw new Error(`Approval decision not visible (likely uncommitted or rolled back): ${event.payload.requestId}`);
  }
  if (req.status !== event.payload.status) return NONE;
  const ctx = await loadTicketContext(req);
  if (!ctx) return NONE;

  const status = event.payload.status;
  await notifyStaff(ctx, {
    kind: `decided:${status}`,
    title: `${DECIDED_TITLE[status]}: ${ctx.label}`,
    message: ctx.ticket.subject,
    exclude: event.actorUserId,
  });

  // Only a customer-visible decision is confirmed to the customer; an expiry
  // or a staff withdrawal leaves the portal page as the record.
  if (status !== 'approved' && status !== 'denied') return NONE;
  const partner = await loadPartner(ctx.ticket.partnerId);
  const timeZone = await resolveOrgTimezone(req.orgId);
  const recipients = [...new Set([...req.approverEmails, ...req.notifyEmails])];
  const mail = composeMail('ticket_approval_decided', ctx, partner, {
    approval_ask: approvalAskText(req, timeZone), approval_snapshot: approvalSnapshotText(req), approval_status: status,
  });
  return {
    emails: mailTo(recipients, mail),
    throttle: { key: `ticket-approval-notify:${req.id}:decided:${status}`, ttlSeconds: APPROVAL_DECIDED_DEDUPE_SECONDS },
  };
}

/** Claim the throttle key. Run OUTSIDE any DB context. Fails open when Redis is unavailable. */
export async function admitApprovalMail(throttle: { key: string; ttlSeconds: number }, eventId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.warn('[TicketApprovalNotify] Redis unavailable; sending without the re-notification throttle');
    return true;
  }
  try {
    return (await redis.set(throttle.key, eventId, 'EX', throttle.ttlSeconds, 'NX')) === 'OK';
  } catch (err) {
    console.warn('[TicketApprovalNotify] throttle claim failed; sending', err instanceof Error ? err.message : err);
    return true;
  }
}
