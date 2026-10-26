/**
 * Calendar re-resolution for tickets that change org (#8973 W4, spec §4.3
 * "Move-org" row): the ticket's calendar is re-resolved for the TARGET org and
 * its unfrozen deadlines are recomputed on the new revision. Frozen arms keep
 * their deadline (computeSlaDeadlines skips them). The accrued
 * sla_paused_business_minutes is kept as counted — re-reading past pauses
 * under other hours cannot be done correctly (spec §4.5, quorum C4).
 *
 * Re-resolving always replaces the snapshot when the target resolves to a
 * different revision, so an org-owned calendar of the SOURCE org is never left
 * referenced: the target's own override, the partner default, or none.
 *
 * Reads on the caller's transaction (the mover holds both orgs FOR SHARE);
 * these are plain reads of config rows and take no lock.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db';
import { tickets } from '../../db/schema';
import {
  computeSlaDeadlines,
  loadTicketCalendar,
  slaClockRowOf,
  type SlaDeadlinePatch,
} from '../ticketSlaDeadlines';
import { resolveBusinessCalendar } from './resolve';

type Executor = Pick<Database, 'execute' | 'select' | 'update'>;

export type TicketCalendarMoveRow = Parameters<typeof slaClockRowOf>[0] & {
  slaCalendarRevisionId: string | null;
};

export type TicketCalendarMovePatch = SlaDeadlinePatch & { slaCalendarRevisionId?: string | null };

/**
 * The columns to write with the move: empty when the target resolves to the
 * revision the ticket already carries.
 */
export async function calendarPatchForOrgMove(
  tx: Pick<Database, 'execute'>,
  ticket: TicketCalendarMoveRow,
  target: { orgId: string; partnerId: string },
): Promise<TicketCalendarMovePatch> {
  const resolved = await resolveBusinessCalendar(tx, target);
  if (resolved.revisionId === (ticket.slaCalendarRevisionId ?? null)) return {};
  const calendar = await loadTicketCalendar(tx, resolved.revisionId);
  return { slaCalendarRevisionId: resolved.revisionId, ...computeSlaDeadlines(slaClockRowOf(ticket), calendar) };
}

/**
 * Device move-org: breeze_cascade_device_org_id() (and the mover's own
 * restamp) already moved these tickets' org_id/partner_id in this
 * transaction, so each row is re-resolved for the org it now belongs to.
 * Tickets per device are few: one resolve and at most one UPDATE per ticket
 * (only when its snapshot changes). Returns the number re-snapshotted.
 */
export async function reresolveMovedTicketCalendars(tx: Executor, ticketIds: readonly string[]): Promise<number> {
  if (ticketIds.length === 0) return 0;
  const rows = await tx
    .select({
      id: tickets.id,
      orgId: tickets.orgId,
      partnerId: tickets.partnerId,
      slaCalendarRevisionId: tickets.slaCalendarRevisionId,
      createdAt: tickets.createdAt,
      responseSlaMinutes: tickets.responseSlaMinutes,
      resolutionSlaMinutes: tickets.resolutionSlaMinutes,
      slaPausedAt: tickets.slaPausedAt,
      slaPausedBusinessMinutes: tickets.slaPausedBusinessMinutes,
      firstResponseAt: tickets.firstResponseAt,
      resolvedAt: tickets.resolvedAt,
      slaBreachReason: tickets.slaBreachReason,
    })
    .from(tickets)
    .where(inArray(tickets.id, [...ticketIds]));
  let changed = 0;
  for (const row of rows) {
    if (!row.partnerId) continue; // tickets_org_partner_fk keeps it set; defensive
    const patch = await calendarPatchForOrgMove(tx, row, { orgId: row.orgId, partnerId: row.partnerId });
    if (Object.keys(patch).length === 0) continue;
    await tx.update(tickets).set(patch).where(eq(tickets.id, row.id));
    changed++;
  }
  return changed;
}
