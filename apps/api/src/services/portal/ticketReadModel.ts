import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { tickets } from '../../db/schema';
import { portalMonthWindow } from './patchReadModel';

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
