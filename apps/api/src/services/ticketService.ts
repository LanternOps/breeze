import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { matchContactByEmail } from './contacts/crud';
import { tickets, ticketComments, ticketAlertLinks, organizations, alerts, devices, users, ticketCategories, portalUsers, contacts, ticketStatusEnum, ticketSourceEnum, ticketOutbox, ticketDrafts, actionIntents, aiAgentRuns, type TicketOutboxEvent } from '../db/schema';
import { allocateInternalTicketNumber } from './ticketNumbers';
import { emitTicketEvent } from './ticketEvents';
import { createAuditLogAsync } from './auditService';
import { resolveSlaTargets } from './ticketSla';
import { getOrgSlaOverride, getPartnerPrioritySla, getSystemStatusId, getTicketStatusById } from './ticketConfigService';
import { readOrgStampingDefaultsMany } from './orgCurrencyCore';
import { emitTicketTriageFeedback } from './mlFeedbackEmitters';
import { applyIntakeForm, getTicketFormForOrg, TicketFormError } from './ticketFormService';
import { assertTicketMoveCurrencyCompatible, type MoveCurrencyGuardDetails } from './ticketMoveCurrencyGuard';
import type { AddinTicketSummary } from '@breeze/shared';

export type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];
export type TicketSource = (typeof ticketSourceEnum.enumValues)[number];

// Lifecycle per spec §2 (docs/superpowers/specs/ticketing/2026-06-09-native-ticketing-design.md). Closed/resolved reopen only to 'open'; any active status can short-circuit to resolved/closed.
export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['open', 'pending', 'on_hold', 'resolved', 'closed'],
  open: ['pending', 'on_hold', 'resolved', 'closed'],
  pending: ['open', 'on_hold', 'resolved', 'closed'],
  on_hold: ['open', 'pending', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open']
};

export type TicketServiceErrorStatus = 400 | 403 | 404 | 409 | 500;

/**
 * Machine-readable error codes for callers that aggregate outcomes (e.g. the
 * bulk route's skippedReasons tally) instead of surfacing the message string.
 */
export type TicketServiceErrorCode =
  | 'ASSIGNEE_NOT_FOUND'
  | 'ASSIGNEE_WRONG_PARTNER'
  | 'REQUESTER_NOT_FOUND'
  | 'REQUESTER_WRONG_ORG'
  // #3258 W03: the requester CONTACT (the canonical person), distinct from the
  // portal LOGIN codes above so a caller can tell which of the two it fumbled.
  | 'REQUESTER_CONTACT_NOT_FOUND'
  | 'REQUESTER_CONTACT_WRONG_ORG'
  | 'CATEGORY_NOT_FOUND'
  | 'CATEGORY_WRONG_PARTNER'
  | 'TICKET_PARTNER_UNRESOLVABLE'
  | 'INVALID_TRANSITION'
  | 'CONCURRENT_MODIFICATION'
  | 'STATUS_NOT_FOUND'
  | 'STATUS_INACTIVE'
  | 'INVALID_INPUT'
  // W08 #3902: one or more attachmentIds were not pending, not this user's,
  // or not on this ticket. The comment transaction is rolled back.
  | 'ATTACHMENT_NOT_CLAIMABLE';

export class TicketServiceError extends Error {
  constructor(
    message: string,
    public status: TicketServiceErrorStatus = 400,
    public code?: TicketServiceErrorCode
  ) {
    super(message);
    this.name = 'TicketServiceError';
  }
}

export interface TicketActor {
  userId: string;
  name?: string;
  email?: string;
  triageFeedbackSource?: 'manual' | 'suggestion';
  triageFeedbackMetadata?: Record<string, unknown>;
  /**
   * P2-4 (#4191): who is actually behind this write, for `tickets.field_provenance`
   * stamping in `updateTicketFields`. Defaults to 'user' — every existing caller
   * (human staff, attended chat auto-executing under the caller's own session)
   * is unaffected. An 'ai_agent'/'system' actor is never routed through
   * `updateTicketFields` today (the AI ticket-triage release path uses the
   * dedicated `applyAiFieldUpdates`, which is CAS-guarded and never overwrites
   * a 'user' stamp) — this field exists so `updateTicketFields` stamps
   * correctly if a future caller ever does pass a non-human actor here,
   * without that caller having to know the stamping mechanics.
   */
  principalKind?: 'user' | 'ai_agent' | 'system';
}

// Legacy display identifier (NOT NULL UNIQUE), retry loop dropped when creation
// moved into the service — internalNumber is canonical; a nanoid(10) collision
// surfaces as a unique-violation insert error.
function generateLegacyTicketNumber(): string {
  return nanoid(10).toUpperCase();
}

async function getTicketOrThrow(ticketId: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  const ticket = rows[0];
  if (!ticket) throw new TicketServiceError('Ticket not found', 404);
  return ticket;
}

/**
 * Transactional outbox write (#3828 wave-6-3 task 2 —
 * docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-3-ticket-shadow.md).
 * Deliberately a PLAIN `db.insert` through the ambient `db` handle — the same
 * one every other write in this file uses — so the row lands in whatever
 * transaction the caller is already inside (the request's `withDbAccessContext`
 * transaction). It must NEVER be wrapped in `runOutsideDbContext` /
 * `withSystemDbAccessContext` (that is what `createAuditLogAsync` does, and is
 * exactly why an audit row survives a request rollback while this one must
 * NOT): if the surrounding transaction later rolls back, this row must roll
 * back with it, or a published event could announce a ticket mutation that
 * never actually committed.
 *
 * `payload` is id-only by construction (never subject/description/content/
 * resolutionNote — see ticketOutbox.ts's export-policy note) — callers pass
 * only structured ids/enum labels, never ticket free-text.
 */
async function writeTicketOutbox(
  orgId: string,
  ticketId: string,
  eventType: TicketOutboxEvent,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await db.insert(ticketOutbox).values({ orgId, ticketId, eventType, payload });
}

/**
 * Resolve the partner a ticket belongs to. tickets.partner_id is stamped on
 * every create since Phase 1a but is nullable for legacy rows — fall back to
 * the org's partner for those. A null return means the ticket's partner is
 * unresolvable (broken legacy data or a missing org) — callers fail closed.
 */
async function resolveTicketPartnerId(ticket: { partnerId: string | null; orgId: string }): Promise<string | null> {
  if (ticket.partnerId) return ticket.partnerId;
  const rows = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, ticket.orgId))
    .limit(1);
  const partnerId = rows[0]?.partnerId ?? null;
  if (!partnerId) {
    console.error(`[tickets] partner unresolvable for ticket in org ${ticket.orgId} — legacy data or missing org row`);
  }
  return partnerId;
}

/**
 * Look up a prospective assignee for tenant validation. Runs in a system-scope
 * DB context: this is an existence/ownership read, not an access check — an
 * org-scoped request context has empty accessiblePartnerIds, which hides
 * partner-level staff (org_id IS NULL) under the users RLS policy and would
 * turn legitimate assignments into misleading 404s. The security decision is
 * the explicit partner comparison the caller makes against the ticket's
 * partner. (Same rationale as allocateInternalTicketNumber's system context.)
 *
 * Exported for the bulk route's request-level pre-validation.
 */
export async function getAssigneeForValidation(assigneeId: string): Promise<{ id: string; partnerId: string } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: users.id, partnerId: users.partnerId })
        .from(users)
        .where(eq(users.id, assigneeId))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

function throwIfPartnerUnresolvable(partnerId: string | null): asserts partnerId is string {
  if (!partnerId) {
    throw new TicketServiceError('Ticket partner could not be resolved', 500, 'TICKET_PARTNER_UNRESOLVABLE');
  }
}

/**
 * Tenant guard: an assignee must be a user of the same partner as the ticket.
 * users.partner_id is NOT NULL (every user belongs to exactly one MSP), so a
 * same-partner equality check is the complete cross-tenant boundary.
 */
async function assertAssigneeInPartner(assigneeId: string, partnerId: string | null) {
  const assignee = await getAssigneeForValidation(assigneeId);
  if (!assignee) throw new TicketServiceError('Assignee not found', 404, 'ASSIGNEE_NOT_FOUND');
  throwIfPartnerUnresolvable(partnerId);
  if (assignee.partnerId !== partnerId) {
    throw new TicketServiceError('Assignee must belong to the same partner as the ticket', 400, 'ASSIGNEE_WRONG_PARTNER');
  }
}

/**
 * Look up a prospective requester (portal user) for tenant validation. Runs in
 * a system-scope DB context for the same reason as getAssigneeForValidation:
 * portal_users is org-axis RLS, and the security boundary is the explicit
 * org comparison the caller makes — not the read. Exported for the route's
 * pre-validation if ever needed.
 */
export async function getPortalUserForValidation(
  portalUserId: string
): Promise<{ id: string; orgId: string; name: string | null; email: string; contactId: string | null } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        // contactId (#3258 W03): a portal login is a login ATTACHED to a
        // contact, and the ticket's canonical requester is that contact — so
        // every path that resolves a portal user for a ticket write also
        // carries the link it should stamp.
        .select({ id: portalUsers.id, orgId: portalUsers.orgId, name: portalUsers.name, email: portalUsers.email, contactId: portalUsers.contactId })
        .from(portalUsers)
        .where(eq(portalUsers.id, portalUserId))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

/**
 * List the selectable requesters (active portal users) for an org. Runs in a
 * system-scope DB context — the security boundary is the caller's canAccessOrg
 * check plus the explicit org filter here, mirroring the validation reads above.
 * Capped at 500; the picker is a convenience, not an exhaustive directory.
 */
export async function listRequestersForOrg(
  orgId: string
): Promise<Array<{ id: string; name: string | null; email: string }>> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: portalUsers.id, name: portalUsers.name, email: portalUsers.email })
        .from(portalUsers)
        .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.status, 'active')))
        .orderBy(asc(portalUsers.name))
        .limit(500)
    )
  );
}

const ADDIN_OPEN_STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'on_hold'];
const ADDIN_TICKET_LIST_LIMIT = 10;

// Wire shape shared with the Outlook add-in client (@breeze/shared
// types/officeAddin.ts) — updatedAt is serialized to an ISO string here so the
// service output IS the wire contract, not a Date-carrying near-miss of it.
export type { AddinTicketSummary } from '@breeze/shared';

export function toAddinTicketSummary(
  row: {
    id: string;
    internalNumber: string | null;
    subject: string;
    status: string;
    priority: string | null;
    updatedAt: Date;
    submitterEmail: string | null;
  },
  submitterEmail?: string | null
): AddinTicketSummary {
  const matchesSubmitter = Boolean(
    submitterEmail && row.submitterEmail && row.submitterEmail.toLowerCase() === submitterEmail.toLowerCase()
  );
  return { ...row, updatedAt: row.updatedAt.toISOString(), matchesSubmitter };
}

/**
 * Outlook add-in ticket lookup for the current email's org: an "open" list
 * (active statuses, most-recently-updated first) and a "recent" list (any
 * status, most-recently-created first), both hard-scoped by org AND partner.
 * matchesSubmitter is computed here (not filtered) so the add-in can highlight
 * the caller's own tickets — it is a service-level annotation, not a public
 * list filter.
 */
export async function listOrgTicketsForAddin(input: {
  orgId: string;
  partnerId: string;
  submitterEmail?: string | null;
}): Promise<{ openTickets: AddinTicketSummary[]; recentTickets: AddinTicketSummary[] }> {
  const selectCols = {
    id: tickets.id,
    internalNumber: tickets.internalNumber,
    subject: tickets.subject,
    status: tickets.status,
    priority: tickets.priority,
    updatedAt: tickets.updatedAt,
    submitterEmail: tickets.submitterEmail
  };

  const [openRows, recentRows] = await Promise.all([
    db
      .select(selectCols)
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, input.orgId),
          eq(tickets.partnerId, input.partnerId),
          inArray(tickets.status, ADDIN_OPEN_STATUSES),
          isNull(tickets.deletedAt)
        )
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(ADDIN_TICKET_LIST_LIMIT),
    db
      .select(selectCols)
      .from(tickets)
      .where(and(eq(tickets.orgId, input.orgId), eq(tickets.partnerId, input.partnerId), isNull(tickets.deletedAt)))
      .orderBy(desc(tickets.createdAt))
      .limit(ADDIN_TICKET_LIST_LIMIT)
  ]);

  return {
    openTickets: openRows.map((row) => toAddinTicketSummary(row, input.submitterEmail)),
    recentTickets: recentRows.map((row) => toAddinTicketSummary(row, input.submitterEmail))
  };
}

/**
 * Tenant guard: a requester (portal user) must belong to the ticket's org.
 * portal_users.org_id scopes every portal account to exactly one organization,
 * so a same-org equality check is the complete cross-tenant boundary.
 */
async function assertRequesterInOrg(portalUserId: string, orgId: string) {
  const portalUser = await getPortalUserForValidation(portalUserId);
  if (!portalUser) throw new TicketServiceError('Requester not found', 404, 'REQUESTER_NOT_FOUND');
  if (portalUser.orgId !== orgId) {
    throw new TicketServiceError('Requester must belong to the ticket organization', 400, 'REQUESTER_WRONG_ORG');
  }
  return portalUser;
}

/**
 * Tenant guard: a requester CONTACT must belong to the ticket's org (#3258 W03).
 *
 * Deliberately the same shape as assertRequesterInOrg above — a same-org
 * equality check on a system-context read, 404 for missing and 400 for the
 * wrong org. `contacts.org_id` scopes a contact to exactly one organization,
 * so the equality IS the complete cross-tenant boundary. The composite FK
 * `tickets_requester_contact_org_fk` makes a cross-org link unrepresentable at
 * the DB level too; this check exists so the caller gets a typed 400 instead
 * of a raw constraint violation.
 *
 * Deliberately reads on the CURRENT DB context, NOT through the
 * `runOutsideDbContext(withSystemDbAccessContext(...))` escape the portal-user
 * guard above uses. That escape opens a second pooled connection, which cannot
 * see rows written by the caller's still-open transaction — and the inbound
 * path creates the contact and the ticket in ONE transaction, so the escape
 * would fail every emailed ticket from a first-time sender with a spurious
 * "Requester contact not found". (It did: the integration suite caught it.)
 *
 * Reading in-context is also no weaker. `contacts` is org-axis RLS, so a
 * system context sees everything and a request context sees exactly the orgs
 * the caller can reach; an invisible row degrades to 404 rather than a wrong-org
 * 400, which is the stricter of the two. The explicit comparison below remains
 * the security boundary either way.
 */
async function assertRequesterContactInOrg(contactId: string, orgId: string) {
  const rows = await db
    .select({ id: contacts.id, orgId: contacts.orgId, name: contacts.name, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  const contact = rows[0];
  if (!contact) throw new TicketServiceError('Requester contact not found', 404, 'REQUESTER_CONTACT_NOT_FOUND');
  if (contact.orgId !== orgId) {
    throw new TicketServiceError('Requester contact must belong to the ticket organization', 400, 'REQUESTER_CONTACT_WRONG_ORG');
  }
  return contact;
}

/**
 * The CONTACT behind a portal LOGIN, and the login's org (#3258 W03).
 *
 * Reads on the CURRENT DB context for exactly the reason
 * `assertRequesterContactInOrg` above spells out, and which
 * `getPortalUserForValidation` violates: that helper wraps its read in
 * `runOutsideDbContext(withSystemDbAccessContext(...))`, which opens a SECOND
 * pooled connection. A second connection cannot see rows the caller's
 * still-open transaction has written — and the create paths that reach this
 * derivation (inbound email, the portal) write inside one transaction. Using
 * the escape here would make the derivation depend on commit timing.
 *
 * Reading in-context is not weaker: `portal_users` is org-axis RLS, so a
 * system context sees everything and a request context sees exactly the orgs
 * the caller can reach — an invisible row degrades to "no link", which is the
 * stricter outcome. The explicit org comparison at the call site remains the
 * security boundary either way.
 *
 * `contactId` needs no org of its own: `portal_users_contact_org_fk`
 * (contact_id, org_id) -> contacts (id, org_id) makes the contact's org
 * IDENTICAL to the `orgId` returned here (#3258 follow-up), so comparing that
 * one value against the ticket's org settles both.
 */
async function readPortalUserContactLink(
  portalUserId: string
): Promise<{ orgId: string; contactId: string | null } | null> {
  const rows = await db
    .select({ orgId: portalUsers.orgId, contactId: portalUsers.contactId })
    .from(portalUsers)
    .where(eq(portalUsers.id, portalUserId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Re-resolve a ticket's requester CONTACT from a free-text email address
 * (#3258 W03). Exactly one contact on that address in the ticket's org links;
 * zero, several (a shared mailbox) or an unusable address leave the ticket
 * unlinked — the same rule inbound email applies, through the same core
 * (`matchContactByEmail`).
 *
 * Deliberately takes NO advisory lock, unlike the inbound path. That lock
 * exists to stop two concurrent first-time senders from each CREATING a
 * contact for the same address; nothing is created here (a staff requester
 * edit is not an onboarding action, and silently minting a contact from a
 * typed-in address would be a surprise), so there is nothing to serialise.
 */
async function resolveRequesterContactByEmail(
  orgId: string,
  email: string | null | undefined
): Promise<string | null> {
  const match = await matchContactByEmail(db, orgId, email);
  return match.kind === 'contact' ? match.contactId : null;
}

/**
 * Tenant guard: a ticket's category must belong to the ticket's partner.
 * The read runs in a system-scope DB context for the same reason as
 * getAssigneeForValidation: ticket_categories is partner-axis RLS, invisible
 * to org-scoped request contexts — the explicit partner comparison below is
 * the security boundary, not the read.
 */
export async function assertCategoryInPartner(categoryId: string, partnerId: string | null) {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketCategories.id,
          partnerId: ticketCategories.partnerId,
          responseSlaMinutes: ticketCategories.responseSlaMinutes,
          resolutionSlaMinutes: ticketCategories.resolutionSlaMinutes
        })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, categoryId))
        .limit(1)
    )
  );
  const category = rows[0];
  if (!category) throw new TicketServiceError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  throwIfPartnerUnresolvable(partnerId);
  if (category.partnerId !== partnerId) {
    throw new TicketServiceError('Category must belong to the same partner as the ticket', 400, 'CATEGORY_WRONG_PARTNER');
  }
  return category;
}

interface BaseCreateTicketInput {
  orgId: string;
  /**
   * The canonical requester PERSON (#3258 W03). Independent of `submittedBy`,
   * which names the optional portal LOGIN: an inbound email has a contact and
   * no login at all, a portal submission has both, and a manual ticket may
   * have neither. When omitted and a portal user IS named, it is DERIVED from
   * that login's `contact_id` — so a ticket never silently loses the person.
   */
  requesterContactId?: string;
  subject?: string;
  description?: string;
  deviceId?: string;
  categoryId?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  dueDate?: Date;
  assigneeId?: string;
  formId?: string;
  formResponses?: Record<string, unknown>;
}

// portal source carries the requester; the worker emails submitterEmail on public replies/resolution.
// email source also carries the sender address so outbound replies/autoresponses (PR3) have a recipient.
// Other sources (manual/alert/api/ai) may OPTIONALLY name a requester: pick a
// portal user (submittedBy) and/or supply a free-text name/email. When none are
// given the requester defaults to the acting staff member's name (no email).
export type CreateTicketInput =
  | (BaseCreateTicketInput & { source: 'portal'; submittedBy: string; submitterEmail: string; submitterName?: string })
  | (BaseCreateTicketInput & { source: 'email'; submitterEmail: string; submitterName?: string; submittedBy?: string })
  | (BaseCreateTicketInput & { source: Exclude<TicketSource, 'portal' | 'email'>; submittedBy?: string; submitterEmail?: string; submitterName?: string });

// NOTE: emitTicketEvent and createAuditLogAsync below are called while the
// surrounding request transaction is still open. If the transaction later rolls
// back, a phantom event/audit row survives — this is an accepted codebase pattern
// (see auditService.ts). Ticket-event consumers MUST therefore treat
// ticket-not-found as retryable, not terminal.
export async function createTicket(input: CreateTicketInput, actor: TicketActor) {
  const orgRows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);
  const org = orgRows[0];
  if (!org) throw new TicketServiceError('Organization not found', 404);

  // Intake form (spec 2026-07-10): resolve + validate first so the composed
  // category feeds the existing assertCategoryInPartner guard below.
  let intake: ReturnType<typeof applyIntakeForm> | null = null;
  if (input.formId) {
    try {
      const form = await getTicketFormForOrg(
        input.formId,
        { id: org.id, partnerId: org.partnerId },
        { requirePortalVisible: input.source === 'portal' }
      );
      intake = applyIntakeForm(form, input.formResponses ?? {});
    } catch (err) {
      if (err instanceof TicketFormError) throw new TicketServiceError(err.message, err.status);
      throw err;
    }
  }

  const rawSubject = input.subject?.trim() || intake?.subjectFromForm;
  if (!rawSubject) throw new TicketServiceError('Subject is required', 400);
  // DB column is varchar(255) — a form's rendered title template can exceed it
  // (long field responses interpolated into the title); truncate before insert
  // rather than let the DB reject the create.
  const subject = rawSubject.slice(0, 255);

  // Cross-org guard: a deviceId must reference a device in the ticket's org.
  // Mirrors the same-org check in linkAlertToTicket. Validated before number
  // allocation so a rejected create doesn't burn a counter value.
  if (input.deviceId) {
    const deviceRows = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .limit(1);
    const device = deviceRows[0];
    if (!device) throw new TicketServiceError('Device not found', 404);
    if (device.orgId !== input.orgId) {
      throw new TicketServiceError('Device must belong to the same organization as the ticket', 400);
    }
  }

  if (input.assigneeId) {
    await assertAssigneeInPartner(input.assigneeId, org.partnerId);
  }

  const effectiveCategoryId = input.categoryId ?? intake?.categoryId ?? undefined;
  let category: Awaited<ReturnType<typeof assertCategoryInPartner>> | null = null;
  if (effectiveCategoryId) {
    category = await assertCategoryInPartner(effectiveCategoryId, org.partnerId);
  }

  // Resolve the requester before number allocation (a rejected requester must
  // not burn a counter value). Portal/email sources carry it via their required
  // fields. Other sources may name one: a picked portal user (validated same-org,
  // backfills name/email), a named CONTACT (`namedContact` below — the #3258 W03
  // requesterContactId input, tenant-validated first and used to backfill the
  // name/email snapshot when there is no login), and/or free text; otherwise the
  // acting staff member's name is stamped with NO email (preserves "no external
  // requester" semantics — the notify worker emails submitterEmail on every
  // public comment/resolution).
  const isPortalOrEmail = input.source === 'portal' || input.source === 'email';

  // #3258 W03: an explicitly named contact is tenant-validated FIRST, before
  // number allocation and any write, so a cross-org link is rejected without
  // burning a counter value (same ordering rationale as the device guard).
  const namedContact = input.requesterContactId
    ? await assertRequesterContactInOrg(input.requesterContactId, input.orgId)
    : null;

  let resolvedSubmittedBy: string | null;
  let resolvedSubmitterName: string | null;
  let resolvedSubmitterEmail: string | null;
  // Non-null only on the branch that already loaded it, so the contact
  // derivation below never issues a second read for the same row.
  let validatedPortalUser: Awaited<ReturnType<typeof assertRequesterInOrg>> | null = null;
  if (isPortalOrEmail) {
    resolvedSubmittedBy = input.submittedBy ?? null;
    resolvedSubmitterName = input.submitterName ?? null;
    resolvedSubmitterEmail = input.submitterEmail ?? null;
  } else if (input.submittedBy) {
    const portalUser = await assertRequesterInOrg(input.submittedBy, input.orgId);
    validatedPortalUser = portalUser;
    resolvedSubmittedBy = portalUser.id;
    resolvedSubmitterName = input.submitterName ?? portalUser.name ?? null;
    resolvedSubmitterEmail = input.submitterEmail ?? portalUser.email ?? null;
  } else if (input.submitterName || input.submitterEmail || namedContact) {
    // `namedContact` joins this branch so a contact-backed ticket with no free
    // text does NOT fall through to the acting staff member's name below — it
    // has a real requester, and the snapshot is backfilled from them.
    resolvedSubmittedBy = null;
    resolvedSubmitterName = input.submitterName ?? null;
    resolvedSubmitterEmail = input.submitterEmail ?? null;
  } else {
    resolvedSubmittedBy = null;
    resolvedSubmitterName = actor.name ?? null;
    resolvedSubmitterEmail = null;
  }

  // Derive the person from the login when the caller named no contact. A
  // portal login IS a contact's login, so this is the link the ticket should
  // have carried all along — it makes `requester_contact_id` the one column
  // every person-backed ticket has, whatever the source.
  let resolvedRequesterContactId: string | null = namedContact?.id ?? null;
  if (!resolvedRequesterContactId && resolvedSubmittedBy) {
    // `validatedPortalUser` was already read (and org-checked) by
    // assertRequesterInOrg on the staff branch; the portal/email branch trusts
    // its caller's submittedBy and has not read anything yet.
    const link = validatedPortalUser ?? (await readPortalUserContactLink(resolvedSubmittedBy));
    // A login from another org carries a contact from that other org —
    // `portal_users_contact_org_fk` makes login-org and contact-org provably
    // equal (#3258 follow-up), so this ONE comparison is the complete
    // cross-tenant boundary for the derived link, not an approximation of it.
    // Kept as an explicit guard rather than left to the database: without it
    // the write reaches `tickets_requester_contact_org_fk` and comes back as a
    // raw 23503 (a 500 carrying a Postgres message) instead of the typed 400
    // every other requester tenant guard returns. A MISSING login is not an
    // error — it simply yields no link, matching the pre-existing behaviour.
    if (link && link.orgId !== input.orgId) {
      throw new TicketServiceError(
        'Requester contact must belong to the ticket organization',
        400,
        'REQUESTER_CONTACT_WRONG_ORG'
      );
    }
    resolvedRequesterContactId = link?.contactId ?? null;
  }

  // Snapshot backfill from the contact, only when there is no portal login to
  // take it from (that branch already backfilled). The snapshot is what the
  // notify worker mails and what threadMatcher binds on, so it stays a
  // point-in-time copy — never re-read from the contact later.
  if (namedContact && !resolvedSubmittedBy) {
    resolvedSubmitterName = resolvedSubmitterName ?? namedContact.name ?? null;
    resolvedSubmitterEmail = resolvedSubmitterEmail ?? namedContact.email ?? null;
  }

  const priority = input.priority ?? intake?.defaultPriority ?? 'normal';
  const initialCoreStatus: TicketStatus = input.assigneeId ? 'open' : 'new';

  const [orgSla, partnerSla, statusId] = await Promise.all([
    getOrgSlaOverride(input.orgId, priority),
    getPartnerPrioritySla(org.partnerId, priority),
    getSystemStatusId(org.partnerId, initialCoreStatus),
  ]);

  const slaTargets = resolveSlaTargets({
    categoryResponseMinutes: category?.responseSlaMinutes ?? null,
    categoryResolutionMinutes: category?.resolutionSlaMinutes ?? null,
    orgResponseMinutes: orgSla.responseMinutes,
    orgResolutionMinutes: orgSla.resolutionMinutes,
    partnerResponseMinutes: partnerSla.responseMinutes,
    partnerResolutionMinutes: partnerSla.resolutionMinutes,
    priority
  });

  const internalNumber = await allocateInternalTicketNumber(org.partnerId);

  const insertValues = {
    orgId: input.orgId,
    partnerId: org.partnerId,
    ticketNumber: generateLegacyTicketNumber(),
    internalNumber,
    subject,
    description: [input.description?.trim(), intake?.descriptionBlock].filter(Boolean).join('\n\n') || null,
    deviceId: input.deviceId ?? null,
    categoryId: effectiveCategoryId ?? null,
    priority,
    dueDate: input.dueDate ?? null,
    assignedTo: input.assigneeId ?? null,
    status: initialCoreStatus,
    statusId: statusId ?? null,
    source: input.source,
    submittedBy: resolvedSubmittedBy,
    requesterContactId: resolvedRequesterContactId,
    submitterEmail: resolvedSubmitterEmail,
    submitterName: resolvedSubmitterName,
    category: null,
    responseSlaMinutes: slaTargets.responseMinutes,
    resolutionSlaMinutes: slaTargets.resolutionMinutes,
    tags: intake?.defaultTags.length ? intake.defaultTags : undefined,
    customFields: intake ? intake.intakeSnapshot : undefined
  } satisfies typeof tickets.$inferInsert;

  const inserted = await db
    .insert(tickets)
    .values(insertValues)
    .returning();
  const ticket = inserted[0];
  if (!ticket) throw new TicketServiceError('Failed to create ticket', 500);

  await emitTicketEvent({
    type: 'ticket.created',
    ticketId: ticket.id,
    orgId: input.orgId,
    partnerId: org.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { internalNumber, assigneeId: input.assigneeId ?? null, source: input.source }
  });
  await writeTicketOutbox(input.orgId, ticket.id, 'ticket.created');
  await createAuditLogAsync({
    orgId: input.orgId,
    actorId: actor.userId,
    action: 'ticket.create',
    resourceType: 'ticket',
    resourceId: ticket.id,
    resourceName: internalNumber,
    result: 'success'
  });
  return ticket;
}

export interface ChangeStatusOptions {
  resolutionNote?: string;
  pendingReason?: string;
  /**
   * P2-4 (#4191), Task A10 — an active `resolution_note`-kind `ticket_drafts`
   * row to apply as the resolution note (the web resolve modal's "use the AI
   * draft" prefill, PR B). Only valid alongside a resolve (`status:
   * 'resolved'`/a statusId resolving to `resolved`) — the schema-level
   * refinement in `changeTicketStatusSchema` also relaxes `resolutionNote`'s
   * required-ness whenever this is present, since the draft supplies the
   * text. Locked and consumed (`state: 'consumed'`) in the SAME per-request
   * transaction as the ticket's status CAS update below, via `SELECT ... FOR
   * UPDATE` (mirrors `sendTicketDraft`'s locking contract) — a draft that is
   * missing, the wrong kind, or no longer `active` fails the whole resolve
   * with a 404/409 rather than silently resolving without it.
   *
   * Review fix (#4191 final review, C1) — this draft is ALWAYS consumed when
   * supplied, but it does not always win: a non-empty `resolutionNote` on the
   * same call is the technician's (possibly edited) text and takes priority
   * over the draft's content. The draft is treated as a fallback/default,
   * never a silent override of caller-supplied text.
   */
  aiDraftId?: string;
}

export interface ChangeStatusTarget {
  status?: TicketStatus;
  statusId?: string;
}

/**
 * P2-4 (#4191) — shared by every `changeTicketStatus` branch that can apply
 * an `aiDraftId` (the full FSM transition AND the same-core-status paths
 * that skip FSM validation — a review fix: those used to return before ever
 * looking at `aiDraftId`, silently dropping it). Locks the draft row for
 * the rest of this transaction (`for('update')`) so a concurrent
 * send/discard/resolve racing the SAME draft blocks here until this
 * transaction commits or rolls back, then observes the now-committed state.
 */
async function lockAndValidateResolutionDraft(
  ticketId: string,
  draftId: string
): Promise<{ id: string; content: string }> {
  const [draft] = await db
    .select()
    .from(ticketDrafts)
    .where(and(eq(ticketDrafts.id, draftId), eq(ticketDrafts.ticketId, ticketId)))
    .limit(1)
    .for('update');
  if (!draft) throw new TicketServiceError('Draft not found', 404);
  if (draft.kind !== 'resolution_note') {
    throw new TicketServiceError('Only resolution-note drafts can be applied when resolving', 409);
  }
  if (draft.state !== 'active') {
    throw new TicketServiceError('Draft is no longer active', 409);
  }
  return { id: draft.id, content: draft.content };
}

/** Companion to `lockAndValidateResolutionDraft` — CAS `active -> consumed` in the
 *  SAME transaction as the caller's ticket update, so a failure here rolls back
 *  that update too (defense-in-depth: unreachable while the lock above holds). */
async function consumeResolutionDraft(draftId: string, consumedBy: string): Promise<void> {
  const consumed = await db
    .update(ticketDrafts)
    .set({ state: 'consumed', consumedBy, consumedAt: new Date() })
    .where(and(eq(ticketDrafts.id, draftId), eq(ticketDrafts.state, 'active')))
    .returning({ id: ticketDrafts.id });
  if (consumed.length === 0) {
    throw new TicketServiceError('Draft was already consumed', 409);
  }
}

export async function changeTicketStatus(
  ticketId: string,
  target: ChangeStatusTarget,
  opts: ChangeStatusOptions,
  actor: TicketActor
) {
  const ticket = await getTicketOrThrow(ticketId);
  const fromStatus = ticket.status as TicketStatus;

  // Validate target: exactly one of status/statusId must be set
  const hasStatus = target.status !== undefined;
  const hasStatusId = target.statusId !== undefined;
  if ((hasStatus && hasStatusId) || (!hasStatus && !hasStatusId)) {
    throw new TicketServiceError('Provide exactly one of status or statusId', 400, 'INVALID_INPUT');
  }

  let toStatus: TicketStatus;
  let resolvedStatusId: string | null | undefined;
  let customStatusName: string | undefined;

  const partnerId = await resolveTicketPartnerId(ticket);

  if (hasStatusId) {
    const row = await getTicketStatusById(target.statusId!);
    if (!row) throw new TicketServiceError('Status not found', 404, 'STATUS_NOT_FOUND');
    if (row.partnerId !== partnerId) throw new TicketServiceError('Status not found', 404, 'STATUS_NOT_FOUND');
    if (!row.isActive) throw new TicketServiceError('Status is inactive', 400, 'STATUS_INACTIVE');
    toStatus = row.coreStatus;
    resolvedStatusId = target.statusId;
    customStatusName = row.name;
  } else {
    toStatus = target.status!;
    resolvedStatusId = partnerId ? await getSystemStatusId(partnerId, toStatus) : null;
    customStatusName = undefined;
  }

  // Review fix (#4191): this must run BEFORE every early-return branch below
  // (no-op, same-status statusId relabel, AND the full FSM transition) — an
  // aiDraftId on a non-resolve target must always 400, never be silently
  // swallowed by a branch that returns before reaching a later check.
  if (opts.aiDraftId && toStatus !== 'resolved') {
    throw new TicketServiceError('aiDraftId is only accepted when resolving a ticket', 400, 'INVALID_INPUT');
  }

  // Review fix (#4191): the same-core-status branches below (no-op and the
  // statusId-only relabel) skip FSM validation entirely and used to return
  // BEFORE the full-transition path's aiDraftId handling ever ran — an
  // aiDraftId supplied while relabeling an ALREADY-resolved ticket (or
  // no-op-resolving it) was silently dropped: no error, no consumption, no
  // resolutionNote write. Lock + validate it HERE, unconditionally, whenever
  // the target core status is 'resolved' and the core status isn't changing.
  let sameStatusDraft: { id: string; content: string } | null = null;
  if (toStatus === fromStatus && toStatus === 'resolved' && opts.aiDraftId) {
    sameStatusDraft = await lockAndValidateResolutionDraft(ticketId, opts.aiDraftId);
  }

  // No-op: same core status AND same statusId AND nothing else to apply —
  // a draft still needing to be applied/consumed is real, explicit intent,
  // never a silent no-op.
  if (toStatus === fromStatus && resolvedStatusId === ticket.statusId && !sameStatusDraft) {
    return ticket;
  }

  // Same core status but a statusId change and/or a draft to apply — update
  // statusId/resolutionNote only (skip FSM validation; core status is
  // unchanged either way).
  if (toStatus === fromStatus) {
    const now = new Date();
    const patch: Partial<typeof tickets.$inferInsert> = { statusId: resolvedStatusId ?? null, updatedAt: now };
    // C1 (#4191 final review): a non-empty caller-supplied resolutionNote
    // (e.g. the technician edited the prefilled AI draft before submitting)
    // wins over the draft's content — the draft is still consumed below.
    const appliedResolutionNote = sameStatusDraft
      ? (opts.resolutionNote?.trim() ? opts.resolutionNote : sameStatusDraft.content)
      : undefined;
    if (sameStatusDraft) {
      patch.resolutionNote = appliedResolutionNote;
    }
    const updated = await db
      .update(tickets)
      .set(patch)
      .where(and(
        eq(tickets.id, ticketId),
        eq(tickets.status, fromStatus),
        ticket.statusId ? eq(tickets.statusId, ticket.statusId) : isNull(tickets.statusId)
      ))
      .returning();
    if (updated.length === 0) {
      throw new TicketServiceError('Ticket was modified concurrently', 409, 'CONCURRENT_MODIFICATION');
    }

    // Consume in the SAME transaction as the ticket update above — a failure
    // here rolls the whole thing back (mirrors the full-transition path).
    if (sameStatusDraft) {
      await consumeResolutionDraft(sameStatusDraft.id, actor.userId);
    }

    // Only write a feed entry when there is meaningful content — i.e. the
    // caller supplied a custom status name (statusId path) or an aiDraftId
    // was applied. A legacy {status} call that happens to resolve to the
    // same core value but swaps the statusId back to the system row (and
    // carries no draft) produces an empty content and identical
    // oldValue/newValue, which would be a no-op noise row in the feed.
    const feedContent = sameStatusDraft ? appliedResolutionNote : customStatusName;
    if (feedContent) {
      await db.insert(ticketComments).values({
        ticketId,
        userId: actor.userId,
        authorName: actor.name ?? null,
        authorType: 'internal',
        commentType: 'status_change',
        content: feedContent,
        isPublic: false,
        oldValue: fromStatus,
        newValue: toStatus
      });
    }
    // Do NOT emit ticket.status_changed — core status is unchanged; only the
    // custom-status label (statusId) and/or resolutionNote differ.  Emitting
    // with identical from/to would produce noise and confuse downstream
    // consumers.
    await createAuditLogAsync({
      orgId: ticket.orgId,
      actorId: actor.userId,
      action: 'ticket.status_change',
      resourceType: 'ticket',
      resourceId: ticketId,
      details: { from: fromStatus, to: toStatus },
      result: 'success'
    });
    return updated[0];
  }

  if (!TICKET_STATUS_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    throw new TicketServiceError(`Cannot transition ticket from ${fromStatus} to ${toStatus}`, 409, 'INVALID_TRANSITION');
  }
  if (toStatus === 'resolved' && !opts.resolutionNote && !opts.aiDraftId) {
    throw new TicketServiceError('A resolution note is required to resolve a ticket', 400);
  }

  // Lock + validate the `resolution_note` draft BEFORE the ticket's own CAS
  // update below: a missing/wrong-kind/inactive draft must fail the whole
  // resolve, not silently resolve without it.
  let resolutionNote = opts.resolutionNote;
  let draftToConsume: { id: string } | null = null;
  if (toStatus === 'resolved' && opts.aiDraftId) {
    const draft = await lockAndValidateResolutionDraft(ticketId, opts.aiDraftId);
    // C1 (#4191 final review): a non-empty caller-supplied resolutionNote
    // (e.g. the technician edited the prefilled AI draft before submitting)
    // wins over the draft's content — the draft is still consumed below.
    resolutionNote = opts.resolutionNote?.trim() ? opts.resolutionNote : draft.content;
    draftToConsume = { id: draft.id };
  }

  const now = new Date();
  const patch: Partial<typeof tickets.$inferInsert> = { status: toStatus, statusId: resolvedStatusId ?? null, updatedAt: now };

  if (toStatus === 'resolved') {
    patch.resolvedAt = ticket.resolvedAt ?? now;
    patch.resolutionNote = resolutionNote;
    patch.pendingReason = null;
  } else if (toStatus === 'closed') {
    patch.closedAt = now;
    patch.closedBy = actor.userId;
    patch.resolvedAt = ticket.resolvedAt ?? now;
    patch.pendingReason = null;
  } else if (toStatus === 'open' && (fromStatus === 'resolved' || fromStatus === 'closed')) {
    // Reopen: clear resolution/close stamps
    patch.resolvedAt = null;
    patch.closedAt = null;
    patch.closedBy = null;
    patch.pendingReason = null;
  } else if (toStatus === 'pending' || toStatus === 'on_hold') {
    patch.pendingReason = opts.pendingReason ?? null;
  } else {
    patch.pendingReason = null;
  }

  // SLA clock pause/resume (spec §3, decision D4): the clock pauses while the
  // ticket sits in pending/on_hold. Fold elapsed pause time on ANY exit —
  // including resolve/close — so reopen resumes from a consistent ledger.
  const wasPaused = fromStatus === 'pending' || fromStatus === 'on_hold';
  const willBePaused = toStatus === 'pending' || toStatus === 'on_hold';
  if (!wasPaused && willBePaused) {
    patch.slaPausedAt = now;
  } else if (wasPaused && !willBePaused) {
    if (ticket.slaPausedAt) {
      const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - new Date(ticket.slaPausedAt).getTime()) / 60_000));
      patch.slaPausedMinutes = (ticket.slaPausedMinutes ?? 0) + elapsedMinutes;
    }
    patch.slaPausedAt = null;
  }

  // Compare-and-swap: include fromStatus in the WHERE so a concurrent update is detected.
  const updated = await db
    .update(tickets)
    .set(patch)
    .where(and(eq(tickets.id, ticketId), eq(tickets.status, fromStatus)))
    .returning();

  if (updated.length === 0) {
    throw new TicketServiceError('Ticket was modified concurrently', 409, 'CONCURRENT_MODIFICATION');
  }

  // Consume the draft in the SAME transaction as the ticket's own CAS update
  // above — a failure here throws and rolls back the whole request
  // transaction, including the status change just written.
  if (draftToConsume) {
    await consumeResolutionDraft(draftToConsume.id, actor.userId);
  }

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'status_change',
    content: resolutionNote ?? opts.pendingReason ?? customStatusName ?? '',
    isPublic: false,
    oldValue: fromStatus,
    newValue: toStatus
  });

  await emitTicketEvent({
    type: 'ticket.status_changed',
    ticketId,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { from: fromStatus, to: toStatus }
  });
  await writeTicketOutbox(ticket.orgId, ticketId, 'ticket.status_changed', { from: fromStatus, to: toStatus });
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.status_change',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { from: fromStatus, to: toStatus },
    result: 'success'
  });
  return updated[0];
}

export interface UpdateTicketFieldsInput {
  subject?: string;
  description?: string;
  categoryId?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  dueDate?: Date | null;
  responseSlaMinutes?: number | null;
  resolutionSlaMinutes?: number | null;
  deviceId?: string | null;
  tags?: string[];
  // Requester edit. Handled outside UPDATE_FIELD_LABELS' generic diff loop:
  // picking a portal user (submittedBy) backfills name/email, and the three
  // columns surface as one "requester" change in the feed. submittedBy=null
  // clears the portal link (free-text requester).
  submittedBy?: string | null;
  submitterName?: string | null;
  submitterEmail?: string | null;
}

// Fields handled by the generic diff loop. The requester triple is excluded —
// it's resolved/diffed separately (portal-user backfill, single "requester" label).
type DiffFieldKey = Exclude<keyof UpdateTicketFieldsInput, 'submittedBy' | 'submitterName' | 'submitterEmail'>;

/** Humanized labels for the system feed entry, in canonical field order. */
const UPDATE_FIELD_LABELS: Record<DiffFieldKey, string> = {
  subject: 'subject',
  description: 'description',
  categoryId: 'category',
  priority: 'priority',
  dueDate: 'due date',
  responseSlaMinutes: 'response SLA',
  resolutionSlaMinutes: 'resolution SLA',
  deviceId: 'device',
  tags: 'tags'
};

function ticketFieldChanged(key: DiffFieldKey, oldValue: unknown, newValue: unknown): boolean {
  if (key === 'dueDate') {
    const oldMs = oldValue instanceof Date ? oldValue.getTime() : null;
    const newMs = newValue instanceof Date ? newValue.getTime() : null;
    return oldMs !== newMs;
  }
  if (key === 'tags') {
    return JSON.stringify(oldValue ?? []) !== JSON.stringify(newValue ?? []);
  }
  return (oldValue ?? null) !== (newValue ?? null);
}

function ticketTriageFeedbackMetadata(actor: TicketActor, extra: Record<string, unknown>): Record<string, unknown> {
  const acceptedSuggestion = actor.triageFeedbackSource === 'suggestion';
  return {
    source: acceptedSuggestion ? 'ticket_triage_v0' : 'manual_update',
    acceptedSuggestion,
    ...(acceptedSuggestion ? actor.triageFeedbackMetadata ?? {} : {}),
    ...extra,
  };
}

function ticketTriageDedupeKey(field: string, oldValue: unknown, newValue: unknown): string {
  return `${field}:${JSON.stringify(oldValue ?? null)}:${JSON.stringify(newValue ?? null)}`;
}

export async function updateTicketFields(
  ticketId: string,
  fields: UpdateTicketFieldsInput,
  actor: TicketActor
) {
  const ticket = await getTicketOrThrow(ticketId);

  // Cross-org guard: a deviceId reassignment must reference a device in the
  // ticket's org (mirrors the same-org device check in createTicket).
  // null clears the device and needs no lookup.
  if (typeof fields.deviceId === 'string') {
    const deviceRows = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, fields.deviceId))
      .limit(1);
    const device = deviceRows[0];
    if (!device) throw new TicketServiceError('Device not found', 404);
    if (device.orgId !== ticket.orgId) {
      throw new TicketServiceError('Device must belong to the same organization as the ticket', 400);
    }
  }

  if (typeof fields.categoryId === 'string') {
    // D2: category changes after create do not restamp SLA targets — return value deliberately discarded.
    await assertCategoryInPartner(fields.categoryId, await resolveTicketPartnerId(ticket));
  }

  // Requester edit: resolve (and tenant-validate) before the change diff so a
  // cross-org portal user is rejected even when nothing else changed. The client
  // sends a coherent triple — a uuid submittedBy links a portal user (same-org,
  // backfills name/email); null clears the link for a free-text requester.
  const requesterEdit =
    fields.submittedBy !== undefined ||
    fields.submitterName !== undefined ||
    fields.submitterEmail !== undefined;
  //
  // #3258 W03: `requester_contact_id` is kept COHERENT with that triple rather
  // than editable on its own — a requester edit either names a portal login
  // (re-derive the person from that login's contact_id) or replaces the
  // requester with free text (the ticket no longer points at a contact). A
  // stale link left behind would silently keep the old person's portal
  // ownership over the ticket (routes/portal/tickets.ts reads it).
  const requesterPatch: {
    submittedBy?: string | null;
    submitterName?: string | null;
    submitterEmail?: string | null;
    requesterContactId?: string | null;
  } = {};
  const tRow = ticket as Record<string, unknown>;
  if (requesterEdit) {
    if (typeof fields.submittedBy === 'string') {
      const portalUser = await assertRequesterInOrg(fields.submittedBy, ticket.orgId);
      requesterPatch.submittedBy = portalUser.id;
      requesterPatch.requesterContactId = portalUser.contactId ?? null;
      requesterPatch.submitterName = fields.submitterName !== undefined ? fields.submitterName : (portalUser.name ?? null);
      requesterPatch.submitterEmail = fields.submitterEmail !== undefined ? fields.submitterEmail : (portalUser.email ?? null);
    } else {
      if (fields.submittedBy === null) requesterPatch.submittedBy = null;
      if (fields.submitterName !== undefined) requesterPatch.submitterName = fields.submitterName;
      if (fields.submitterEmail !== undefined) requesterPatch.submitterEmail = fields.submitterEmail;

      // The link is NOT cleared just because this branch was taken. The old
      // rule did exactly that, and it is how a customer's emailed ticket
      // disappeared from their portal: the web requester editor renders an
      // emailed ticket as "someone else" (there is no portal login to select)
      // and its Save posts this exact shape, so opening the editor and saving
      // it UNCHANGED silently unlinked the requester, with no way back through
      // the UI. `requester_contact_id` now moves only when something that
      // actually determines it moved.
      const hadLogin = (tRow.submittedBy ?? null) !== null;
      const losesLogin = hadLogin && fields.submittedBy === null;
      const emailChanged =
        fields.submitterEmail !== undefined &&
        (fields.submitterEmail ?? null) !== (tRow.submitterEmail ?? null);

      if (!hadLogin || losesLogin) {
        // No login owns the link after this patch, so the ADDRESS is the only
        // thing left that identifies the person.
        if (emailChanged) {
          requesterPatch.requesterContactId = await resolveRequesterContactByEmail(
            ticket.orgId,
            fields.submitterEmail
          );
        } else if (losesLogin) {
          // The link was DERIVED from the login being removed and nothing
          // replaces it.
          requesterPatch.requesterContactId = null;
        }
        // else: nothing that determines the link changed — leave it absent
        // from the patch entirely, so a concurrent re-link is not clobbered.
      }
      // A ticket that KEEPS its portal login keeps the link derived from it;
      // an address correction does not re-attribute a login-backed ticket.
    }
  }
  const requesterChanged =
    ('submittedBy' in requesterPatch && (requesterPatch.submittedBy ?? null) !== (tRow.submittedBy ?? null)) ||
    ('submitterName' in requesterPatch && (requesterPatch.submitterName ?? null) !== (tRow.submitterName ?? null)) ||
    ('submitterEmail' in requesterPatch && (requesterPatch.submitterEmail ?? null) !== (tRow.submitterEmail ?? null)) ||
    // A re-derivation that changes ONLY the contact link is still a change:
    // without this the coherence rule above would compute the right value and
    // then discard it as a no-op edit.
    ('requesterContactId' in requesterPatch && (requesterPatch.requesterContactId ?? null) !== (tRow.requesterContactId ?? null));

  // Compute the actually-changed fields; ignore no-op keys so the feed and
  // event stream don't accumulate noise from idempotent saves.
  const changed: DiffFieldKey[] = [];
  for (const key of Object.keys(UPDATE_FIELD_LABELS) as DiffFieldKey[]) {
    if (fields[key] === undefined) continue;
    if (ticketFieldChanged(key, (ticket as Record<string, unknown>)[key], fields[key])) {
      changed.push(key);
    }
  }
  if (changed.length === 0 && !requesterChanged) return ticket;

  // Feed/event labels: typed field keys plus a single "requester" token.
  const changedForLog: string[] = [...changed, ...(requesterChanged ? ['requester'] : [])];
  const changedLabels: string[] = [...changed.map((k) => UPDATE_FIELD_LABELS[k]), ...(requesterChanged ? ['requester'] : [])];

  const patch: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };
  for (const key of changed) {
    (patch as Record<string, unknown>)[key] = fields[key] ?? null;
  }
  if (requesterChanged) Object.assign(patch, requesterPatch);

  // P2-4 (#4191): stamp field_provenance, in the SAME transaction/statement
  // as the field write itself — the human-set-field authority the release-
  // time CAS in applyAiFieldUpdates relies on. A human write here (the only
  // caller today; principalKind defaults 'user') ALWAYS overwrites whatever
  // was there before, including an 'ai_agent' stamp — humans always win, no
  // CAS needed on this path (unlike applyAiFieldUpdates, which is the one
  // that must never overwrite a 'user' stamp).
  if (changed.length > 0) {
    const provenanceStamp = Object.fromEntries(
      changed.map((field) => [field, actor.principalKind ?? 'user']),
    );
    (patch as Record<string, unknown>).fieldProvenance =
      sql`${tickets.fieldProvenance} || ${JSON.stringify(provenanceStamp)}::jsonb`;
  }

  const updated = await db
    .update(tickets)
    .set(patch)
    .where(eq(tickets.id, ticketId))
    .returning();
  if (updated.length === 0) {
    throw new TicketServiceError('Ticket not found', 404);
  }

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'system',
    content: `Updated ${changedLabels.join(', ')}`,
    isPublic: false
  });

  await emitTicketEvent({
    type: 'ticket.updated',
    ticketId,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { changed: changedForLog }
  });
  await writeTicketOutbox(ticket.orgId, ticketId, 'ticket.updated');
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.update',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { changed: changedForLog },
    result: 'success'
  });
  if (changed.includes('categoryId')) {
    await emitTicketTriageFeedback({
      orgId: ticket.orgId,
      ticketId,
      eventType: 'ticket.category_changed',
      dedupeKey: ticketTriageDedupeKey('categoryId', ticket.categoryId ?? null, updated[0]?.categoryId ?? null),
      outcome: 'category_changed',
      actorUserId: actor.userId,
      metadata: ticketTriageFeedbackMetadata(actor, {
        oldValue: ticket.categoryId ?? null,
        newValue: updated[0]?.categoryId ?? null,
      }),
    });
  }
  if (changed.includes('priority')) {
    await emitTicketTriageFeedback({
      orgId: ticket.orgId,
      ticketId,
      eventType: 'ticket.priority_changed',
      dedupeKey: ticketTriageDedupeKey('priority', ticket.priority, updated[0]?.priority ?? null),
      outcome: 'priority_changed',
      actorUserId: actor.userId,
      metadata: ticketTriageFeedbackMetadata(actor, {
        oldValue: ticket.priority,
        newValue: updated[0]?.priority ?? null,
      }),
    });
  }
  return updated[0];
}

export async function assignTicket(ticketId: string, assigneeId: string | null, actor: TicketActor) {
  const ticket = await getTicketOrThrow(ticketId);
  const prevAssignedTo = ticket.assignedTo;

  if (assigneeId) {
    await assertAssigneeInPartner(assigneeId, await resolveTicketPartnerId(ticket));
  }

  const patch: Partial<typeof tickets.$inferInsert> = { assignedTo: assigneeId, updatedAt: new Date() };
  if (assigneeId && ticket.status === 'new') patch.status = 'open';

  // Compare-and-swap: include the previously-read assignedTo in the WHERE.
  const updated = await db
    .update(tickets)
    .set(patch)
    .where(and(
      eq(tickets.id, ticketId),
      prevAssignedTo === null ? isNull(tickets.assignedTo) : eq(tickets.assignedTo, prevAssignedTo)
    ))
    .returning();

  if (updated.length === 0) {
    throw new TicketServiceError('Ticket was modified concurrently', 409, 'CONCURRENT_MODIFICATION');
  }

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'assignment',
    content: '',
    isPublic: false,
    oldValue: prevAssignedTo ?? null,
    newValue: assigneeId
  });

  await emitTicketEvent({
    type: 'ticket.assigned',
    ticketId,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { assigneeId }
  });
  await writeTicketOutbox(ticket.orgId, ticketId, 'ticket.assigned', { assigneeId });
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.assign',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { from: prevAssignedTo ?? null, to: assigneeId },
    result: 'success'
  });
  await emitTicketTriageFeedback({
    orgId: ticket.orgId,
    ticketId,
    eventType: 'ticket.assignee_changed',
    dedupeKey: ticketTriageDedupeKey('assignedTo', prevAssignedTo ?? null, assigneeId),
    outcome: 'assignee_changed',
    actorUserId: actor.userId,
    metadata: ticketTriageFeedbackMetadata(actor, {
      oldValue: prevAssignedTo ?? null,
      newValue: assigneeId,
    }),
  });
  return updated[0];
}

export interface AddCommentInput {
  content: string;
  isPublic: boolean;
  /**
   * W08 #3902 — pending attachment ids to claim for this comment (spec D2).
   * They are claimed inside the SAME transaction as the comment insert, so a
   * foreign/already-claimed id rolls the comment back rather than posting a
   * comment whose photos silently vanished.
   */
  attachmentIds?: string[];
}

export async function addTicketComment(ticketId: string, input: AddCommentInput, actor: TicketActor) {
  const ticket = await getTicketOrThrow(ticketId);
  const attachmentIds = input.attachmentIds ?? [];

  // W08 #3902: this used to be four separate writes on the global `db`. The
  // attachment claim must roll back with the comment, so the comment insert,
  // the firstResponseAt stamp and the claim now share one transaction.
  // emitTicketEvent / writeTicketOutbox / createAuditLogAsync stay AFTER the
  // commit — publishing ticket.commented for a comment that may still roll
  // back would be worse than a late event.
  const { comment, firstResponseStamped, attachments } = await db.transaction(async (tx) => {
    const inserted = await tx.insert(ticketComments).values({
      ticketId,
      userId: actor.userId,
      authorName: actor.name ?? null,
      authorType: 'internal',
      commentType: input.isPublic ? 'comment' : 'internal',
      content: input.content,
      isPublic: input.isPublic
    }).returning();
    const row = inserted[0];
    if (!row) throw new TicketServiceError('Failed to add comment', 500);

    // First PUBLIC technician response stamps firstResponseAt (spec §2).
    // Internal notes do NOT stamp it.
    let stamped = false;
    if (input.isPublic && !ticket.firstResponseAt) {
      await tx.update(tickets)
        .set({ firstResponseAt: new Date(), updatedAt: new Date() })
        .where(eq(tickets.id, ticketId));
      stamped = true;
    }

    // The claim. Every predicate is load-bearing:
    //   ticket_id           — cannot attach another ticket's file
    //   org_id              — belt with the RLS braces
    //   comment_id IS NULL  — cannot re-claim an already-attached file
    //   uploaded_by_user_id — cannot claim someone else's upload
    // RETURNING lists the META columns only: `data` (up to 10 MiB of bytea)
    // must never leave the row here (spec D10).
    let claimed: Array<{
      id: string; commentId: string | null; contentType: string;
      byteSize: number; originalFilename: string; createdAt: Date;
    }> = [];
    if (attachmentIds.length > 0) {
      const idList = sql.join(attachmentIds.map((aid) => sql`${aid}::uuid`), sql`, `);
      const result = await tx.execute(sql`
        UPDATE ticket_attachments
           SET comment_id = ${row.id}::uuid, attached_at = now()
         WHERE id IN (${idList})
           AND ticket_id = ${ticketId}::uuid
           AND org_id = ${ticket.orgId}::uuid
           AND comment_id IS NULL
           AND uploaded_by_user_id = ${actor.userId}::uuid
        RETURNING id,
                  comment_id        AS "commentId",
                  content_type      AS "contentType",
                  byte_size         AS "byteSize",
                  original_filename AS "originalFilename",
                  created_at        AS "createdAt"
      `);
      claimed = (Array.isArray(result) ? result : []) as typeof claimed;
      if (claimed.length !== attachmentIds.length) {
        throw new TicketServiceError(
          'One or more attachments could not be attached to this comment',
          409,
          'ATTACHMENT_NOT_CLAIMABLE'
        );
      }
    }

    return { comment: row, firstResponseStamped: stamped, attachments: claimed };
  });

  await emitTicketEvent({
    type: 'ticket.commented',
    ticketId,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { commentId: comment.id, isPublic: input.isPublic }
  });
  await writeTicketOutbox(ticket.orgId, ticketId, 'ticket.commented', { commentId: comment.id, isPublic: input.isPublic });
  // Record the comment id + visibility only — the comment body can carry
  // sensitive/large content, so it stays out of the audit details (matching the
  // sibling pattern of keeping details lean).
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.comment',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { commentId: comment.id, isInternal: !input.isPublic },
    result: 'success'
  });

  return { comment, firstResponseStamped, attachments };
}

/** Postgres unique-violation, however the driver happens to wrap it (mirrors tenantVariables.ts's isUniqueViolation). */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}

/**
 * P2-4 (#4191): the first real writer of the 6.3 loop-guard columns
 * (`originPrincipalKind` / `agentRunId`) — an AI-authored INTERNAL ticket
 * note. `userId`/`portalUserId` are deliberately null: an ai_agent's identity
 * (`aiAgents.id`) is not a `users.id` row, so writing it into
 * `ticket_comments.user_id` (an FK to `users`) would violate the FK — the
 * agent's display name goes into `authorName` for attribution instead
 * (mirrors `remediationActResolver.ts`'s "never a synthetic users-FK id for
 * an agent actor" precedent).
 *
 * Emits the SAME `ticket.commented` event/outbox row `addTicketComment`
 * does — this does NOT re-trigger the 6.3 helpdesk subscriber's admission
 * loop: the subscriber's own loop guard filters on
 * `originPrincipalKind !== 'user'` (`ticketHelpdeskSubscriber.ts`), which
 * this row satisfies by construction.
 *
 * Idempotent per run via `ticket_comments_one_ai_note_per_run_uq` (partial
 * unique on `agent_run_id` WHERE `agent_run_id IS NOT NULL AND
 * origin_principal_kind = 'ai_agent'`): a retry after a partial failure (the
 * caller observed an error but the insert actually committed) returns the
 * EXISTING row rather than erroring or duplicating the note.
 */
export async function addAiTriageNote(
  ticketId: string,
  runId: string,
  content: string,
  orgId: string,
  agentName = 'AI Agent'
): Promise<{ comment: { id: string } }> {
  const ticket = await getTicketOrThrow(ticketId);
  if (ticket.orgId !== orgId) {
    throw new TicketServiceError('Ticket not found', 404);
  }

  try {
    const inserted = await db.insert(ticketComments).values({
      ticketId,
      userId: null,
      portalUserId: null,
      authorName: agentName,
      authorType: 'ai_agent',
      commentType: 'internal',
      content,
      isPublic: false,
      originPrincipalKind: 'ai_agent',
      agentRunId: runId
    }).returning({ id: ticketComments.id });
    const comment = inserted[0];
    if (!comment) throw new TicketServiceError('Failed to add AI triage note', 500);

    await emitTicketEvent({
      type: 'ticket.commented',
      ticketId,
      orgId: ticket.orgId,
      partnerId: ticket.partnerId ?? null,
      actorUserId: null,
      payload: { commentId: comment.id, isPublic: false }
    });
    await writeTicketOutbox(ticket.orgId, ticketId, 'ticket.commented', { commentId: comment.id, isPublic: false });

    return { comment };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db
        .select({ id: ticketComments.id })
        .from(ticketComments)
        .where(and(eq(ticketComments.agentRunId, runId), eq(ticketComments.originPrincipalKind, 'ai_agent')))
        .limit(1);
      const row = existing[0];
      if (row) return { comment: row };
    }
    throw err;
  }
}

export interface AiFieldUpdateSpec<T> {
  value: T;
  /** The value the caller last observed — the CAS predicate's comparison target. */
  expectedCurrent: T | null;
}

export interface ApplyAiFieldUpdatesInput {
  categoryId?: AiFieldUpdateSpec<string>;
  priority?: AiFieldUpdateSpec<'low' | 'normal' | 'high' | 'urgent'>;
}

export type AiFieldUpdateOutcome =
  | { applied: true }
  | { applied: false; skipped: 'human_set' | 'concurrent_change' };

/**
 * P2-4 (#4191): the AI-triage release-path counterpart to `updateTicketFields`
 * — CAS-guarded so an autonomous write can never clobber a field a human has
 * since touched, or one that changed concurrently since the caller last
 * observed it. One UPDATE, per-field `CASE WHEN <value unchanged since
 * expectedCurrent> AND <no human stamp on this field> AND <new value actually
 * differs> THEN <new value> ELSE <current value> END` — the CAS predicate is
 * evaluated by Postgres against
 * the row under the UPDATE's own row lock, so this is atomic without a
 * separate `SELECT ... FOR UPDATE`. `field_provenance` is stamped to
 * 'ai_agent' with the SAME predicate, so a skipped field's provenance is left
 * exactly as it was (see `updateTicketFields`'s "AI writes never overwrite a
 * 'user' stamp" contract this implements).
 *
 * The predicate also requires the write to be a REAL change
 * (`<column> IS DISTINCT FROM <new value>`, #4466). The CAS half only proves
 * the field has not MOVED since the caller observed it, so without this an AI
 * that merely re-asserts the value already on the ticket satisfied the
 * predicate and stamped 'ai_agent' anyway — silently taking ownership of a
 * value a human had set through a path that left no provenance entry (an
 * absent stamp COALESCEs to '' and sails past the `<> 'user'` guard). The
 * guard sits in the shared predicate rather than only on the provenance arm so
 * the stamp and the field write can never drift apart; on the value arm it is
 * a no-op by construction, since writing a column the value it already holds
 * changes nothing. This mirrors the human path, where `updateTicketFields`
 * likewise stamps only the fields its own diff found changed.
 *
 * `categoryId`'s value is validated against `ticket_categories` for the
 * ticket's PARTNER before the UPDATE runs — a cross-partner categoryId must
 * fail closed exactly like the human `update_fields` path
 * (`assertCategoryInPartner`), not silently write an orphaned id.
 */
export async function applyAiFieldUpdates(
  ticketId: string,
  orgId: string,
  updates: ApplyAiFieldUpdatesInput,
  runId: string
): Promise<Partial<Record<'categoryId' | 'priority', AiFieldUpdateOutcome>>> {
  // Reserved for forthcoming audit/observability wiring — not written
  // anywhere yet (no brief-specified writer, and attributing an audit row
  // correctly needs the run's agentId, which this signature doesn't carry;
  // see the task report's Concerns).
  void runId;

  if (!updates.categoryId && !updates.priority) return {};

  const [ticket] = await db
    .select({ id: tickets.id, orgId: tickets.orgId, partnerId: tickets.partnerId })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
    .limit(1);
  if (!ticket) {
    throw new TicketServiceError('Ticket not found', 404);
  }

  if (updates.categoryId) {
    await assertCategoryInPartner(updates.categoryId.value, await resolveTicketPartnerId(ticket));
  }

  // Three conjuncts, and all three are load-bearing: the CAS half (the value
  // has not moved since the caller observed it), the human-stamp guard, and
  // the real-change guard (#4466 — an AI re-asserting the value already on
  // the ticket must not take ownership of it; see the doc block above).
  const categoryCond = updates.categoryId
    ? sql`(${tickets.categoryId} IS NOT DISTINCT FROM ${updates.categoryId.expectedCurrent} AND COALESCE(${tickets.fieldProvenance}->>'categoryId', '') <> 'user' AND ${tickets.categoryId} IS DISTINCT FROM ${updates.categoryId.value}::uuid)`
    : null;
  const priorityCond = updates.priority
    ? sql`(${tickets.priority} IS NOT DISTINCT FROM ${updates.priority.expectedCurrent} AND COALESCE(${tickets.fieldProvenance}->>'priority', '') <> 'user' AND ${tickets.priority} IS DISTINCT FROM ${updates.priority.value}::ticket_priority)`
    : null;

  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (categoryCond) {
    setClause.categoryId = sql`CASE WHEN ${categoryCond} THEN ${updates.categoryId!.value}::uuid ELSE ${tickets.categoryId} END`;
  }
  if (priorityCond) {
    setClause.priority = sql`CASE WHEN ${priorityCond} THEN ${updates.priority!.value}::ticket_priority ELSE ${tickets.priority} END`;
  }

  const provenanceParts = [
    categoryCond ? sql`CASE WHEN ${categoryCond} THEN '{"categoryId":"ai_agent"}'::jsonb ELSE '{}'::jsonb END` : null,
    priorityCond ? sql`CASE WHEN ${priorityCond} THEN '{"priority":"ai_agent"}'::jsonb ELSE '{}'::jsonb END` : null,
  ].filter((part): part is NonNullable<typeof part> => part !== null);
  if (provenanceParts.length > 0) {
    setClause.fieldProvenance = sql.join([sql`${tickets.fieldProvenance}`, ...provenanceParts], sql` || `);
  }

  const [after] = await db
    .update(tickets)
    .set(setClause)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
    .returning({ categoryId: tickets.categoryId, priority: tickets.priority, fieldProvenance: tickets.fieldProvenance });

  if (!after) {
    throw new TicketServiceError('Ticket was modified concurrently', 409, 'CONCURRENT_MODIFICATION');
  }

  const result: Partial<Record<'categoryId' | 'priority', AiFieldUpdateOutcome>> = {};
  if (updates.categoryId) {
    result.categoryId = after.categoryId === updates.categoryId.value
      ? { applied: true }
      : { applied: false, skipped: after.fieldProvenance?.categoryId === 'user' ? 'human_set' : 'concurrent_change' };
  }
  if (updates.priority) {
    result.priority = after.priority === updates.priority.value
      ? { applied: true }
      : { applied: false, skipped: after.fieldProvenance?.priority === 'user' ? 'human_set' : 'concurrent_change' };
  }
  return result;
}

// Task A10 (#4191) — human draft routes (list / send / discard)

export interface ActiveTicketDraftRow {
  id: string;
  kind: 'reply' | 'resolution_note';
  content: string;
  createdAt: Date;
  runId: string | null;
}

/**
 * The active drafts for a ticket (at most one per `kind` —
 * `ticket_drafts_active_uq`). `runId` is a bare link to the producing
 * `ai_agent_runs` row (the run-detail page), never the run's own outcome.
 */
export async function listActiveTicketDrafts(ticketId: string): Promise<ActiveTicketDraftRow[]> {
  return db
    .select({
      id: ticketDrafts.id,
      kind: ticketDrafts.kind,
      content: ticketDrafts.content,
      createdAt: ticketDrafts.createdAt,
      runId: ticketDrafts.runId,
    })
    .from(ticketDrafts)
    .where(and(eq(ticketDrafts.ticketId, ticketId), eq(ticketDrafts.state, 'active')))
    .orderBy(desc(ticketDrafts.createdAt))
    // Defensive bound only — ticket_drafts_active_uq caps this at one active
    // row per (ticketId, kind), and there are two kinds, so the real result
    // is never more than 2 rows.
    .limit(10);
}

/**
 * Post a `reply`-kind draft as a PUBLIC comment under the CALLING
 * technician's own identity — sending is a human act, so this is
 * `originPrincipalKind: 'user'` and `userId: actor.userId`, never an
 * AI-attributed row (contrast `addAiTriageNote`). `content` overrides the
 * draft's stored text when the technician edited it before sending;
 * otherwise the draft's own content is posted verbatim.
 *
 * `SELECT ... FOR UPDATE` locks the draft row for the rest of this
 * transaction: a concurrent second send/discard call blocks on the same row
 * until this one commits or rolls back, then observes the now-committed
 * `state` — so a double-send under a race is a clean 409 with ZERO duplicate
 * comments, never two racing inserts. The final CAS `UPDATE ... WHERE
 * state='active'` is defense-in-depth (unreachable while the lock above
 * holds, since nothing else in this same transaction can have changed the
 * row) rather than the load-bearing guard.
 */
export async function sendTicketDraft(
  ticketId: string,
  draftId: string,
  content: string | undefined,
  actor: TicketActor
): Promise<{ comment: { id: string }; firstResponseStamped: boolean }> {
  const ticket = await getTicketOrThrow(ticketId);

  const [draft] = await db
    .select()
    .from(ticketDrafts)
    .where(and(eq(ticketDrafts.id, draftId), eq(ticketDrafts.ticketId, ticketId)))
    .limit(1)
    .for('update');
  if (!draft) throw new TicketServiceError('Draft not found', 404);
  if (draft.kind !== 'reply') {
    throw new TicketServiceError('Only reply drafts can be sent — a resolution-note draft is consumed by resolving the ticket', 409);
  }
  if (draft.state !== 'active') {
    throw new TicketServiceError('Draft is no longer active', 409);
  }

  const body = content && content.trim().length > 0 ? content : draft.content;

  const inserted = await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'comment',
    content: body,
    isPublic: true,
    originPrincipalKind: 'user'
  }).returning({ id: ticketComments.id });
  const comment = inserted[0];
  if (!comment) throw new TicketServiceError('Failed to send draft', 500);

  const consumed = await db
    .update(ticketDrafts)
    .set({ state: 'consumed', consumedBy: actor.userId, consumedAt: new Date() })
    .where(and(eq(ticketDrafts.id, draftId), eq(ticketDrafts.state, 'active')))
    .returning({ id: ticketDrafts.id });
  if (consumed.length === 0) {
    throw new TicketServiceError('Draft was already consumed', 409);
  }

  // Same first-PUBLIC-response stamping rule as addTicketComment.
  let firstResponseStamped = false;
  if (!ticket.firstResponseAt) {
    await db.update(tickets)
      .set({ firstResponseAt: new Date(), updatedAt: new Date() })
      .where(eq(tickets.id, ticketId));
    firstResponseStamped = true;
  }

  await emitTicketEvent({
    type: 'ticket.commented',
    ticketId,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { commentId: comment.id, isPublic: true }
  });
  await writeTicketOutbox(ticket.orgId, ticketId, 'ticket.commented', { commentId: comment.id, isPublic: true });
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.comment',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { commentId: comment.id, isInternal: false, fromAiDraft: draftId },
    result: 'success'
  });

  return { comment, firstResponseStamped };
}

/**
 * CAS `active -> discarded`. Distinguishes "no such draft for this ticket"
 * (404) from "found, but no longer active" (409) via a plain read before the
 * CAS write — the write's own `WHERE state='active'` is what actually
 * enforces the transition against a concurrent racer.
 */
export async function discardTicketDraft(ticketId: string, draftId: string): Promise<{ id: string }> {
  const [draft] = await db
    .select({ id: ticketDrafts.id, state: ticketDrafts.state })
    .from(ticketDrafts)
    .where(and(eq(ticketDrafts.id, draftId), eq(ticketDrafts.ticketId, ticketId)))
    .limit(1);
  if (!draft) throw new TicketServiceError('Draft not found', 404);
  if (draft.state !== 'active') {
    throw new TicketServiceError('Draft is no longer active', 409);
  }

  const updated = await db
    .update(ticketDrafts)
    .set({ state: 'discarded' })
    .where(and(eq(ticketDrafts.id, draftId), eq(ticketDrafts.state, 'active')))
    .returning({ id: ticketDrafts.id });
  const row = updated[0];
  if (!row) {
    throw new TicketServiceError('Draft was already consumed or discarded', 409);
  }
  return row;
}

// Task 8 — Alert linking

/** Maps alert severity to ticket priority. Exported for use by AI tools and routes. */
export const SEVERITY_TO_PRIORITY: Record<string, 'low' | 'normal' | 'high' | 'urgent'> = {
  critical: 'urgent',
  high: 'high',
  medium: 'normal',
  low: 'low',
  info: 'low'
};

export async function linkAlertToTicket(
  ticketId: string,
  alertId: string,
  actor: TicketActor,
  linkType: 'created_from' | 'attached' | 'auto' = 'attached'
) {
  const ticket = await getTicketOrThrow(ticketId);
  const alertRows = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  const alert = alertRows[0];
  if (!alert) throw new TicketServiceError('Alert not found', 404);
  if (alert.orgId !== ticket.orgId) {
    throw new TicketServiceError('Alert and ticket must belong to the same organization', 400);
  }

  // Idempotent insert: if the link already exists, onConflictDoNothing returns an empty array.
  const inserted = await db.insert(ticketAlertLinks).values({
    ticketId,
    orgId: ticket.orgId,
    alertId,
    linkType,
    createdBy: actor.userId
  }).onConflictDoNothing().returning();

  if (inserted.length === 0) {
    throw new TicketServiceError('Alert is already linked to this ticket', 409);
  }

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'system',
    content: `Linked alert: ${alert.title ?? alertId}`,
    isPublic: false,
    newValue: alertId
  });

  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.alert_link',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { alertId },
    result: 'success'
  });

  return inserted[0];
}

export async function unlinkAlertFromTicket(ticketId: string, alertId: string, actor: TicketActor) {
  const ticket = await getTicketOrThrow(ticketId);
  const deleted = await db.delete(ticketAlertLinks).where(
    and(eq(ticketAlertLinks.ticketId, ticketId), eq(ticketAlertLinks.alertId, alertId))
  ).returning();

  if (deleted.length === 0) {
    throw new TicketServiceError('Alert link not found', 404);
  }

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'system',
    content: 'Unlinked alert',
    isPublic: false,
    oldValue: alertId
  });

  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.alert_unlink',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { alertId },
    result: 'success'
  });
  return { ticketId, alertId, orgId: ticket.orgId };
}

export async function createTicketFromAlert(
  alertId: string,
  actor: TicketActor,
  overrides: Partial<Pick<CreateTicketInput, 'subject' | 'description' | 'categoryId' | 'priority' | 'assigneeId'>> = {}
) {
  const alertRows = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  const alert = alertRows[0];
  if (!alert) throw new TicketServiceError('Alert not found', 404);

  const ticket = await createTicket({
    orgId: alert.orgId,
    subject: overrides.subject ?? alert.title ?? `Alert ${alertId}`,
    description: overrides.description ?? alert.message ?? undefined,
    deviceId: alert.deviceId ?? undefined,
    categoryId: overrides.categoryId,
    priority: overrides.priority ?? SEVERITY_TO_PRIORITY[alert.severity ?? ''] ?? 'normal',
    assigneeId: overrides.assigneeId,
    source: 'alert'
  }, actor);

  try {
    await linkAlertToTicket(ticket.id, alertId, actor, 'created_from');
  } catch (err) {
    throw new Error(
      `Ticket ${ticket.internalNumber} created but alert link failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return ticket;
}

// ─── Comment mutation primitives (Phase 6a) ───────────────────────────────────

/**
 * System-generated comment types that may never be edited or deleted by users.
 */
export const SYSTEM_COMMENT_TYPES = new Set(['status_change', 'assignment', 'time_entry', 'system']);

async function loadCommentWithTicket(commentId: string) {
  const rows = await db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.id, commentId))
    .limit(1);
  const comment = rows[0];
  if (!comment) throw new TicketServiceError('Comment not found', 404);
  const ticket = await getTicketOrThrow(comment.ticketId);
  return { comment, ticket };
}

function assertCommentEditable(
  comment: typeof ticketComments.$inferSelect,
  actor: TicketActor,
  canManageAny: boolean
) {
  if (SYSTEM_COMMENT_TYPES.has(comment.commentType)) {
    throw new TicketServiceError('System-generated entries cannot be edited or deleted', 400);
  }
  if (comment.deletedAt) {
    throw new TicketServiceError('Comment already deleted', 409);
  }
  const isAuthor = comment.userId != null && comment.userId === actor.userId;
  if (!isAuthor && !canManageAny) {
    throw new TicketServiceError('You can only edit or delete your own comments', 403);
  }
}

export async function editTicketComment(
  commentId: string,
  input: { content: string },
  actor: TicketActor,
  opts: { canManageAny: boolean; expectedTicketId?: string }
) {
  const { comment, ticket } = await loadCommentWithTicket(commentId);
  // Defense-in-depth: reject comment/ticket id mismatch before any
  // existence-revealing check so the response is indistinguishable from missing.
  if (opts.expectedTicketId !== undefined && comment.ticketId !== opts.expectedTicketId) {
    throw new TicketServiceError('Comment not found', 404);
  }
  assertCommentEditable(comment, actor, opts.canManageAny);

  const previousContent = comment.content;
  const updated = await db
    .update(ticketComments)
    .set({ content: input.content, editedAt: new Date() })
    .where(eq(ticketComments.id, commentId))
    .returning();
  const row = updated[0];
  if (!row) throw new TicketServiceError('Comment not found', 404);

  // NOTE: no emitTicketEvent here — emitting 'ticket.commented' on an edit
  // would re-trigger the notify worker's "new reply" email to the portal
  // requester. The web UI re-fetches via load({background:true}) after edit.
  // A future 'ticket.comment_edited' event type can be added when automation
  // consumers need it.
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.comment.edit',
    resourceType: 'ticket',
    resourceId: ticket.id,
    details: { commentId, previousContent },
    result: 'success'
  });
  return row;
}

export async function deleteTicketComment(
  commentId: string,
  actor: TicketActor,
  opts: { canManageAny: boolean; expectedTicketId?: string }
) {
  const { comment, ticket } = await loadCommentWithTicket(commentId);
  // Defense-in-depth: reject comment/ticket id mismatch before any
  // existence-revealing check so the response is indistinguishable from missing.
  if (opts.expectedTicketId !== undefined && comment.ticketId !== opts.expectedTicketId) {
    throw new TicketServiceError('Comment not found', 404);
  }
  assertCommentEditable(comment, actor, opts.canManageAny);

  const previousContent = comment.content;
  const deleted = await db
    .update(ticketComments)
    .set({ deletedAt: new Date() })
    .where(eq(ticketComments.id, commentId))
    .returning();
  if (deleted.length === 0) {
    throw new TicketServiceError('Comment not found or already deleted', 409);
  }

  // NOTE: no emitTicketEvent here — emitting 'ticket.commented' on a delete
  // would send a ghost "new reply" email to the portal requester. The web UI
  // re-fetches via load({background:true}) after delete.
  // A future 'ticket.comment_deleted' event type can be added when automation
  // consumers need it.
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.comment.delete',
    resourceType: 'ticket',
    resourceId: ticket.id,
    details: { commentId, previousContent },
    result: 'success'
  });
  return { id: commentId };
}

// ─── Soft-delete / restore (Phase 6, issue #2140) ─────────────────────────────

/**
 * Soft-delete a ticket. Stamps deleted_at/deleted_by so the ticket drops out of
 * every staff/portal list, stats count, and by-id mutation (getScopedTicketOr404
 * excludes deleted rows by default), while the row is preserved for audit and
 * admin restore. Deliberately emits NO ticket lifecycle event — deletion must
 * not send a portal notification (mirrors deleteTicketComment). Re-deleting an
 * already-deleted ticket is a 409 so a double-click can't overwrite deleted_by.
 * Gated at the route on tickets:manage.
 */
export async function softDeleteTicket(ticketId: string, actor: TicketActor): Promise<{ id: string }> {
  const ticket = await getTicketOrThrow(ticketId);
  if (ticket.deletedAt) throw new TicketServiceError('Ticket already deleted', 409);

  const now = new Date();
  const deleted = await db
    .update(tickets)
    .set({ deletedAt: now, deletedBy: actor.userId, updatedAt: now })
    .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
    .returning({ id: tickets.id });
  // CAS on deleted_at IS NULL: an empty result means we lost a race to a
  // concurrent delete — report it rather than emit a second audit entry.
  if (deleted.length === 0) throw new TicketServiceError('Ticket already deleted', 409);

  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.delete',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { ticketNumber: ticket.ticketNumber, subject: ticket.subject, status: ticket.status },
    result: 'success'
  });
  return { id: ticketId };
}

/**
 * Restore a soft-deleted ticket. Clears deleted_at/deleted_by. Restoring a
 * ticket that isn't deleted is a 409 (nothing to restore). Audited as
 * ticket.restore. Gated at the route on tickets:manage.
 */
export async function restoreTicket(ticketId: string, actor: TicketActor): Promise<typeof tickets.$inferSelect> {
  const ticket = await getTicketOrThrow(ticketId);
  if (!ticket.deletedAt) throw new TicketServiceError('Ticket is not deleted', 409);

  const [updated] = await db
    .update(tickets)
    .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
    .where(and(eq(tickets.id, ticketId), sql`${tickets.deletedAt} IS NOT NULL`))
    .returning();
  if (!updated) throw new TicketServiceError('Ticket is not deleted', 409);

  // No emitTicketEvent here (restore never had a legacy-queue event — the
  // notify worker has no ticket.restored branch). The outbox row is new for
  // this PR: it exists purely so the durable-subscriber path (Task 3) and any
  // future consumer can observe a restore, mirroring the other 5 sites.
  await writeTicketOutbox(ticket.orgId, ticketId, 'ticket.restored');

  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.restore',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { ticketNumber: ticket.ticketNumber, subject: ticket.subject },
    result: 'success'
  });
  return updated;
}

// ─── Org re-assignment (Phase 6a) ─────────────────────────────────────────────

// Child tables that denormalize org_id and reference a ticket. Mirrors the
// device-move CUSTOM_ORG_REWRITE_TABLES set (core.ts) — keep in lockstep.
// ticket_comments is intentionally absent: it has no org_id (child-via-parent).
// invoice_lines is intentionally excluded: issued billing history must remain
// stamped with the org that was billed (matches device CUSTOM_ORG_REWRITE_TABLES
// exclusion); its ticket_id FK is ON DELETE SET NULL so moves do not orphan it.
// ticket_outbox (#3828 wave-6-3 review fix): carries both ticket_id and a
// denormalized org_id (db/migrations/2026-09-19-ai-agents-ticket-shadow.sql)
// — an unpublished row left on the source org would be published under the
// old org's routing, resolving the wrong org's helpdesk agents and letting
// the Task 4 context assembler load the moved ticket's content into a run
// scoped to an org that no longer owns it. Same UPDATE shape as the other
// three tables; the mover already holds access to both orgs (same-partner
// constraint), so RLS USING/WITH CHECK both pass.
// ticket_attachments (W08 #3902): comment photo/PDF metadata rows denormalize
// org_id from their ticket (shape 1) and have no device_id. Appended LAST so
// this path and the device-move path (routes/devices/moveOrg.ts) touch the
// ticket-linked child tables in the same relative order; see the lock-order
// comment at moveOrg.ts:~311. S3 objects are keyed by attachment id only
// (spec D8) and are NOT touched by a move.
// ticket_email_links is NOT here, and that is a known gap rather than a ruling:
// it denormalizes org_id from its ticket (shape 1, FORCE RLS) yet is absent
// from both this list and the device path's CUSTOM_ORG_REWRITE_TABLES, so a
// moved ticket strands its link rows on the source org on BOTH axes. Left out
// of the #4524 fix deliberately — closing it correctly spans this service and
// routes/devices/moveOrg.ts and turns on the inbound-email tenancy model, so it
// is tracked in #4643 rather than half-fixed on one axis here.
const TICKET_ORG_DENORMALIZED_TABLES = ['time_entries', 'ticket_parts', 'ticket_alert_links', 'ticket_outbox', 'ticket_attachments'] as const;

/**
 * Reassigns a ticket to another organization of the SAME partner.
 * - Detaches any linked device (device belongs to the source org).
 * - Re-stamps org_id on all denormalized child tables.
 * - Writes a system feed comment and dual-org audit log entries.
 * - Emits ticket.updated.
 * Rejects cross-partner moves with 400; unknown target with 404; same-org is a no-op.
 */
export interface MoveTicketOrgOptions {
  /**
   * Multi-currency (#3776): allow a cross-currency move even though unbilled
   * monetary time entries / parts will keep their OLD-currency snapshot under
   * the new org. Route-gated on invoices:write; AI tools never set it.
   */
  acceptCurrencyMismatch?: boolean;
}

export async function moveTicketOrg(
  ticketId: string,
  targetOrgId: string,
  actor: TicketActor,
  opts: MoveTicketOrgOptions = {}
): Promise<typeof tickets.$inferSelect> {
  const ticket = await getTicketOrThrow(ticketId);
  if (ticket.orgId === targetOrgId) return ticket;

  let updated: typeof tickets.$inferSelect | undefined;
  let guard: MoveCurrencyGuardDetails | null = null;
  await db.transaction(async (tx) => {
    // Lock order (global, #3778): organizations FOR SHARE (BOTH orgs, ascending
    // UUID so two concurrent moves between the same pair cannot deadlock) →
    // action_intents → ticket_drafts → ai_agent_runs → tickets → ticket_comments
    // → the TICKET_ORG_DENORMALIZED_TABLES loop (time_entries, ticket_parts,
    // ticket_alert_links, ticket_outbox, ticket_attachments).
    //
    // ai_agent_runs sits ahead of tickets (#4524) to match
    // breeze_cascade_device_org_id(), which severs runs before re-stamping its
    // child tables — `tickets` among them; the two paths must agree on that pair
    // or a concurrent device-move and ticket-move over the same device-linked
    // ticket deadlocks. action_intents is ordered the other way round from the
    // device axis, which is safe only because the two can never contend for a
    // row: action_intents_scope_device_chk / _scope_ticket_chk make
    // scope_device_id and scope_ticket_id mutually exclusive, so the device
    // axis's `WHERE scope_device_id = D` and this path's `WHERE scope_ticket_id`
    // select disjoint rows. That argument does NOT cover ticket_alert_links,
    // which both axes can reach for the same row in opposite order relative to
    // time_entries/ticket_parts — a pre-existing instance of the same deadlock
    // class, tracked in #4657 rather than reordered here.
    //
    // The org lock is the FIRST statement of this transaction and is held to
    // commit, so the source/target currency pair the guard compares cannot be
    // restamped mid-move.
    const lockedOrgs = await readOrgStampingDefaultsMany(tx, [ticket.orgId, targetOrgId]);
    const orgRows = await tx
      .select({ id: organizations.id, partnerId: organizations.partnerId, name: organizations.name })
      .from(organizations)
      .where(sql`${organizations.id} IN (${ticket.orgId}::uuid, ${targetOrgId}::uuid)`)
      .limit(2);
    const sourceMeta = orgRows.find((r) => r.id === ticket.orgId);
    const targetMeta = orgRows.find((r) => r.id === targetOrgId);
    if (!targetMeta) throw new TicketServiceError('Target organization not found', 404);
    if (!sourceMeta || sourceMeta.partnerId !== targetMeta.partnerId) {
      throw new TicketServiceError('Tickets can only be moved between organizations of the same partner', 400);
    }
    // Present by construction: the metadata rows above resolved, so the locks did too.
    const sourceOrg = { ...sourceMeta, currencyCode: lockedOrgs.get(ticket.orgId)!.currencyCode };
    const targetOrg = { ...targetMeta, currencyCode: lockedOrgs.get(targetOrgId)!.currencyCode };
    // C1 fix (#4191 final review): both statements below MUST run BEFORE the
    // `tx.update(tickets)` UPDATE just below — not after, despite every
    // other cleanup here (the child-table org_id rewrites) following it.
    // Both composite FKs below are DEFERRABLE INITIALLY IMMEDIATE (checked
    // at the end of EACH statement, not deferred to COMMIT — no
    // `SET CONSTRAINTS ... DEFERRED` is issued in this transaction), and
    // both reference `tickets(id, org_id)` — org_id is part of the key the
    // ticket UPDATE below changes. Running the ticket UPDATE first (as a
    // first attempt at this fix did) fails immediately with 23503 the
    // instant that statement completes: a still-live ticket_drafts/
    // action_intents row now points at (ticketId, OLD org_id), which no
    // longer matches any row in `tickets` (there is only one row per id).
    // These two must run first so no such row exists by the time the ticket
    // UPDATE's own FK check runs.
    //
    // Both must live HERE (inside this transaction) rather than on either
    // caller (the HTTP route at routes/tickets/moveOrg.ts, or the AI-tool
    // executor at aiToolsTicketing.ts's move_org action) — this is the one
    // path both call through, and the AI-tool path's own tombstone predates
    // this fix and covered neither table nor every status (see below).
    //
    // 1. action_intents.scope_ticket_id: composite FK (scope_ticket_id,
    // org_id) -> tickets(id, org_id) (action_intents_scope_ticket_org_fk,
    // migrations/2026-09-25-ai-agents-ticket-triage.sql). action_intents rows
    // keep the org_id of the actor who requested them — they do NOT move
    // with the ticket — so once the ticket UPDATE below changes tickets.org_id,
    // ANY remaining scope_ticket_id pointer (regardless of status) 23503s,
    // and permanently: the composite pair (scope_ticket_id, targetOrgId)
    // never resolves because the intent's own org_id never becomes
    // targetOrgId. The immutability trigger
    // (action_intents_block_content_update()) only special-cases a non-null
    // -> NULL transition, so tombstoning is the only legal move, and it must
    // cover every status, not just the live pre-release ones — a terminal
    // (completed/failed/expired) intent still carries the same FK and would
    // still 23503 on the next unrelated UPDATE to that row (audit backfills,
    // moveOrg's own UPDATE below). All statuses, unconditionally.
    await tx
      .update(actionIntents)
      .set({ scopeTicketId: null })
      .where(eq(actionIntents.scopeTicketId, ticketId));
    // 2. ticket_drafts: composite FK (ticket_id, org_id) -> tickets(id,
    // org_id) (ticket_drafts_ticket_org_fk) would break the same way UNLESS
    // we also repoint ticket_drafts.org_id — but ticket_drafts.run_id is
    // ALSO composite-FK'd (run_id, org_id) -> ai_agent_runs(id, org_id)
    // (ticket_drafts_run_org_fk), and the run stays behind in the source
    // org, so repointing org_id would just trade one 23503 for another.
    // Drafts are ephemeral (proposed content awaiting human
    // consumption/discard, never itself the ticket_comments record — see
    // ticketDrafts.ts's header comment), so deleting them on a cross-org
    // move is the same accepted ruling used by the org-merge custom
    // executor for the same run-pinning conflict.
    await tx.delete(ticketDrafts).where(eq(ticketDrafts.ticketId, ticketId));
    // #4524 — sever ai_agent_runs.ticket_id. Agent-run history stays with the
    // SOURCE org (owner decision 2026-08-23): ai_agent_runs.org_id is
    // trigger-immutable (ai_agent_runs_immutable_guard, 2026-09-06-a) and the
    // table is deliberately absent from TICKET_ORG_DENORMALIZED_TABLES below.
    // So a run that triggered on this ticket keeps org_id = SOURCE while the
    // ticket it names becomes the TARGET org's — a cross-tenant pointer, and
    // /ai-agents/:id/runs would serve that now-foreign ticket id back to the
    // source org. This is the ticket-axis twin of the device-axis statement
    // added by #4215.
    //
    // Nothing forces the issue the way it does for the two statements above:
    // ai_agent_runs.ticket_id is a PLAIN single-column FK to tickets(id) with
    // ON DELETE SET NULL (aiAgents.ts), not a composite (ticket_id, org_id)
    // tenant FK, so the ticket UPDATE below would complete happily and the
    // stale pointer would survive in silence. There is also no Postgres trigger
    // on `UPDATE OF org_id ON tickets` (the device axis has
    // breeze_cascade_device_org_id(); the ticket axis has no equivalent), so
    // this service is the ONLY place the contract is enforced — see the note
    // beside orgMergeRegistry's `tickets` entry for why the merge path is safe
    // without one.
    //
    // Ordering — this must run BEFORE the tickets UPDATE, and that is a lock
    // requirement, not a correctness one (the WHERE never reads `tickets`, and
    // the plain FK cannot 23503 either way). breeze_cascade_device_org_id()
    // severs ai_agent_runs FIRST and only then re-stamps its child tables, of
    // which `tickets` is one, so the device axis takes ai_agent_runs BEFORE
    // tickets. Taking them the other way round here would give a concurrent
    // device-move and ticket-move over the same device-linked ticket a circular
    // wait (each holding the lock the other needs) and one of them would die
    // with 40P01. Matching the device axis's order is what keeps the pair
    // consistent — see the global lock-order note at the top of this
    // transaction.
    await tx
      .update(aiAgentRuns)
      .set({ ticketId: null })
      .where(eq(aiAgentRuns.ticketId, ticketId));
    // The UPDATE takes the ticket row lock; the currency guard then locks the
    // unbilled monetary children, and the org_id rewrites follow. A throw here
    // rolls this UPDATE back — nothing moves on a block.
    // `requesterContactId: null` (#3258 W03 final review C1) is part of THIS
    // statement, not a follow-up: `tickets_requester_contact_org_fk` is the
    // composite (requester_contact_id, org_id) -> contacts(id, org_id), and it
    // is DEFERRABLE INITIALLY IMMEDIATE with no `SET CONSTRAINTS ... DEFERRED`
    // in this transaction — so it is checked the instant this UPDATE finishes.
    // A contact-linked ticket moved to another org would 23503 here, and
    // permanently: contacts are org-pinned and the requester does NOT move with
    // the ticket. Detaching is the same ruling as `deviceId: null` beside it —
    // the person stays with their organization, and the ticket keeps the
    // submitter name/email SNAPSHOT, so "who filed this" survives the move even
    // though the link to the live contact row does not.
    const [row] = await tx
      .update(tickets)
      .set({ orgId: targetOrgId, deviceId: null, requesterContactId: null, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId))
      .returning();
    updated = row;
    // #4524, reverse direction: ticket_comments has no org_id (child-via-parent
    // tenancy — see the TICKET_ORG_DENORMALIZED_TABLES comment above), so every
    // comment on this ticket travels into the target org while the run that
    // authored it stays behind. A retained agent_run_id would then name a
    // source-org run from a target-org row — the same reverse-pointer class
    // #3828 fixed for metric_anomaly_incidents.agent_run_id on the device axis,
    // just the other end of this ticket's link.
    //
    // Placement: after the ticket UPDATE, where ticket_comments' UPDATE policy
    // (breeze_ticket_parent_update) EXISTS-joins the parent ticket's now-TARGET
    // org_id. Running it earlier would also work — every caller holds access to
    // both orgs for the whole transaction, so the source-org join would pass
    // too — so this is placement for readability, not a constraint. There is no
    // lock-order concern either way: the device axis never touches
    // ticket_comments.
    //
    // Only the cross-org link is dropped: origin_principal_kind is untouched,
    // and that (not agent_run_id) is what the helpdesk loop guard keys on when
    // it refuses to re-admit non-user content, so severing here cannot open a
    // feedback loop. Nulling also drops the row out of the partial unique index
    // ticket_comments_one_ai_note_per_run_uq, whose predicate requires
    // agent_run_id IS NOT NULL, so it can never collide.
    //
    // Scope note: the DEVICE axis has this same reverse-pointer gap — a device
    // org-move re-stamps its tickets (tickets is in
    // breeze_device_child_orgid_tables()) and their comments travel along while
    // the runs stay put — and it is NOT closed here, because closing it means a
    // new migration replacing breeze_cascade_device_org_id(). Neither axis leaks
    // today: nothing writes agent_run_id yet (the autonomous-note lane is
    // deferred; see the column comment in db/schema/portal.ts). Tracked in #4644
    // so the contract is in place before that lane ships.
    await tx
      .update(ticketComments)
      .set({ agentRunId: null })
      .where(and(eq(ticketComments.ticketId, ticketId), isNotNull(ticketComments.agentRunId)));
    guard = await assertTicketMoveCurrencyCompatible(tx, {
      ticketIds: [ticketId],
      sourceCurrency: sourceOrg.currencyCode,
      targetCurrency: targetOrg.currencyCode,
      targetOrgName: targetOrg.name,
      acceptCurrencyMismatch: opts.acceptCurrencyMismatch === true
    });
    // SET org_id only — currency_code snapshots are never touched by a move.
    for (const table of TICKET_ORG_DENORMALIZED_TABLES) {
      await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid WHERE ticket_id = ${ticketId}::uuid`
      );
    }
    const strandedCount = guard?.accepted ? guard.unbilledTimeEntries + guard.unbilledParts : 0;
    // System feed entry on the moved ticket.
    await tx.insert(ticketComments).values({
      ticketId,
      userId: actor.userId,
      authorName: actor.name ?? null,
      authorType: 'internal',
      commentType: 'system',
      content: `Moved to ${targetOrg.name}` + (strandedCount > 0
        ? ` — ${strandedCount} unbilled items stay in ${sourceOrg.currencyCode}`
        : ''),
      isPublic: false
    });
  });
  if (!updated) throw new TicketServiceError('Ticket not found', 404);

  await emitTicketEvent({
    type: 'ticket.updated',
    ticketId,
    orgId: targetOrgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { changed: ['orgId'] }
  });
  // Audit on BOTH orgs so the move shows in source and target feeds (device precedent).
  // (Cast: TS narrows the closure-assigned `let` to its initial null.)
  const accepted = guard as MoveCurrencyGuardDetails | null;
  const details = {
    fromOrgId: ticket.orgId,
    toOrgId: targetOrgId,
    detachedDeviceId: ticket.deviceId ?? null,
    ...(accepted?.accepted ? { currencyMismatchAccepted: accepted } : {})
  };
  await createAuditLogAsync({ orgId: ticket.orgId, actorId: actor.userId, action: 'ticket.move_org.source', resourceType: 'ticket', resourceId: ticketId, details, result: 'success' });
  await createAuditLogAsync({ orgId: targetOrgId, actorId: actor.userId, action: 'ticket.move_org.target', resourceType: 'ticket', resourceId: ticketId, details, result: 'success' });
  return updated;
}

/**
 * Checks whether a portal customer may still edit or delete their own comment.
 * The window closes once any later comment on the ticket has authorType !== 'portal'
 * (i.e. a staff member or system event has acted on the ticket after this comment).
 */
export async function portalCommentMutable(
  commentId: string,
  portalUserId: string
): Promise<{ ok: boolean; reason?: 'not_found' | 'not_author' | 'staff_replied' }> {
  const rows = await db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.id, commentId))
    .limit(1);
  const comment = rows[0];
  if (!comment || comment.deletedAt) return { ok: false, reason: 'not_found' };
  if (comment.portalUserId !== portalUserId) return { ok: false, reason: 'not_author' };

  // Single query: select authorType for all later comments on this ticket.
  // If any has authorType !== 'portal' the edit window is closed.
  // Deleted later comments still close the window — staff acted, then withdrew.
  const laterRows = await db
    .select({ authorType: ticketComments.authorType })
    .from(ticketComments)
    .where(and(
      eq(ticketComments.ticketId, comment.ticketId),
      gt(ticketComments.createdAt, comment.createdAt)
    ))
    .limit(50);
  if (laterRows.some((r) => r.authorType !== 'portal')) {
    return { ok: false, reason: 'staff_replied' };
  }
  return { ok: true };
}
