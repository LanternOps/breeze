/**
 * #4628 W03 §3.5. The wave's gate: the TypeScript function, the Drizzle SQL
 * fragment and the CHECK constraint all compute the SAME billable quantity, and
 * BOTH stop paths land it.
 *
 * This is what makes "the CHECK turns drift into a constraint violation" a fact
 * rather than a claim.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  computeBillableMinutes, billableMinutesSql, BILLABLE_MINUTES_CHECK_NAME,
} from '../../services/billableMinutes';
import { BILLABLE_MINUTES_GRID } from '../../services/billableMinutes.test';
import {
  getTicketBillingSummary, readTimeEntryById, startTimer, stopTimer, updateTimeEntry,
  type TimeEntryActor,
} from '../../services/timeEntryService';
import { assignProfileToOrg, createProfile, replaceProfileRows } from '../../services/billingProfileService';

// Only the unrelated queue boundary is stubbed. Everything else below is real
// Postgres, real RLS, real constraints.
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

const profileWriter = { scope: 'partner', partnerOrgAccess: 'all' } as const;

async function seedActor(terms: { minimumMinutes: number | null; roundingIncrementMinutes: number | null }) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `bm-${randomUUID()}@example.test` });
  const workTypeId = randomUUID();
  const ticketId = randomUUID();
  await getTestDb().execute(sql`INSERT INTO work_types (id, partner_id, name)
    VALUES (${workTypeId}, ${partner.id}, 'On-site')`);
  await getTestDb().execute(sql`INSERT INTO tickets (id, partner_id, org_id, ticket_number, subject, source)
    VALUES (${ticketId}, ${partner.id}, ${org.id}, ${`BM-${ticketId}`}, 'Billable minutes', 'manual')`);
  const context: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id], currentPartnerId: partner.id, userId: user.id,
  };
  const run = <T>(callback: () => Promise<T>) => withDbAccessContext(context, callback);
  const actor: TimeEntryActor = {
    userId: user.id, partnerId: partner.id, manageAll: false,
    manageBilling: false, accessibleOrgIds: [org.id],
  };
  const profile = await run(() => createProfile(profileWriter, partner.id, {
    name: `Card ${randomUUID()}`, currencyCode: 'USD', isDefault: true,
    baseCoverage: 'billable', baseHourlyRate: '225.00',
    ...(terms.roundingIncrementMinutes != null
      ? { roundingIncrementMinutes: terms.roundingIncrementMinutes } : {}),
  }));
  await run(() => replaceProfileRows(profileWriter, profile.id, partner.id, [{
    workTypeId, coverage: 'billable', hourlyRate: '225.00', minimumMinutes: terms.minimumMinutes,
  }]));
  await run(() => assignProfileToOrg(org.id, partner.id, profile.id, user.id));
  return { partnerId: partner.id, orgId: org.id, userId: user.id, ticketId, workTypeId, actor, run };
}

/** A running timer, back-dated so a stop produces exactly `startedMinutesAgo`. */
async function seedRunningTimerForActor(opts: {
  minimumMinutes: number | null; roundingIncrementMinutes: number | null; startedMinutesAgo: number;
}) {
  const f = await seedActor(opts);
  const entry = await f.run(() => startTimer({ ticketId: f.ticketId, workTypeId: f.workTypeId }, f.actor));
  const startedAt = new Date(Date.now() - opts.startedMinutesAgo * 60_000);
  // Back-date with a few seconds of slack so the FLOOR() in both duration
  // computations lands on the same whole minute regardless of test latency.
  // A JS Date inside a raw drizzle sql`` fragment throws at bind — always an
  // ISO string cast, and `::timestamp` because started_at is `timestamp`
  // (UTC wall time), exactly what stopRunningEntry's CAS compares against.
  await getTestDb().execute(sql`UPDATE time_entries
    SET started_at = ${new Date(startedAt.getTime() - 5_000).toISOString()}::timestamp
    WHERE id = ${entry.id}`);
  expect(entry.durationMinutes).toBeNull();
  expect(entry.billableMinutes).toBeNull();
  return { ...f, entryId: entry.id, startedAt };
}

async function seedClosedTimeEntry(opts: {
  durationMinutes: number; minimumMinutes: number | null; roundingIncrementMinutes: number | null;
}) {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id, email: `bm-${randomUUID()}@example.test` });
  const id = randomUUID();
  const startedAt = new Date('2026-03-03T09:00:00Z');
  await getTestDb().execute(sql`INSERT INTO time_entries
    (id, partner_id, user_id, started_at, ended_at, duration_minutes, minimum_minutes, rounding_increment_minutes, coverage)
    VALUES (${id}, ${partner.id}, ${user.id}, ${startedAt.toISOString()}::timestamp,
      ${new Date(startedAt.getTime() + opts.durationMinutes * 60_000).toISOString()}::timestamp,
      ${opts.durationMinutes}, ${opts.minimumMinutes}, ${opts.roundingIncrementMinutes}, 'billable')`);
  return id;
}

/** A finished, billable entry ON the seeded ticket, written straight to the
 *  table so a pre-feature row (billable_minutes NULL) can be reproduced — the
 *  service will not create one. */
async function insertClosedEntryOnTicket(
  f: Awaited<ReturnType<typeof seedActor>>,
  opts: {
    durationMinutes: number; billableMinutes: number | null;
    minimumMinutes: number | null; roundingIncrementMinutes: number | null;
  }
) {
  const id = randomUUID();
  const startedAt = new Date('2026-03-03T09:00:00Z');
  await getTestDb().execute(sql`INSERT INTO time_entries
    (id, partner_id, org_id, ticket_id, user_id, work_type_id, started_at, ended_at,
     duration_minutes, billable_minutes, minimum_minutes, rounding_increment_minutes,
     coverage, is_billable, hourly_rate, currency_code)
    VALUES (${id}, ${f.partnerId}, ${f.orgId}, ${f.ticketId}, ${f.userId}, ${f.workTypeId},
      ${startedAt.toISOString()}::timestamp,
      ${new Date(startedAt.getTime() + opts.durationMinutes * 60_000).toISOString()}::timestamp,
      ${opts.durationMinutes}, ${opts.billableMinutes}, ${opts.minimumMinutes},
      ${opts.roundingIncrementMinutes}, 'billable', true, '225.00', 'USD')`);
  return id;
}

async function seedRunningTimerRow(opts: { minimumMinutes: number | null; roundingIncrementMinutes: number | null }) {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id, email: `bm-${randomUUID()}@example.test` });
  const id = randomUUID();
  await getTestDb().execute(sql`INSERT INTO time_entries
    (id, partner_id, user_id, started_at, ended_at, duration_minutes, minimum_minutes, rounding_increment_minutes, coverage)
    VALUES (${id}, ${partner.id}, ${user.id}, '2026-03-03T09:00:00'::timestamp,
      NULL, NULL, ${opts.minimumMinutes}, ${opts.roundingIncrementMinutes}, 'billable')`);
  return id;
}

/** Drizzle wraps driver errors; the SQLSTATE lives on `.cause`. */
const sqlCause = (error: unknown): { code?: string } =>
  (error as { cause?: { code?: string } }).cause ?? {};

const expectCheckViolation = async (promise: Promise<unknown>) => {
  const caught = await promise.then(() => null, (e: unknown) => e);
  expect(caught).not.toBeNull();
  expect(sqlCause(caught).code).toBe('23514');
};

const setBillableMinutes = async (id: string, value: number) => {
  await getTestDb().execute(sql`UPDATE time_entries SET billable_minutes = ${value} WHERE id = ${id}`);
};

const readBillableMinutes = async (id: string) => {
  const [row] = await getTestDb().execute(
    sql`SELECT billable_minutes FROM time_entries WHERE id = ${id}`
  ) as unknown as Array<{ billable_minutes: number | null }>;
  return row?.billable_minutes ?? null;
};

describe('billable_minutes: TS, SQL and the CHECK all agree (#4628 W03 §3.5)', () => {
  it('the REAL billableMinutesSql() fragment reproduces computeBillableMinutes() over the whole grid', async () => {
    // Call the exported fragment — do NOT re-type the formula here. A third
    // hand-transcription makes this test near-tautological: a bad cast or an
    // off-by-one CEIL inside billableMinutesSql() would sail through.
    // The fragment references "time_entries"."minimum_minutes" /
    // "rounding_increment_minutes", so a one-row CTE named time_entries shadows
    // the real table and feeds it the grid row.
    for (const row of BILLABLE_MINUTES_GRID) {
      if (row.durationMinutes === null) continue; // running timer: the CHECK test below covers it
      const [result] = await getTestDb().execute(sql`
        WITH time_entries (minimum_minutes, rounding_increment_minutes) AS (
          VALUES (${row.minimumMinutes}::int, ${row.roundingIncrementMinutes}::int)
        )
        SELECT ${billableMinutesSql(sql`${row.durationMinutes}::int`)} AS computed FROM time_entries
      `) as unknown as Array<{ computed: number | null }>;

      expect({ case: row.name, sql: Number(result!.computed) }).toEqual({
        case: row.name,
        sql: computeBillableMinutes(row),
      });
    }
  });

  it('a hand-written WRONG billable_minutes violates the CHECK (23514)', async () => {
    const entryId = await seedClosedTimeEntry({ durationMinutes: 20, minimumMinutes: 60, roundingIncrementMinutes: 15 });
    // Control first: the RIGHT value is accepted, so a rejection below is the
    // CHECK doing its job and not an unrelated failure.
    await expect(setBillableMinutes(entryId, 60)).resolves.toBeUndefined();
    await expectCheckViolation(setBillableMinutes(entryId, 20));
    await expectCheckViolation(setBillableMinutes(entryId, 61));
  });

  it('the CHECK forbids a billable_minutes on a running timer', async () => {
    const entryId = await seedRunningTimerRow({ minimumMinutes: 60, roundingIncrementMinutes: 15 });
    await expectCheckViolation(setBillableMinutes(entryId, 60));
  });

  it('the constraint is VALIDATED, not left NOT VALID', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT convalidated FROM pg_constraint
      WHERE conname = ${BILLABLE_MINUTES_CHECK_NAME}
        AND conrelid = 'time_entries'::regclass
    `) as unknown as Array<{ convalidated: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.convalidated).toBe(true);
  });

  it('stop-via-CAS lands billable_minutes', async () => {
    const f = await seedRunningTimerForActor({ minimumMinutes: 60, roundingIncrementMinutes: 15, startedMinutesAgo: 20 });
    const stopped = await f.run(() => stopTimer({}, f.actor));
    expect(stopped.durationMinutes).toBe(20);
    expect(await readBillableMinutes(f.entryId)).toBe(60);
  });

  it('stop-via-PATCH (how mobile replays a stop) lands the SAME value', async () => {
    const f = await seedRunningTimerForActor({ minimumMinutes: 60, roundingIncrementMinutes: 15, startedMinutesAgo: 20 });
    // Read started_at through the SERVICE, so endedAt is expressed in the same
    // frame computeDurationMinutes() will subtract it in.
    const running = await f.run(() => readTimeEntryById(f.entryId));
    await f.run(() => updateTimeEntry(
      f.entryId,
      { endedAt: new Date(running!.startedAt.getTime() + 20 * 60_000) },
      f.actor
    ));
    expect(await readBillableMinutes(f.entryId)).toBe(60);
  });

  it('a card with no minimum and no rounding stops to the actual duration', async () => {
    const f = await seedRunningTimerForActor({ minimumMinutes: null, roundingIncrementMinutes: null, startedMinutesAgo: 37 });
    const stopped = await f.run(() => stopTimer({}, f.actor));
    expect(stopped.durationMinutes).toBe(37);
    expect(await readBillableMinutes(f.entryId)).toBe(37);
  });

  it('a rounding-only card rounds the stopped duration UP', async () => {
    const f = await seedRunningTimerForActor({ minimumMinutes: null, roundingIncrementMinutes: 15, startedMinutesAgo: 31 });
    await f.run(() => stopTimer({}, f.actor));
    expect(await readBillableMinutes(f.entryId)).toBe(45);
  });

  it('a stop that REWRITES the terms computes from the new ones, not the stale columns', async () => {
    // The load-bearing case for billableMinutesSql()'s `terms` argument, and
    // the only path that proves it against real Postgres: stopping a timer as
    // non-billable makes applyBillingInput null minimum_minutes in the SAME
    // UPDATE that computes billable_minutes. SET expressions read the OLD row,
    // so a column reference would still see the 60-minute minimum and store 60
    // — while the CHECK validates the NEW row, whose minimum is NULL and whose
    // only surviving term is the 15-minute rounding. The row would be rejected
    // outright with 23514: a 500 on an ordinary timer stop.
    const f = await seedRunningTimerForActor({
      minimumMinutes: 60, roundingIncrementMinutes: 15, startedMinutesAgo: 20,
    });
    // Rewriting the terms at stop is a manager action (assertManageBilling).
    const manager: TimeEntryActor = { ...f.actor, manageBilling: true };
    const stopped = await f.run(() => stopTimer({ isBillable: false }, manager));

    expect(stopped.durationMinutes).toBe(20);
    expect(stopped.minimumMinutes).toBeNull();
    // CEIL(20 / 15) * 15 = 30. Not 60, which is what the stale minimum gives.
    expect(await readBillableMinutes(f.entryId)).toBe(30);
  });

  it('the ticket summary bills a PRE-FEATURE row at its worked duration', async () => {
    // The migration deliberately leaves already-invoiced rows NULL, so tickets
    // spanning the W02->W03 window hold a mix. `SUM(billable_minutes)` alone
    // drops the NULL row silently — the COALESCE is the only thing keeping the
    // older entry's time on the invoice, and nothing else in the suite pins it.
    const f = await seedActor({ minimumMinutes: 60, roundingIncrementMinutes: 15 });
    await insertClosedEntryOnTicket(f, {
      durationMinutes: 45, billableMinutes: null,
      minimumMinutes: null, roundingIncrementMinutes: null,
    });
    await insertClosedEntryOnTicket(f, {
      durationMinutes: 20, billableMinutes: 60,
      minimumMinutes: 60, roundingIncrementMinutes: 15,
    });

    const summary = await f.run(() => getTicketBillingSummary(f.ticketId));

    // 45 worked (legacy, no terms) + 60 billed (20 worked under a 60 minimum).
    expect(summary.time.billableMinutes).toBe(105);
    // Utilization stays on ACTUAL minutes worked.
    expect(summary.time.totalMinutes).toBe(65);
    // 0.75 h + 1.00 h at 225.00.
    expect(summary.time.billableAmounts).toEqual([{ currencyCode: 'USD', amount: '393.75' }]);
  });
});
