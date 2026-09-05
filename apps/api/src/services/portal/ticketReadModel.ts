import type { SlaDto } from '@breeze/shared';
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { tickets } from '../../db/schema';
import { portalMonthWindow } from './patchReadModel';
import {
  resolveSlaTargets,
  SLA_AT_RISK_RATIO,
} from '../ticketSla';

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
>;

const minutes = (from: Date, to: Date) =>
  Math.max(0, (to.getTime() - from.getTime()) / 60_000);

export function ticketSla(row: TicketSlaRow, now: Date): SlaDto {
  const targets = resolveSlaTargets({
    overrideResponseMinutes: row.responseSlaMinutes,
    overrideResolutionMinutes: row.resolutionSlaMinutes,
    priority: row.priority,
  });
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
  const measuredTargetBreached =
    (firstResponseMinutes !== null &&
      targets.responseMinutes !== null &&
      firstResponseMinutes > targets.responseMinutes) ||
    (resolutionMinutes !== null &&
      targets.resolutionMinutes !== null &&
      resolutionMinutes > targets.resolutionMinutes);
  let status: SlaDto['status'];

  // Match the MSP list's SQL twins in routes/tickets/tickets.ts:61-85.
  // A stamped breach wins. Completed measurements can also prove a breach;
  // current elapsed time alone only drives the at-risk state below.
  if (row.slaBreachedAt) status = 'breached';
  else if (!configured) status = 'not_configured';
  else if (measuredTargetBreached) status = 'breached';
  else if (
    row.status === 'resolved' ||
    row.status === 'closed' ||
    row.resolvedAt
  ) status = 'met';
  else {
    const unmet = [
      row.firstResponseAt ? null : targets.responseMinutes,
      targets.resolutionMinutes,
    ].filter((value): value is number => value !== null);

    if (unmet.length === 0) status = 'met';
    else if (
      row.status === 'pending' ||
      row.status === 'on_hold' ||
      row.slaPausedAt
    ) status = 'paused';
    else {
      const activeElapsed =
        minutes(row.createdAt, now) - (row.slaPausedMinutes ?? 0);
      const target = Math.min(...unmet);
      status = activeElapsed >= target * SLA_AT_RISK_RATIO
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
