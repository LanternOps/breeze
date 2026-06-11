import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tickets, ticketComments, ticketAlertLinks, organizations, alerts, devices, users, ticketCategories, ticketStatusEnum, ticketSourceEnum } from '../db/schema';
import { allocateInternalTicketNumber } from './ticketNumbers';
import { emitTicketEvent } from './ticketEvents';
import { createAuditLogAsync } from './auditService';
import { resolveSlaTargets } from './ticketSla';

export type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];
export type TicketSource = (typeof ticketSourceEnum.enumValues)[number];

// Lifecycle per spec §2 (docs/superpowers/specs/2026-06-09-native-ticketing-design.md). Closed/resolved reopen only to 'open'; any active status can short-circuit to resolved/closed.
export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['open', 'pending', 'on_hold', 'resolved', 'closed'],
  open: ['pending', 'on_hold', 'resolved', 'closed'],
  pending: ['open', 'on_hold', 'resolved', 'closed'],
  on_hold: ['open', 'pending', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open']
};

export type TicketServiceErrorStatus = 400 | 404 | 409 | 500;

/**
 * Machine-readable error codes for callers that aggregate outcomes (e.g. the
 * bulk route's skippedReasons tally) instead of surfacing the message string.
 */
export type TicketServiceErrorCode =
  | 'ASSIGNEE_NOT_FOUND'
  | 'ASSIGNEE_WRONG_PARTNER'
  | 'CATEGORY_NOT_FOUND'
  | 'CATEGORY_WRONG_PARTNER'
  | 'TICKET_PARTNER_UNRESOLVABLE'
  | 'INVALID_TRANSITION'
  | 'CONCURRENT_MODIFICATION';

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
 * Tenant guard: a ticket's category must belong to the ticket's partner.
 * The read runs in a system-scope DB context for the same reason as
 * getAssigneeForValidation: ticket_categories is partner-axis RLS, invisible
 * to org-scoped request contexts — the explicit partner comparison below is
 * the security boundary, not the read.
 */
async function assertCategoryInPartner(categoryId: string, partnerId: string | null) {
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
  subject: string;
  description?: string;
  deviceId?: string;
  categoryId?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  dueDate?: Date;
  assigneeId?: string;
}

// portal source carries the requester; the worker emails submitterEmail on public replies/resolution.
export type CreateTicketInput =
  | (BaseCreateTicketInput & { source: 'portal'; submittedBy: string; submitterEmail: string; submitterName?: string })
  | (BaseCreateTicketInput & { source: Exclude<TicketSource, 'portal'> });

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

  let category: Awaited<ReturnType<typeof assertCategoryInPartner>> | null = null;
  if (input.categoryId) {
    category = await assertCategoryInPartner(input.categoryId, org.partnerId);
  }

  const slaTargets = resolveSlaTargets({
    categoryResponseMinutes: category?.responseSlaMinutes ?? null,
    categoryResolutionMinutes: category?.resolutionSlaMinutes ?? null,
    priority: input.priority ?? 'normal'
  });

  const internalNumber = await allocateInternalTicketNumber(org.partnerId);

  const isPortal = input.source === 'portal';
  const insertValues = {
    orgId: input.orgId,
    partnerId: org.partnerId,
    ticketNumber: generateLegacyTicketNumber(),
    internalNumber,
    subject: input.subject,
    description: input.description ?? null,
    deviceId: input.deviceId ?? null,
    categoryId: input.categoryId ?? null,
    priority: input.priority ?? 'normal',
    dueDate: input.dueDate ?? null,
    assignedTo: input.assigneeId ?? null,
    status: (input.assigneeId ? 'open' : 'new') as typeof tickets.$inferInsert['status'],
    source: input.source,
    submittedBy: isPortal ? input.submittedBy : null,
    // Non-portal tickets show the acting user as the requester NAME only (fixes
    // "Unknown" requester in the UI). submitterEmail deliberately stays null for
    // non-portal sources: the notify worker emails submitterEmail on every public
    // comment/resolution with portal-oriented copy and no self-actor suppression,
    // so staff-created tickets must keep "no external requester" semantics.
    submitterEmail: isPortal ? input.submitterEmail : null,
    submitterName: isPortal ? (input.submitterName ?? null) : (actor.name ?? null),
    category: null,
    responseSlaMinutes: slaTargets.responseMinutes,
    resolutionSlaMinutes: slaTargets.resolutionMinutes
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
    payload: { internalNumber, subject: input.subject, assigneeId: input.assigneeId ?? null, source: input.source }
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

export async function changeTicketStatus(
  ticketId: string,
  toStatus: TicketStatus,
  opts: ChangeStatusOptions,
  actor: TicketActor
) {
  const ticket = await getTicketOrThrow(ticketId);
  const fromStatus = ticket.status as TicketStatus;

  if (fromStatus === toStatus) return ticket;
  if (!TICKET_STATUS_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    throw new TicketServiceError(`Cannot transition ticket from ${fromStatus} to ${toStatus}`, 409, 'INVALID_TRANSITION');
  }
  if (toStatus === 'resolved' && !opts.resolutionNote) {
    throw new TicketServiceError('A resolution note is required to resolve a ticket', 400);
  }

  const now = new Date();
  const patch: Partial<typeof tickets.$inferInsert> = { status: toStatus, updatedAt: now };

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
    content: opts.resolutionNote ?? opts.pendingReason ?? '',
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
  deviceId?: string | null;
  tags?: string[];
}

/** Humanized labels for the system feed entry, in canonical field order. */
const UPDATE_FIELD_LABELS: Record<keyof UpdateTicketFieldsInput, string> = {
  subject: 'subject',
  description: 'description',
  categoryId: 'category',
  priority: 'priority',
  dueDate: 'due date',
  deviceId: 'device',
  tags: 'tags'
};

function ticketFieldChanged(key: keyof UpdateTicketFieldsInput, oldValue: unknown, newValue: unknown): boolean {
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
    await assertCategoryInPartner(fields.categoryId, await resolveTicketPartnerId(ticket));
  }

  // Compute the actually-changed fields; ignore no-op keys so the feed and
  // event stream don't accumulate noise from idempotent saves.
  const changed: (keyof UpdateTicketFieldsInput)[] = [];
  for (const key of Object.keys(UPDATE_FIELD_LABELS) as (keyof UpdateTicketFieldsInput)[]) {
    if (fields[key] === undefined) continue;
    if (ticketFieldChanged(key, (ticket as Record<string, unknown>)[key], fields[key])) {
      changed.push(key);
    }
  }
  if (changed.length === 0) return ticket;

  const patch: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };
  for (const key of changed) {
    (patch as Record<string, unknown>)[key] = fields[key] ?? null;
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
    content: `Updated ${changed.map((k) => UPDATE_FIELD_LABELS[k]).join(', ')}`,
    isPublic: false
  });

  await emitTicketEvent({
    type: 'ticket.updated',
    ticketId,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { changed }
  });
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.update',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { changed },
    result: 'success'
  });
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
