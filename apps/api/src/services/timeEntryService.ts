import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { timeEntries, ticketParts, tickets, ticketCategories, organizations, users, ticketComments } from '../db/schema';
import { emitTimeEntryEvent } from './timeEntryEvents';
import { getOrgBillingDefaults } from './ticketConfigService';
import { isPgUniqueViolation } from '../utils/pgErrors';
import type { CreateTimeEntryInput, UpdateTimeEntryInput, TicketPartInput, BillingStatus } from '@breeze/shared';

export type TimeEntryServiceErrorCode =
  | 'TICKET_NOT_FOUND'
  | 'TICKET_WRONG_PARTNER'
  | 'TICKET_ORG_DENIED'
  | 'ENTRY_NOT_FOUND'
  | 'PART_NOT_FOUND'
  | 'NOT_OWN_ENTRY'
  | 'ADMIN_REQUIRED'
  | 'APPROVED_IMMUTABLE'
  | 'NO_RUNNING_TIMER'
  | 'ENTRY_RUNNING'
  | 'PARTNER_UNRESOLVABLE'
  | 'INVALID_RANGE';

export class TimeEntryServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400,
    public code?: TimeEntryServiceErrorCode
  ) {
    super(message);
    this.name = 'TimeEntryServiceError';
  }
}

export interface TimeEntryActor {
  userId: string;
  name?: string;
  email?: string;
  /** auth.partnerId — null only for system scope */
  partnerId: string | null;
  /** wildcard-permission holders (computed in routes): may manage others' entries + approve */
  manageAll: boolean;
  /**
   * auth.accessibleOrgIds — the org-axis allowlist. `null` = system scope
   * (unrestricted). A partner user with orgAccess='selected' carries only the
   * granted org ids here, so a ticket in a non-granted org under the same
   * partner is denied (org-axis check in resolveTicketLink). Threaded from the
   * route's AuthContext so the system-context ticket read can't be used to
   * write onto a ticket the caller can't actually see.
   */
  accessibleOrgIds: string[] | null;
}

/** Floored whole minutes — matches the SLA pause-folding convention. */
export function computeDurationMinutes(startedAt: Date, endedAt: Date): number {
  return Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000);
}

const toRate = (rate: number | null | undefined): string | null =>
  rate == null ? null : rate.toFixed(2);

interface TicketForTimeTracking {
  id: string;
  partnerId: string | null;
  orgId: string;
  categoryId: string | null;
}

// System-context read: org-scoped RLS would hide cross-boundary rows during
// validation (ticketService.ts / PR #1243 lesson).
async function getTicketForTimeTracking(ticketId: string): Promise<TicketForTimeTracking> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: tickets.id, partnerId: tickets.partnerId, orgId: tickets.orgId, categoryId: tickets.categoryId })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1)
    )
  );
  const ticket = rows[0];
  if (!ticket) throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  return ticket;
}

async function resolveTicketPartner(ticket: TicketForTimeTracking): Promise<string | null> {
  if (ticket.partnerId) return ticket.partnerId;
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, ticket.orgId))
        .limit(1)
    )
  );
  return rows[0]?.partnerId ?? null;
}

async function getCategoryDefaults(categoryId: string): Promise<{ defaultBillable: boolean; defaultHourlyRate: string | null } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketCategories.id,
          partnerId: ticketCategories.partnerId,
          defaultBillable: ticketCategories.defaultBillable,
          defaultHourlyRate: ticketCategories.defaultHourlyRate
        })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, categoryId))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

/**
 * Validates a ticket link for the acting partner AND org axis, then resolves
 * billing defaults (spec D2: category default + manual override). Returns the
 * denormalization payload for the time-entry/part row.
 *
 * The ticket is read under system scope (see getTicketForTimeTracking), so the
 * request's org-axis RLS does NOT gate it. We therefore re-apply the caller's
 * org-axis allowlist here: a partner user with orgAccess='selected' can target
 * only tickets in granted orgs, never an arbitrary org under the same partner.
 * `accessibleOrgIds === null` is system scope (unrestricted) — behavior
 * unchanged. Mirrors getScopedTicketOr404 / auth.canAccessOrg semantics.
 */
async function resolveTicketLink(ticketId: string, actor: TimeEntryActor) {
  const ticket = await getTicketForTimeTracking(ticketId);
  const ticketPartnerId = await resolveTicketPartner(ticket);
  if (!ticketPartnerId) {
    throw new TimeEntryServiceError('Ticket partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  }
  if (actor.partnerId && ticketPartnerId !== actor.partnerId) {
    throw new TimeEntryServiceError('Ticket must belong to the same partner', 400, 'TICKET_WRONG_PARTNER');
  }
  // Org-axis gate: non-system callers must have access to the ticket's org.
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(ticket.orgId)) {
    throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_ORG_DENIED');
  }
  const [org, category] = await Promise.all([
    getOrgBillingDefaults(ticket.orgId),
    ticket.categoryId ? getCategoryDefaults(ticket.categoryId) : Promise.resolve(null)
  ]);
  return {
    ticket,
    partnerId: ticketPartnerId,
    // D6: per-entry explicit override (applied by callers) → org default → category default → false/null
    defaultBillable: org?.defaultBillable ?? category?.defaultBillable ?? false,
    defaultHourlyRate: org?.defaultHourlyRate ?? category?.defaultHourlyRate ?? null
  };
}

/** "45m", "1h 30m", "2h" — shared wording for feed comments. */
function fmtMinutes(minutes: number | null): string {
  const m = Math.max(0, minutes ?? 0);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** D4: internal-only system feed line; never isPublic. No-op without a ticket.
 *  Swallows insert errors so a failed comment never rolls back a committed mutation. */
async function insertTimeEntryFeedComment(
  ticketId: string | null,
  actor: TimeEntryActor,
  content: string
): Promise<void> {
  if (!ticketId) return;
  try {
    await db.insert(ticketComments).values({
      ticketId,
      userId: actor.userId,
      authorName: actor.name ?? null,
      authorType: 'internal',
      commentType: 'time_entry',
      content,
      isPublic: false,
      oldValue: null,
      newValue: null
    });
  } catch (err) {
    console.error('[timeEntryService] feed comment insert failed', err);
  }
}

export async function createTimeEntry(input: CreateTimeEntryInput, actor: TimeEntryActor) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let defaultBillable = false;
  let defaultRate: string | null = null;

  if (input.ticketId) {
    const link = await resolveTicketLink(input.ticketId, actor);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    defaultBillable = link.defaultBillable;
    defaultRate = link.defaultHourlyRate;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  }

  if (input.endedAt.getTime() <= input.startedAt.getTime()) {
    throw new TimeEntryServiceError('endedAt must be after startedAt', 400, 'INVALID_RANGE');
  }

  const rows = await db
    .insert(timeEntries)
    .values({
      partnerId,
      orgId,
      ticketId: input.ticketId ?? null,
      userId: actor.userId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),
      description: input.description ?? null,
      // D2: apply category defaults only when input omits the field
      isBillable: input.isBillable !== undefined ? input.isBillable : defaultBillable,
      hourlyRate: input.hourlyRate !== undefined ? toRate(input.hourlyRate) : defaultRate,
      billingStatus: input.billingStatus ?? 'not_billed'
    })
    .returning();
  const entry = rows[0]!;

  await insertTimeEntryFeedComment(
    entry.ticketId,
    actor,
    `${actor.name ?? 'Technician'} logged ${fmtMinutes(entry.durationMinutes)}${entry.isBillable ? ' (billable)' : ''}`
  );

  await emitTimeEntryEvent({
    type: 'time_entry.created',
    timeEntryId: entry.id,
    partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: {
      userId: actor.userId,
      durationMinutes: entry.durationMinutes,
      isBillable: entry.isBillable
    }
  });
  return entry;
}

/** Stops the actor's running entry if any (CAS on ended_at IS NULL). Returns the stopped row or null. */
async function stopRunningEntry(
  actor: TimeEntryActor,
  overrides: { description?: string; isBillable?: boolean } = {}
) {
  const now = new Date();
  // CAS on ended_at IS NULL: two concurrent stops -> one winner, one no-op.
  // Duration computed in SQL from the row's own started_at (avoids a pre-select round-trip).
  const rows = await db
    .update(timeEntries)
    .set({
      endedAt: now,
      durationMinutes: sql`FLOOR(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamp - ${timeEntries.startedAt})) / 60)::int`,
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      ...(overrides.isBillable !== undefined ? { isBillable: overrides.isBillable } : {})
    })
    .where(and(eq(timeEntries.userId, actor.userId), isNull(timeEntries.endedAt)))
    .returning();
  return rows[0] ?? null;
}

// Unwraps the DrizzleQueryError `.cause` so the retry/409 path actually fires
// (a bare `err.code` check missed every wrapped insert). See utils/pgErrors.
const isUniqueViolation = (err: unknown): boolean => isPgUniqueViolation(err);

export async function startTimer(input: { ticketId?: string; description?: string }, actor: TimeEntryActor) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let defaultBillable = false;
  let defaultRate: string | null = null;

  if (input.ticketId) {
    const link = await resolveTicketLink(input.ticketId, actor);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    defaultBillable = link.defaultBillable;
    defaultRate = link.defaultHourlyRate;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  }

  const attempt = async () => {
    // D3: auto-stop the previous timer, then start the new one. The partial
    // unique index time_entries_one_running_per_user_uq is the race backstop.
    const autoStopped = await stopRunningEntry(actor);
    if (autoStopped) {
      await insertTimeEntryFeedComment(
        autoStopped.ticketId,
        actor,
        `${actor.name ?? 'Technician'} logged ${fmtMinutes(autoStopped.durationMinutes)}${autoStopped.isBillable ? ' (billable)' : ''}`
      );
    }
    const rows = await db
      .insert(timeEntries)
      .values({
        partnerId: partnerId!,
        orgId,
        ticketId: input.ticketId ?? null,
        userId: actor.userId,
        startedAt: new Date(),
        endedAt: null,
        durationMinutes: null,
        description: input.description ?? null,
        isBillable: defaultBillable,
        hourlyRate: defaultRate,
        billingStatus: 'not_billed'
      })
      .returning();
    return rows[0]!;
  };

  let entry: typeof timeEntries.$inferSelect;
  try {
    entry = await attempt();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost the race: another start slipped in — stop it and retry once.
    console.error('[timeEntryService.startTimer] unique violation, retrying once', err instanceof Error ? err.message : err);
    try {
      entry = await attempt();
    } catch (retryErr) {
      if (isUniqueViolation(retryErr)) {
        throw new TimeEntryServiceError('Timer start conflicted with a concurrent request — try again', 409, 'ENTRY_RUNNING');
      }
      throw retryErr;
    }
  }

  await emitTimeEntryEvent({
    type: 'time_entry.created',
    timeEntryId: entry.id,
    partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: { userId: actor.userId, durationMinutes: null, isBillable: entry.isBillable }
  });
  return entry;
}

export async function stopTimer(input: { description?: string; isBillable?: boolean }, actor: TimeEntryActor) {
  const stopped = await stopRunningEntry(actor, input);
  if (!stopped) {
    throw new TimeEntryServiceError('No running timer', 404, 'NO_RUNNING_TIMER');
  }

  await insertTimeEntryFeedComment(
    stopped.ticketId,
    actor,
    `${actor.name ?? 'Technician'} logged ${fmtMinutes(stopped.durationMinutes)}${stopped.isBillable ? ' (billable)' : ''}`
  );

  await emitTimeEntryEvent({
    type: 'time_entry.updated',
    timeEntryId: stopped.id,
    partnerId: stopped.partnerId,
    ticketId: stopped.ticketId,
    actorUserId: actor.userId,
    payload: { changed: ['endedAt', 'durationMinutes'] }
  });
  return stopped;
}

// ── Update / Delete ──────────────────────────────────────────────────────

/**
 * Org-axis SQL predicate for the partner-axis `time_entries` table. RLS scopes
 * this table by partner only (Shape 3) — a partner user with orgAccess='selected'
 * is NOT confined to their granted orgs by RLS, so the org allowlist must be
 * applied at the app layer (mirrors resolveTicketLink's existing check, which
 * only fires on the ticket-link path). `null` accessibleOrgIds = system scope
 * (no filter). Null-org (unlinked) entries carry no org to leak and stay in
 * scope. (#sec-review-1)
 */
function orgAxisSql(accessibleOrgIds: string[] | null): SQL | undefined {
  if (accessibleOrgIds === null) return undefined;
  if (accessibleOrgIds.length === 0) return isNull(timeEntries.orgId);
  return or(isNull(timeEntries.orgId), inArray(timeEntries.orgId, accessibleOrgIds));
}

/** In-memory counterpart of orgAxisSql for an already-fetched row. */
export function entryOrgAllowed(entry: { orgId: string | null }, accessibleOrgIds: string[] | null): boolean {
  if (accessibleOrgIds === null) return true;
  if (entry.orgId === null) return true;
  return accessibleOrgIds.includes(entry.orgId);
}

async function getEntryOr404(id: string, actor: TimeEntryActor) {
  // RLS (partner-axis) scopes this read to the actor's partner; the org-axis
  // allowlist is enforced here because RLS does not constrain it.
  const rows = await db.select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
  const entry = rows[0];
  if (!entry) throw new TimeEntryServiceError('Time entry not found', 404, 'ENTRY_NOT_FOUND');
  if (!entryOrgAllowed(entry, actor.accessibleOrgIds)) {
    throw new TimeEntryServiceError('Time entry not found', 404, 'ENTRY_NOT_FOUND');
  }
  return entry;
}

function assertCanMutate(entry: { userId: string; isApproved: boolean }, actor: TimeEntryActor) {
  if (entry.userId !== actor.userId && !actor.manageAll) {
    throw new TimeEntryServiceError('You can only manage your own time entries', 403, 'NOT_OWN_ENTRY');
  }
  if (entry.isApproved && !actor.manageAll) {
    throw new TimeEntryServiceError('Approved entries can only be changed by an approver', 403, 'APPROVED_IMMUTABLE');
  }
}

export async function updateTimeEntry(id: string, input: UpdateTimeEntryInput, actor: TimeEntryActor) {
  const entry = await getEntryOr404(id, actor);
  assertCanMutate(entry, actor);

  const startedAt = input.startedAt ?? entry.startedAt;
  const endedAt = input.endedAt !== undefined ? input.endedAt : entry.endedAt;
  if (endedAt && endedAt.getTime() <= startedAt.getTime()) {
    throw new TimeEntryServiceError('endedAt must be after startedAt', 400, 'INVALID_RANGE');
  }

  const set: Record<string, unknown> = {};
  const changed: string[] = [];
  if (input.startedAt !== undefined) { set.startedAt = input.startedAt; changed.push('startedAt'); }
  if (input.endedAt !== undefined) { set.endedAt = input.endedAt; changed.push('endedAt'); }
  if (input.description !== undefined) { set.description = input.description; changed.push('description'); }
  if (input.isBillable !== undefined) { set.isBillable = input.isBillable; changed.push('isBillable'); }
  if (input.hourlyRate !== undefined) { set.hourlyRate = toRate(input.hourlyRate); changed.push('hourlyRate'); }
  if (input.billingStatus !== undefined) { set.billingStatus = input.billingStatus; changed.push('billingStatus'); }

  if (input.ticketId !== undefined) {
    if (input.ticketId === null) {
      set.ticketId = null;
      set.orgId = null;
    } else {
      const link = await resolveTicketLink(input.ticketId, actor);
      if (link.partnerId !== entry.partnerId) {
        throw new TimeEntryServiceError('Ticket must belong to the same partner as the time entry', 400, 'TICKET_WRONG_PARTNER');
      }
      set.ticketId = input.ticketId;
      set.orgId = link.ticket.orgId;
    }
    changed.push('ticketId');
  }
  if ((input.startedAt !== undefined || input.endedAt !== undefined) && endedAt) {
    set.durationMinutes = computeDurationMinutes(startedAt, endedAt);
    changed.push('durationMinutes');
  }

  // Spec §3: any edit clears approval — re-approval required, including for approvers.
  set.isApproved = false;
  set.approvedBy = null;
  set.approvedAt = null;

  const rows = await db.update(timeEntries).set(set).where(eq(timeEntries.id, id)).returning();
  const updated = rows[0] ?? entry;

  await emitTimeEntryEvent({
    type: 'time_entry.updated',
    timeEntryId: id,
    partnerId: entry.partnerId,
    ticketId: (updated as typeof entry).ticketId ?? entry.ticketId,
    actorUserId: actor.userId,
    payload: { changed }
  });
  return updated;
}

export async function deleteTimeEntry(id: string, actor: TimeEntryActor) {
  const entry = await getEntryOr404(id, actor);
  assertCanMutate(entry, actor);
  await db.delete(timeEntries).where(eq(timeEntries.id, id));

  await insertTimeEntryFeedComment(
    entry.ticketId,
    actor,
    `${actor.name ?? 'Technician'} removed a${entry.durationMinutes != null ? ` ${fmtMinutes(entry.durationMinutes)}` : ''} time entry`
  );

  await emitTimeEntryEvent({
    type: 'time_entry.deleted',
    timeEntryId: id,
    partnerId: entry.partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: { userId: entry.userId }
  });
}

// ── Approval ─────────────────────────────────────────────────────────────

export interface BulkApproveResult {
  updated: number;
  skipped: number;
  skippedReasons: Partial<Record<TimeEntryServiceErrorCode, number>>;
}

export async function approveTimeEntries(ids: string[], approve: boolean, actor: TimeEntryActor): Promise<BulkApproveResult> {
  if (!actor.manageAll) {
    throw new TimeEntryServiceError('Approving time entries requires an admin role', 403, 'ADMIN_REQUIRED');
  }
  // RLS scopes to the actor's partner — out-of-partner ids look "missing", by
  // design. The org-axis allowlist is applied here too (RLS is partner-axis
  // only), so an orgAccess='selected' admin can't approve entries in a
  // non-granted org under the same partner — those ids also look "missing".
  const orgAxis = orgAxisSql(actor.accessibleOrgIds);
  const candidates = await db
    .select({ id: timeEntries.id, endedAt: timeEntries.endedAt, partnerId: timeEntries.partnerId, ticketId: timeEntries.ticketId })
    .from(timeEntries)
    .where(orgAxis ? and(inArray(timeEntries.id, ids), orgAxis) : inArray(timeEntries.id, ids));

  const found = new Map(candidates.map((c) => [c.id, c]));
  const skippedReasons: Partial<Record<TimeEntryServiceErrorCode, number>> = {};
  const skip = (reason: TimeEntryServiceErrorCode) => { skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1; };
  const eligible: string[] = [];
  for (const id of ids) {
    const row = found.get(id);
    if (!row) { skip('ENTRY_NOT_FOUND'); continue; }
    if (!row.endedAt) { skip('ENTRY_RUNNING'); continue; }
    eligible.push(id);
  }

  let updated: { id: string; partnerId: string; ticketId: string | null }[] = [];
  if (eligible.length > 0) {
    updated = await db
      .update(timeEntries)
      .set(approve
        ? { isApproved: true, approvedBy: actor.userId, approvedAt: new Date() }
        : { isApproved: false, approvedBy: null, approvedAt: null })
      .where(inArray(timeEntries.id, eligible))
      .returning({ id: timeEntries.id, partnerId: timeEntries.partnerId, ticketId: timeEntries.ticketId });
  }

  if (updated.length > 0 && approve) {
    // One lifecycle event represents the bulk approval; payload.ids carries the full approved set.
    await emitTimeEntryEvent({
      type: 'time_entry.approved',
      timeEntryId: updated[0]!.id,
      partnerId: updated[0]!.partnerId,
      ticketId: updated[0]!.ticketId,
      actorUserId: actor.userId,
      payload: { ids: updated.map((u) => u.id), approvedBy: actor.userId }
    });
  }

  return {
    updated: updated.length,
    skipped: ids.length - updated.length,
    skippedReasons
  };
}

// ── Parts ────────────────────────────────────────────────────────────────

export async function addTicketPart(ticketId: string, input: TicketPartInput, actor: TimeEntryActor) {
  const link = await resolveTicketLink(ticketId, actor);
  const rows = await db
    .insert(ticketParts)
    .values({
      ticketId,
      orgId: link.ticket.orgId,
      description: input.description,
      partNumber: input.partNumber ?? null,
      vendor: input.vendor ?? null,
      catalogItemId: input.catalogItemId ?? null,
      quantity: input.quantity.toFixed(2),
      unitPrice: (input.unitPrice ?? 0).toFixed(2),
      costBasis: input.costBasis != null ? input.costBasis.toFixed(2) : null,
      isBillable: input.isBillable ?? link.defaultBillable,
      billingStatus: input.billingStatus ?? 'not_billed',
      addedBy: actor.userId,
      notes: input.notes ?? null
    })
    .returning();
  const part = rows[0];
  if (!part) {
    throw new Error('Failed to create ticket part');
  }
  return part;
}

async function getPartOr404(id: string) {
  const rows = await db.select().from(ticketParts).where(eq(ticketParts.id, id)).limit(1);
  const part = rows[0];
  if (!part) throw new TimeEntryServiceError('Part not found', 404, 'PART_NOT_FOUND');
  return part;
}

export async function updateTicketPart(id: string, input: Partial<TicketPartInput>, _actor: TimeEntryActor) {
  const part = await getPartOr404(id);
  const set: Record<string, unknown> = {};
  if (input.description !== undefined) set.description = input.description;
  if (input.partNumber !== undefined) set.partNumber = input.partNumber;
  if (input.vendor !== undefined) set.vendor = input.vendor;
  if (input.catalogItemId !== undefined) set.catalogItemId = input.catalogItemId;
  if (input.quantity !== undefined) set.quantity = input.quantity.toFixed(2);
  if (input.unitPrice !== undefined) set.unitPrice = input.unitPrice.toFixed(2);
  if (input.costBasis !== undefined) set.costBasis = input.costBasis != null ? input.costBasis.toFixed(2) : null;
  if (input.isBillable !== undefined) set.isBillable = input.isBillable;
  if (input.billingStatus !== undefined) set.billingStatus = input.billingStatus;
  if (input.notes !== undefined) set.notes = input.notes;
  const rows = await db.update(ticketParts).set(set).where(eq(ticketParts.id, id)).returning();
  return rows[0] ?? part;
}

export async function deleteTicketPart(id: string, _actor: TimeEntryActor) {
  await getPartOr404(id);
  await db.delete(ticketParts).where(eq(ticketParts.id, id));
}

// ── Queries ──────────────────────────────────────────────────────────────

export interface ListTimeEntriesFilters {
  userId?: string;
  ticketId?: string;
  orgId?: string;
  /**
   * The caller's org-axis allowlist (auth.accessibleOrgIds). `null`/omitted =
   * system scope (no org filter). For partner scope this confines the
   * partner-axis time_entries list to the caller's granted orgs — RLS does not
   * do it. (#sec-review-1)
   */
  accessibleOrgIds?: string[] | null;
  from?: Date;
  to?: Date;
  running?: boolean;
  billingStatus?: 'not_billed' | 'billed' | 'no_charge' | 'contract';
  approved?: boolean;
  limit: number;
  offset: number;
}

/** Lazy column-selection factory — avoids module-scope Drizzle column derefs
 *  that crash any test file mocking db/schema without a timeEntries stub.
 *  Pattern: portalSettingsColumns() in orgPortalSettings.ts. */
function entrySelection() {
  return {
    id: timeEntries.id,
    partnerId: timeEntries.partnerId,
    orgId: timeEntries.orgId,
    ticketId: timeEntries.ticketId,
    userId: timeEntries.userId,
    startedAt: timeEntries.startedAt,
    endedAt: timeEntries.endedAt,
    durationMinutes: timeEntries.durationMinutes,
    description: timeEntries.description,
    isBillable: timeEntries.isBillable,
    hourlyRate: timeEntries.hourlyRate,
    billingStatus: timeEntries.billingStatus,
    isApproved: timeEntries.isApproved,
    approvedBy: timeEntries.approvedBy,
    approvedAt: timeEntries.approvedAt,
    createdAt: timeEntries.createdAt,
    // decorations (additive, Phase 1b pattern)
    ticketNumber: tickets.internalNumber,
    ticketSubject: tickets.subject,
    userName: users.name
  };
}

function listConditions(filters: ListTimeEntriesFilters) {
  const conditions = [];
  if (filters.userId) conditions.push(eq(timeEntries.userId, filters.userId));
  if (filters.ticketId) conditions.push(eq(timeEntries.ticketId, filters.ticketId));
  if (filters.orgId) conditions.push(eq(timeEntries.orgId, filters.orgId));
  // Org-axis allowlist (partner scope): RLS is partner-axis only, so confine
  // the list to the caller's granted orgs here. Skipped for system scope
  // (accessibleOrgIds null/undefined) and when a specific in-scope orgId is set.
  if (!filters.orgId && filters.accessibleOrgIds != null) {
    const orgAxis = orgAxisSql(filters.accessibleOrgIds);
    if (orgAxis) conditions.push(orgAxis);
  }
  if (filters.from) conditions.push(gte(timeEntries.startedAt, filters.from));
  if (filters.to) conditions.push(lt(timeEntries.startedAt, filters.to));
  if (filters.running !== undefined) {
    conditions.push(filters.running ? isNull(timeEntries.endedAt) : sql`${timeEntries.endedAt} IS NOT NULL`);
  }
  if (filters.billingStatus) conditions.push(eq(timeEntries.billingStatus, filters.billingStatus));
  if (filters.approved !== undefined) conditions.push(eq(timeEntries.isApproved, filters.approved));
  return conditions;
}

export async function listTimeEntries(filters: ListTimeEntriesFilters) {
  const conditions = listConditions(filters);
  const entries = await db
    .select(entrySelection())
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(timeEntries.startedAt))
    .limit(filters.limit)
    .offset(filters.offset);

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(timeEntries)
    .where(conditions.length ? and(...conditions) : undefined);

  return { entries, total: totalRows[0]?.count ?? 0 };
}

export async function getRunningTimer(userId: string) {
  const rows = await db
    .select(entrySelection())
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(eq(timeEntries.userId, userId), isNull(timeEntries.endedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export interface TimesheetDay {
  date: string; // YYYY-MM-DD
  totalMinutes: number;
  billableMinutes: number;
  entries: Awaited<ReturnType<typeof listTimeEntries>>['entries'];
}

export async function getTimesheet(userId: string, weekStart: Date, accessibleOrgIds: string[] | null = null) {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60_000);
  // Org-axis allowlist: time_entries is partner-axis RLS only, so an
  // orgAccess='selected' partner user would otherwise see timesheet entries
  // across all orgs under the partner. Apply the same orgAxisSql predicate used
  // in listConditions / approveTimeEntries. `null` = system scope (no filter).
  // (#sec-review-1)
  const orgAxis = orgAxisSql(accessibleOrgIds);
  const baseCondition = and(
    eq(timeEntries.userId, userId),
    gte(timeEntries.startedAt, weekStart),
    lt(timeEntries.startedAt, weekEnd),
    ...(orgAxis ? [orgAxis] : [])
  );
  const entries = await db
    .select(entrySelection())
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(baseCondition)
    .orderBy(asc(timeEntries.startedAt));

  const days = new Map<string, TimesheetDay>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * 24 * 60 * 60_000);
    const key = d.toISOString().slice(0, 10);
    days.set(key, { date: key, totalMinutes: 0, billableMinutes: 0, entries: [] });
  }
  for (const entry of entries) {
    const key = entry.startedAt.toISOString().slice(0, 10);
    const day = days.get(key);
    if (!day) continue; // boundary rows from TZ edges — still in totals below
    day.entries.push(entry);
    const minutes = entry.durationMinutes ?? 0;
    day.totalMinutes += minutes;
    if (entry.isBillable) day.billableMinutes += minutes;
  }
  const allDays = [...days.values()];
  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    days: allDays,
    totals: {
      totalMinutes: allDays.reduce((s, d) => s + d.totalMinutes, 0),
      billableMinutes: allDays.reduce((s, d) => s + d.billableMinutes, 0)
    }
  };
}

export async function getTicketBillingSummary(ticketId: string) {
  const timeRows = await db
    .select({
      totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)::int`,
      billableMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}) FILTER (WHERE ${timeEntries.isBillable}), 0)::int`,
      billableAmount: sql<string>`COALESCE(SUM((${timeEntries.durationMinutes}::numeric / 60) * ${timeEntries.hourlyRate}) FILTER (WHERE ${timeEntries.isBillable} AND ${timeEntries.hourlyRate} IS NOT NULL), 0)::numeric(12,2)`
    })
    .from(timeEntries)
    .where(eq(timeEntries.ticketId, ticketId));

  const partsRows = await db
    .select({
      partsCount: sql<number>`COUNT(*)::int`,
      billableTotal: sql<string>`COALESCE(SUM(${ticketParts.quantity} * ${ticketParts.unitPrice}) FILTER (WHERE ${ticketParts.isBillable}), 0)::numeric(12,2)`
    })
    .from(ticketParts)
    .where(eq(ticketParts.ticketId, ticketId));

  return {
    time: timeRows[0] ?? { totalMinutes: 0, billableMinutes: 0, billableAmount: '0.00' },
    parts: partsRows[0] ?? { partsCount: 0, billableTotal: '0.00' }
  };
}

interface BillableRowBase {
  date: Date;
  orgName: string | null;
  ticketNumber: string | null;
  description: string | null;
  technician: string | null;
  quantity: string;       // hours for time rows, qty for parts
  rate: string | null;    // hourly rate / unit price
  amount: string;
  billingStatus: BillingStatus;
}

export type BillableRow =
  | (BillableRowBase & { kind: 'time'; isApproved: boolean })
  | (BillableRowBase & { kind: 'part'; isApproved: null });

const toFinite = (v: string | null): number | null => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error('[timeEntryService.listBillables] non-numeric value in DB', v);
    return null;
  }
  return n;
};

export async function listBillables(
  from: Date,
  to: Date,
  orgId?: string,
  accessibleOrgIds?: string[] | null
): Promise<BillableRow[]> {
  // Org-axis allowlist for the partner-axis time_entries half. RLS scopes
  // time_entries by partner only, so without this an orgAccess='selected'
  // partner admin omitting `orgId` would export billing data for every org
  // under the partner. ticket_parts carries a direct org_id and is already
  // org-axis RLS-scoped, but we constrain it too for defense-in-depth.
  // `accessibleOrgIds` null/undefined = system scope (no filter). (#sec-review-1)
  const applyOrgAxis = !orgId && accessibleOrgIds != null;
  const timeConditions = [
    eq(timeEntries.isBillable, true),
    sql`${timeEntries.endedAt} IS NOT NULL`,
    gte(timeEntries.startedAt, from),
    lte(timeEntries.startedAt, to)
  ];
  if (orgId) timeConditions.push(eq(timeEntries.orgId, orgId));
  if (applyOrgAxis) {
    const orgAxis = orgAxisSql(accessibleOrgIds);
    if (orgAxis) timeConditions.push(orgAxis);
  }

  const timeRows = await db
    .select({
      date: timeEntries.startedAt,
      orgName: organizations.name,
      ticketNumber: tickets.internalNumber,
      description: timeEntries.description,
      technician: users.name,
      minutes: timeEntries.durationMinutes,
      rate: timeEntries.hourlyRate,
      billingStatus: timeEntries.billingStatus,
      isApproved: timeEntries.isApproved
    })
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(organizations, eq(timeEntries.orgId, organizations.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(...timeConditions))
    .orderBy(asc(timeEntries.startedAt));

  const partConditions = [
    eq(ticketParts.isBillable, true),
    gte(ticketParts.createdAt, from),
    lte(ticketParts.createdAt, to)
  ];
  if (orgId) partConditions.push(eq(ticketParts.orgId, orgId));
  if (applyOrgAxis && accessibleOrgIds != null) {
    // ticket_parts.org_id is NOT NULL; an empty allowlist matches nothing.
    partConditions.push(inArray(ticketParts.orgId, accessibleOrgIds));
  }

  const partRows = await db
    .select({
      date: ticketParts.createdAt,
      orgName: organizations.name,
      ticketNumber: tickets.internalNumber,
      description: ticketParts.description,
      technician: users.name,
      quantity: ticketParts.quantity,
      unitPrice: ticketParts.unitPrice,
      billingStatus: ticketParts.billingStatus
    })
    .from(ticketParts)
    .leftJoin(tickets, eq(ticketParts.ticketId, tickets.id))
    .leftJoin(organizations, eq(ticketParts.orgId, organizations.id))
    .leftJoin(users, eq(ticketParts.addedBy, users.id))
    .where(and(...partConditions))
    .orderBy(asc(ticketParts.createdAt));

  const rows: BillableRow[] = [];
  for (const r of timeRows) {
    const hours = (r.minutes ?? 0) / 60;
    const rate = toFinite(r.rate);
    rows.push({
      kind: 'time',
      date: r.date,
      orgName: r.orgName,
      ticketNumber: r.ticketNumber,
      description: r.description,
      technician: r.technician,
      quantity: hours.toFixed(2),
      rate: r.rate,
      amount: rate != null ? (hours * rate).toFixed(2) : '0.00',
      billingStatus: r.billingStatus,
      isApproved: r.isApproved
    });
  }
  for (const r of partRows) {
    const quantity = toFinite(r.quantity);
    const unitPrice = toFinite(r.unitPrice);
    rows.push({
      kind: 'part',
      date: r.date,
      orgName: r.orgName,
      ticketNumber: r.ticketNumber,
      description: r.description,
      technician: r.technician,
      quantity: r.quantity,
      rate: r.unitPrice,
      amount: quantity != null && unitPrice != null ? (quantity * unitPrice).toFixed(2) : '0.00',
      billingStatus: r.billingStatus,
      isApproved: null
    });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  return rows;
}
