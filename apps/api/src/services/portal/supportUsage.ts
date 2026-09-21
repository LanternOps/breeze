import type { SupportUsageDto } from '@breeze/shared';
import {
  and,
  eq,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import { tickets, timeEntries } from '../../db/schema';

type UsageRow = {
  ticketNumber: string;
  title: string | null;
  durationMinutes: number | null;
  /** Billed quantity after the card's minimum/rounding (#4628 §3.5); NULL on pre-feature rows. */
  billableMinutes: number | null;
  billingStatus:
    | 'not_billed'
    | 'billed'
    | 'no_charge'
    | 'contract';
  isApproved: boolean;
};

function amount(minutes: number) {
  return {
    minutes,
    hours: minutes / 60,
  };
}

export async function supportUsageForOrg(args: {
  orgId: string;
  month: string;
  timezone: string;
  portalUserId: string;
}): Promise<SupportUsageDto> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) {
    throw new Error('month must use YYYY-MM');
  }

  const [year, month] = args.month.split('-').map(Number);
  const start = sql`make_timestamptz(
    ${year},
    ${month},
    1,
    0,
    0,
    0,
    ${args.timezone}
  )`;
  const end = sql`${start} + interval '1 month'`;

  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          ticketNumber: tickets.ticketNumber,
          title: sql<string | null>`
            CASE
              WHEN ${tickets.submittedBy} = ${args.portalUserId}
              THEN ${tickets.subject}
              ELSE NULL
            END
          `,
          durationMinutes: timeEntries.durationMinutes,
          billableMinutes: timeEntries.billableMinutes,
          billingStatus: timeEntries.billingStatus,
          isApproved: timeEntries.isApproved,
        })
        .from(timeEntries)
        .innerJoin(
          tickets,
          and(
            eq(tickets.id, timeEntries.ticketId),
            eq(tickets.orgId, args.orgId),
          ),
        )
        .where(and(
          eq(timeEntries.orgId, args.orgId),
          isNotNull(timeEntries.ticketId),
          eq(timeEntries.isBillable, true),
          ne(timeEntries.billingStatus, 'no_charge'),
          isNull(tickets.deletedAt),
          sql`${timeEntries.startedAt} AT TIME ZONE 'UTC' >= ${start}`,
          sql`${timeEntries.startedAt} AT TIME ZONE 'UTC' < ${end}`,
        )) as Promise<UsageRow[]>,
    ),
  );

  let billed = 0;
  let toBeBilled = 0;
  let coveredByContract = 0;
  let pendingReview = 0;

  const ticketsByNumber = new Map<
    string,
    SupportUsageDto['tickets'][number]
  >();

  for (const row of rows) {
    // Actual stopwatch minutes — still what pendingReview and coveredByContract report.
    const minutes = row.durationMinutes ?? 0;
    // Billed quantity (§3.5) — ONLY the billed / toBeBilled buckets and the
    // per-ticket accumulators for them use it, so a customer's hours match
    // their invoice.
    const billedQuantity = row.billableMinutes ?? minutes;
    const ticket = ticketsByNumber.get(row.ticketNumber) ?? {
      ticketNumber: row.ticketNumber,
      title: row.title,
      billedMinutes: 0,
      toBeBilledMinutes: 0,
      coveredByContractMinutes: 0,
      pendingReviewMinutes: 0,
    };

    // Bucket precedence: an unapproved entry always lands in pendingReview,
    // regardless of its billingStatus — approval gates billed/contract/
    // toBeBilled classification, so those three are only considered once a
    // row is approved.
    if (!row.isApproved) {
      pendingReview += minutes;
      ticket.pendingReviewMinutes += minutes;
    } else if (row.billingStatus === 'billed') {
      billed += billedQuantity;
      ticket.billedMinutes += billedQuantity;
    } else if (row.billingStatus === 'contract') {
      coveredByContract += minutes;
      ticket.coveredByContractMinutes += minutes;
    } else {
      toBeBilled += billedQuantity;
      ticket.toBeBilledMinutes += billedQuantity;
    }

    ticketsByNumber.set(row.ticketNumber, ticket);
  }

  return {
    dataStatus: rows.length > 0 ? 'ok' : 'no_data',
    asOf: new Date().toISOString(),
    month: args.month,
    timezone: args.timezone,
    totals: {
      billed: amount(billed),
      toBeBilled: amount(toBeBilled),
      coveredByContract: amount(coveredByContract),
      pendingReview: amount(pendingReview),
    },
    tickets: [...ticketsByNumber.values()],
  };
}
