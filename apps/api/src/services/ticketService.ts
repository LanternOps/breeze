import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tickets, ticketComments, ticketAlertLinks, organizations, alerts, devices, users, ticketCategories, portalUsers, ticketStatusEnum, ticketSourceEnum } from '../db/schema';
import { allocateInternalTicketNumber } from './ticketNumbers';
import { emitTicketEvent } from './ticketEvents';
import { createAuditLogAsync } from './auditService';
import { resolveSlaTargets } from './ticketSla';
import { getOrgSlaOverride, getPartnerPrioritySla, getSystemStatusId, getTicketStatusById } from './ticketConfigService';
import { emitTicketTriageFeedback } from './mlFeedbackEmitters';
import { applyIntakeForm, getTicketFormForOrg, TicketFormError } from './ticketFormService';

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
  | 'CATEGORY_NOT_FOUND'
  | 'CATEGORY_WRONG_PARTNER'
  | 'TICKET_PARTNER_UNRESOLVABLE'
  | 'INVALID_TRANSITION'
  | 'CONCURRENT_MODIFICATION'
  | 'STATUS_NOT_FOUND'
  | 'STATUS_INACTIVE'
  | 'INVALID_INPUT';

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
): Promise<{ id: string; orgId: string; name: string | null; email: string } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: portalUsers.id, orgId: portalUsers.orgId, name: portalUsers.name, email: portalUsers.email })
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
  // backfills name/email) and/or free text; otherwise the acting staff member's
  // name is stamped with NO email (preserves "no external requester" semantics —
  // the notify worker emails submitterEmail on every public comment/resolution).
  const isPortalOrEmail = input.source === 'portal' || input.source === 'email';
  let resolvedSubmittedBy: string | null;
  let resolvedSubmitterName: string | null;
  let resolvedSubmitterEmail: string | null;
  if (isPortalOrEmail) {
    resolvedSubmittedBy = input.submittedBy ?? null;
    resolvedSubmitterName = input.submitterName ?? null;
    resolvedSubmitterEmail = input.submitterEmail ?? null;
  } else if (input.submittedBy) {
    const portalUser = await assertRequesterInOrg(input.submittedBy, input.orgId);
    resolvedSubmittedBy = portalUser.id;
    resolvedSubmitterName = input.submitterName ?? portalUser.name ?? null;
    resolvedSubmitterEmail = input.submitterEmail ?? portalUser.email ?? null;
  } else if (input.submitterName || input.submitterEmail) {
    resolvedSubmittedBy = null;
    resolvedSubmitterName = input.submitterName ?? null;
    resolvedSubmitterEmail = input.submitterEmail ?? null;
  } else {
    resolvedSubmittedBy = null;
    resolvedSubmitterName = actor.name ?? null;
    resolvedSubmitterEmail = null;
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
    payload: { internalNumber, subject, assigneeId: input.assigneeId ?? null, source: input.source }
  });
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
}

export interface ChangeStatusTarget {
  status?: TicketStatus;
  statusId?: string;
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

  // No-op: same core status AND same statusId
  if (toStatus === fromStatus && resolvedStatusId === ticket.statusId) return ticket;

  // Same core status but different statusId — update statusId only (skip FSM validation)
  if (toStatus === fromStatus) {
    const now = new Date();
    const patch: Partial<typeof tickets.$inferInsert> = { statusId: resolvedStatusId ?? null, updatedAt: now };
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
    // Only write a feed entry when there is meaningful content — i.e. the caller
    // supplied a custom status name (statusId path).  A legacy {status} call that
    // happens to resolve to the same core value but swaps the statusId back to the
    // system row produces an empty content and identical oldValue/newValue, which
    // would be a no-op noise row in the feed.
    if (customStatusName) {
      await db.insert(ticketComments).values({
        ticketId,
        userId: actor.userId,
        authorName: actor.name ?? null,
        authorType: 'internal',
        commentType: 'status_change',
        content: customStatusName,
        isPublic: false,
        oldValue: fromStatus,
        newValue: toStatus
      });
    }
    // Do NOT emit ticket.status_changed — core status is unchanged; only the
    // custom-status label (statusId) differs.  Emitting with identical from/to
    // would produce noise and confuse downstream consumers.
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
  if (toStatus === 'resolved' && !opts.resolutionNote) {
    throw new TicketServiceError('A resolution note is required to resolve a ticket', 400);
  }

  const now = new Date();
  const patch: Partial<typeof tickets.$inferInsert> = { status: toStatus, statusId: resolvedStatusId ?? null, updatedAt: now };

  if (toStatus === 'resolved') {
    patch.resolvedAt = ticket.resolvedAt ?? now;
    patch.resolutionNote = opts.resolutionNote;
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

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'status_change',
    content: opts.resolutionNote ?? opts.pendingReason ?? customStatusName ?? '',
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
    payload: { from: fromStatus, to: toStatus, resolutionNote: opts.resolutionNote ?? null }
  });
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
  const requesterPatch: { submittedBy?: string | null; submitterName?: string | null; submitterEmail?: string | null } = {};
  if (requesterEdit) {
    if (typeof fields.submittedBy === 'string') {
      const portalUser = await assertRequesterInOrg(fields.submittedBy, ticket.orgId);
      requesterPatch.submittedBy = portalUser.id;
      requesterPatch.submitterName = fields.submitterName !== undefined ? fields.submitterName : (portalUser.name ?? null);
      requesterPatch.submitterEmail = fields.submitterEmail !== undefined ? fields.submitterEmail : (portalUser.email ?? null);
    } else {
      if (fields.submittedBy === null) requesterPatch.submittedBy = null;
      if (fields.submitterName !== undefined) requesterPatch.submitterName = fields.submitterName;
      if (fields.submitterEmail !== undefined) requesterPatch.submitterEmail = fields.submitterEmail;
    }
  }
  const tRow = ticket as Record<string, unknown>;
  const requesterChanged =
    ('submittedBy' in requesterPatch && (requesterPatch.submittedBy ?? null) !== (tRow.submittedBy ?? null)) ||
    ('submitterName' in requesterPatch && (requesterPatch.submitterName ?? null) !== (tRow.submitterName ?? null)) ||
    ('submitterEmail' in requesterPatch && (requesterPatch.submitterEmail ?? null) !== (tRow.submitterEmail ?? null));

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
}

export async function addTicketComment(ticketId: string, input: AddCommentInput, actor: TicketActor) {
  const ticket = await getTicketOrThrow(ticketId);

  const inserted = await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: input.isPublic ? 'comment' : 'internal',
    content: input.content,
    isPublic: input.isPublic
  }).returning();
  const comment = inserted[0];
  if (!comment) throw new TicketServiceError('Failed to add comment', 500);

  // First PUBLIC technician response stamps firstResponseAt (spec §2).
  // Internal notes do NOT stamp it.
  let firstResponseStamped = false;
  if (input.isPublic && !ticket.firstResponseAt) {
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
    payload: { commentId: comment.id, isPublic: input.isPublic }
  });
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

  return { comment, firstResponseStamped };
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
const TICKET_ORG_DENORMALIZED_TABLES = ['time_entries', 'ticket_parts', 'ticket_alert_links'] as const;

/**
 * Reassigns a ticket to another organization of the SAME partner.
 * - Detaches any linked device (device belongs to the source org).
 * - Re-stamps org_id on all denormalized child tables.
 * - Writes a system feed comment and dual-org audit log entries.
 * - Emits ticket.updated.
 * Rejects cross-partner moves with 400; unknown target with 404; same-org is a no-op.
 */
export async function moveTicketOrg(ticketId: string, targetOrgId: string, actor: TicketActor): Promise<typeof tickets.$inferSelect> {
  const ticket = await getTicketOrThrow(ticketId);
  if (ticket.orgId === targetOrgId) return ticket;

  const orgRows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId, name: organizations.name })
    .from(organizations)
    .where(sql`${organizations.id} IN (${ticket.orgId}::uuid, ${targetOrgId}::uuid)`)
    .limit(2);
  const sourceOrg = orgRows.find((r) => r.id === ticket.orgId);
  const targetOrg = orgRows.find((r) => r.id === targetOrgId);
  if (!targetOrg) throw new TicketServiceError('Target organization not found', 404);
  if (!sourceOrg || sourceOrg.partnerId !== targetOrg.partnerId) {
    throw new TicketServiceError('Tickets can only be moved between organizations of the same partner', 400);
  }

  let updated: typeof tickets.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(tickets)
      .set({ orgId: targetOrgId, deviceId: null, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId))
      .returning();
    updated = row;
    for (const table of TICKET_ORG_DENORMALIZED_TABLES) {
      await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid WHERE ticket_id = ${ticketId}::uuid`
      );
    }
    // System feed entry on the moved ticket.
    await tx.insert(ticketComments).values({
      ticketId,
      userId: actor.userId,
      authorName: actor.name ?? null,
      authorType: 'internal',
      commentType: 'system',
      content: `Moved to ${targetOrg.name}`,
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
  const details = { fromOrgId: ticket.orgId, toOrgId: targetOrgId, detachedDeviceId: ticket.deviceId ?? null };
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
