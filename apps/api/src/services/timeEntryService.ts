import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { timeEntries, ticketParts, tickets, ticketCategories, organizations } from '../db/schema';
import { emitTimeEntryEvent } from './timeEntryEvents';
import type { CreateTimeEntryInput, UpdateTimeEntryInput, TicketPartInput } from '@breeze/shared';

export type TimeEntryServiceErrorCode =
  | 'TICKET_NOT_FOUND'
  | 'TICKET_WRONG_PARTNER'
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
 * Validates a ticket link for the acting partner and resolves billing defaults
 * (spec D2: category default + manual override). Returns the denormalization
 * payload for the time-entry/part row.
 */
async function resolveTicketLink(ticketId: string, actorPartnerId: string | null) {
  const ticket = await getTicketForTimeTracking(ticketId);
  const ticketPartnerId = await resolveTicketPartner(ticket);
  if (!ticketPartnerId) {
    throw new TimeEntryServiceError('Ticket partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  }
  if (actorPartnerId && ticketPartnerId !== actorPartnerId) {
    throw new TimeEntryServiceError('Ticket must belong to the same partner', 400, 'TICKET_WRONG_PARTNER');
  }
  const category = ticket.categoryId ? await getCategoryDefaults(ticket.categoryId) : null;
  return {
    ticket,
    partnerId: ticketPartnerId,
    defaultBillable: category?.defaultBillable ?? false,
    defaultHourlyRate: category?.defaultHourlyRate ?? null
  };
}

export async function createTimeEntry(input: CreateTimeEntryInput, actor: TimeEntryActor) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let defaultBillable = false;
  let defaultRate: string | null = null;

  if (input.ticketId) {
    const link = await resolveTicketLink(input.ticketId, actor.partnerId);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    defaultBillable = link.defaultBillable;
    defaultRate = link.defaultHourlyRate;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
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

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function startTimer(input: { ticketId?: string; description?: string }, actor: TimeEntryActor) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let defaultBillable = false;
  let defaultRate: string | null = null;

  if (input.ticketId) {
    const link = await resolveTicketLink(input.ticketId, actor.partnerId);
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
    await stopRunningEntry(actor);
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
    entry = await attempt();
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
