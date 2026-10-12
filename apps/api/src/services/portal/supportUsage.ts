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
import { hourBlockCoverageForOrg } from './hourBlockCoverage';
import { allocateBlockCoverage, isHeldByBlock } from './hourBlockWindows';

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
  endedAt: Date | null;
  /** Non-null only when a block close drew this entry (billing_status = 'contract'). */
  contractLineId: string | null;
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
  /** Test seam / consistent clock for the block-hours reads; defaults to now. */
  asOf?: Date;
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

  const { coverage, rows } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // Block hours W04: null unless the org's Support hours flag is on. Called
      // inside THIS context (it opens none of its own), so one request holds
      // one pooled connection.
      const coverage = await hourBlockCoverageForOrg(args.orgId, args.asOf);

      const rows = (await db
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
          endedAt: timeEntries.endedAt,
          contractLineId: timeEntries.contractLineId,
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
        ))) as UsageRow[];

      return { coverage, rows };
    }),
  );

  let billed = 0;
  let toBeBilled = 0;
  let coveredByContract = 0;
  let pendingReview = 0;
  const blockRows: Array<{
    key: string;
    row: UsageRow;
    billedQuantity: number;
    ticket: SupportUsageDto['tickets'][number];
  }> = [];

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
      ...(coverage ? { coveredByBlockMinutes: 0, overBlockMinutes: 0 } : {}),
    };

    // Bucket precedence: an unapproved entry always lands in pendingReview,
    // regardless of its billingStatus — approval gates billed/contract/
    // toBeBilled classification, so those three are only considered once a
    // row is approved.
    if (!row.isApproved) {
      pendingReview += minutes;
      ticket.pendingReviewMinutes += minutes;
    } else if (
      coverage &&
      ((row.billingStatus === 'contract' && row.contractLineId !== null) ||
        (row.billingStatus === 'not_billed' && isHeldByBlock(row.endedAt, coverage.windows)))
    ) {
      // Block hours W04. Drawn at a close (contract + line id) or reserved for
      // the open period (the same hold windows ad-hoc assembly uses). Split
      // into covered vs over AFTER the loop, once every entry of a period is
      // known. Reported in the BILLED quantity so the hours tie to the Support
      // hours card, which draws COALESCE(billable_minutes, duration_minutes).
      blockRows.push({ key: String(blockRows.length), row, billedQuantity, ticket });
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

  let coveredByBlock = 0;
  let overBlock = 0;
  if (coverage) {
    const split = allocateBlockCoverage(
      blockRows.map((b) => ({ key: b.key, endedAt: b.row.endedAt, minutes: b.billedQuantity })),
      coverage.periods,
    );
    for (const b of blockRows) {
      const { covered, over } = split.get(b.key)!;
      coveredByBlock += covered;
      overBlock += over;
      b.ticket.coveredByBlockMinutes = (b.ticket.coveredByBlockMinutes ?? 0) + covered;
      b.ticket.overBlockMinutes = (b.ticket.overBlockMinutes ?? 0) + over;
    }
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
      ...(coverage ? { coveredByBlock: amount(coveredByBlock), overBlock: amount(overBlock) } : {}),
    },
    tickets: [...ticketsByNumber.values()],
  };
}
