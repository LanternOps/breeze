import type { SlaDto } from '@breeze/shared';
import { and, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { tickets } from '../../db/schema';
import { portalMonthWindow } from './patchReadModel';

type TicketSlaRow = Pick<
  typeof tickets.$inferSelect,
  | 'priority'
  | 'status'
  | 'createdAt'
  | 'firstResponseAt'
  | 'resolvedAt'
  | 'responseSlaMinutes'
  | 'resolutionSlaMinutes'
  | 'slaBreachedAt'
  | 'slaPausedAt'
  | 'slaPausedMinutes'
  | 'responseDueAt'
  | 'resolutionDueAt'
  | 'responseWarnAt'
  | 'resolutionWarnAt'
>;

const minutes = (from: Date, to: Date) =>
  Math.max(0, (to.getTime() - from.getTime()) / 60_000);

/**
 * Portal SLA status (#8973 W3, spec §4.3 reader 4). Status is derived from the
 * STORED deadlines the staff side uses, so the portal and the MSP queue agree.
 * A null target is `not_configured` — the portal no longer invents a
 * priority-default target the ticket never had (spec §8.5 correction 1). The
 * portal shows status only, never a due time (D11).
 */
export function ticketSla(row: TicketSlaRow, now: Date): SlaDto {
  const targets = {
    responseMinutes: row.responseSlaMinutes ?? null,
    resolutionMinutes: row.resolutionSlaMinutes ?? null,
  };
  const firstResponseMinutes = row.firstResponseAt
    ? minutes(row.createdAt, row.firstResponseAt)
    : null;
  const resolutionMinutes = row.resolvedAt
    ? Math.max(
        0,
        minutes(row.createdAt, row.resolvedAt) -
          (row.slaPausedMinutes ?? 0),
      )
    : null;

  const configured =
    targets.responseMinutes !== null ||
    targets.resolutionMinutes !== null;
  // A completion after its stored deadline is a breach (met = completion <= due).
  const measuredTargetBreached =
    (row.firstResponseAt != null &&
      row.responseDueAt != null &&
      row.firstResponseAt.getTime() > row.responseDueAt.getTime()) ||
    (row.resolvedAt != null &&
      row.resolutionDueAt != null &&
      row.resolvedAt.getTime() > row.resolutionDueAt.getTime());
  let status: SlaDto['status'];

  // Same rules as the MSP queue (routes/tickets/tickets.ts SLA_AT_RISK).
  // A stamped breach wins. Completed measurements can also prove a breach;
  // otherwise the stored warn point drives at-risk.
  if (row.slaBreachedAt) status = 'breached';
  else if (!configured) status = 'not_configured';
  else if (measuredTargetBreached) status = 'breached';
  else if (
    row.status === 'resolved' ||
    row.status === 'closed' ||
    row.resolvedAt
  ) status = 'met';
  else {
    // Warn points of the arms still running (a null deadline has no clock).
    const running: Array<Date | null> = [];
    if (!row.firstResponseAt && row.responseDueAt) running.push(row.responseWarnAt);
    if (row.resolutionDueAt) running.push(row.resolutionWarnAt);

    if (running.length === 0) status = 'met';
    else if (
      row.status === 'pending' ||
      row.status === 'on_hold' ||
      row.slaPausedAt
    ) status = 'paused';
    else {
      status = running.some((warn) => warn != null && now.getTime() >= warn.getTime())
        ? 'at_risk'
        : 'on_track';
    }
  }

  return {
    firstResponseMinutes,
    resolutionMinutes,
    responseTargetMinutes: targets.responseMinutes,
    resolutionTargetMinutes: targets.resolutionMinutes,
    status,
  };
}

const OPEN_TICKET_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

export async function supportTile(
  orgId: string,
  args: { timezone: string; now: Date },
  ticketOwnership: SQL,
) {
  const { start, end, month } = portalMonthWindow(
    args.now,
    args.timezone,
  );
  const [openRows, responseRows] = await Promise.all([
    db
      .select({ openTickets: sql<number>`count(*)::int` })
      .from(tickets)
      .where(and(
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
        inArray(tickets.status, [...OPEN_TICKET_STATUSES]),
        ticketOwnership,
      )),
    db
      .select({
      averageFirstResponseMinutes: sql<number | null>`
        avg(extract(epoch from (
          ${tickets.firstResponseAt} - ${tickets.createdAt}
        )) / 60)
      `,
        sampleSize: sql<number>`count(*)::int`,
      })
      .from(tickets)
      .where(and(
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
        sql`${tickets.firstResponseAt} is not null`,
        gte(tickets.createdAt, start),
        lt(tickets.createdAt, end),
        ticketOwnership,
      )),
  ]);

  const open = openRows[0];
  const response = responseRows[0];

  return {
    status: 'ok' as const,
    openTickets: Number(open?.openTickets ?? 0),
    averageFirstResponseMinutes:
      response?.averageFirstResponseMinutes == null
        ? null
        : Math.round(Number(response.averageFirstResponseMinutes)),
    sampleSize: Number(response?.sampleSize ?? 0),
    month,
    timezone: args.timezone,
    asOf: args.now.toISOString(),
  };
}
