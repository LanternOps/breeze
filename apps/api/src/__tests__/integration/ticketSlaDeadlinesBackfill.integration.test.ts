import './setup';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tickets } from '../../db/schema';
import { SLA_AT_RISK } from '../../routes/tickets/tickets';
import { splitSqlStatements } from '../../db/autoMigrate';
import { createOrganization, createPartner } from './db-utils';
import { getAppDb, getTestDb } from './setup';

/**
 * #8973 W3 — stored SLA deadline backfill (spec §4.6, Gate B11).
 *
 * The golden case: tickets written before W3 (no stored deadlines) produce the
 * SAME breach and at-risk sets under the pre-W3 wall-clock SQL as they do
 * under the stored-column predicates once the backfill has run. The old
 * predicates are copied verbatim from routes/tickets/tickets.ts (SLA_AT_RISK)
 * and jobs/ticketSlaWorker.ts (stampBreaches) as they stood at 567fc76a39.
 *
 * All three W3 migrations are `-- @no-transaction`, which replayMigration
 * refuses, so they are re-applied the way autoMigrate applies them: split
 * with splitSqlStatements and sent one statement at a time on a single
 * connection outside any transaction.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const DDL = '2027-01-02-190100-ticket-sla-deadlines.sql';
const BACKFILL = '2027-01-02-190200-ticket-sla-deadlines-backfill.sql';
const INDEXES = '2027-01-02-190300-ticket-sla-due-indexes.sql';
const CALENDAR_REVISION = '2027-01-03-160100-ticket-sla-calendar-revision.sql';

async function migrationSql(name: string): Promise<string> {
  return readFile(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
}

/** autoMigrate's no-transaction path, verbatim: one statement per round trip, max: 1. */
async function applyNoTransaction(name: string, url = process.env.DATABASE_URL!): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const statement of splitSqlStatements(await migrationSql(name))) {
      await client.unsafe(statement);
    }
  } finally {
    await client.end();
  }
}

// ---- pre-W3 predicates, copied verbatim -----------------------------------

// routes/tickets/tickets.ts SLA_AT_RISK @ 567fc76a39 (column refs spelled out).
const OLD_AT_RISK = `(
  sla_breached_at IS NULL
  AND status IN ('new', 'open')
  AND sla_paused_at IS NULL
  AND (
    (first_response_at IS NULL AND response_sla_minutes IS NOT NULL
      AND now() >= created_at
        + COALESCE(sla_paused_minutes, 0) * interval '1 minute'
        + response_sla_minutes * interval '1 minute' * 0.8)
    OR (resolution_sla_minutes IS NOT NULL
      AND now() >= created_at
        + COALESCE(sla_paused_minutes, 0) * interval '1 minute'
        + resolution_sla_minutes * interval '1 minute' * 0.8)
  )
)`;

// jobs/ticketSlaWorker.ts stampBreaches @ 567fc76a39, the `due` CTE's WHERE.
function oldBreachDue(target: 'response' | 'resolution'): string {
  const targetColumn = target === 'response' ? 'response_sla_minutes' : 'resolution_sla_minutes';
  const unmetCondition = target === 'response' ? 'first_response_at IS NULL' : 'resolved_at IS NULL';
  return `status IN ('new', 'open')
        AND work_kind = 'support'
        AND sla_paused_at IS NULL
        AND ${unmetCondition}
        AND ${targetColumn} IS NOT NULL
        AND NOT ('${target}' = ANY(string_to_array(COALESCE(sla_breach_reason, ''), ',')))
        AND now() >= created_at
          + (${targetColumn} + COALESCE(sla_paused_minutes, 0)) * interval '1 minute'`;
}

// ---- stored-column predicates (spec §4.3 reader 1; reader 2 is the production SLA_AT_RISK) --

function newBreachDue(target: 'response' | 'resolution'): string {
  const due = target === 'response' ? 'response_due_at' : 'resolution_due_at';
  const unmetCondition = target === 'response' ? 'first_response_at IS NULL' : 'resolved_at IS NULL';
  return `status IN ('new', 'open')
        AND work_kind = 'support'
        AND sla_paused_at IS NULL
        AND ${unmetCondition}
        AND ${due} IS NOT NULL
        AND NOT ('${target}' = ANY(string_to_array(COALESCE(sla_breach_reason, ''), ',')))
        AND now() >= ${due}`;
}

type Sets = { atRisk: string[]; response: string[]; resolution: string[] };

async function readSets(kind: 'old' | 'new', orgId: string): Promise<Sets> {
  const db = getTestDb();
  const ids = async (where: string) => {
    const rows = await db.execute<{ subject: string }>(
      sql.raw(`SELECT subject FROM tickets WHERE org_id = '${orgId}' AND ${where} ORDER BY subject`),
    );
    return [...rows].map((r) => r.subject);
  };
  return kind === 'old'
    ? { atRisk: await ids(OLD_AT_RISK), response: await ids(oldBreachDue('response')), resolution: await ids(oldBreachDue('resolution')) }
    : {
        // The PRODUCTION staff-queue fragment, not a copy (it is the reader under test).
        atRisk: [...await db.select({ subject: tickets.subject }).from(tickets)
          .where(and(eq(tickets.orgId, orgId), SLA_AT_RISK)).orderBy(asc(tickets.subject))].map((r) => r.subject),
        response: await ids(newBreachDue('response')), resolution: await ids(newBreachDue('resolution')) };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/**
 * Pre-W3-shaped tickets: stored columns at their DDL defaults (NULL / 0).
 * Every timing sits whole minutes away from an edge so the two reads, a few
 * hundred milliseconds apart, cannot straddle one.
 */
async function seedFixtures() {
  const partner = await createPartner({ name: 'SlaBackfill-Partner' });
  const org = await createOrganization({ partnerId: partner.id, name: 'SlaBackfill-Org' });
  const base = { orgId: org.id, partnerId: partner.id, source: 'api' as const, priority: 'normal' as const };
  const rows: Array<Partial<typeof tickets.$inferInsert> & { subject: string }> = [
    { subject: 'null-targets', status: 'open', createdAt: minutesAgo(10_000) },
    { subject: 'null-targets-paused-history', status: 'open', slaPausedMinutes: 25, createdAt: minutesAgo(10_000) },
    { subject: 'on-track', status: 'new', responseSlaMinutes: 60, resolutionSlaMinutes: 480, createdAt: minutesAgo(30) },
    { subject: 'response-at-risk', status: 'open', responseSlaMinutes: 60, resolutionSlaMinutes: 480, createdAt: minutesAgo(50) },
    { subject: 'response-breach-due', status: 'open', responseSlaMinutes: 60, resolutionSlaMinutes: 480, createdAt: minutesAgo(90) },
    { subject: 'paused-now', status: 'pending', responseSlaMinutes: 60, resolutionSlaMinutes: 120, slaPausedAt: minutesAgo(80), slaPausedMinutes: 5, createdAt: minutesAgo(200) },
    { subject: 'resumed-not-due', status: 'open', responseSlaMinutes: 60, resolutionSlaMinutes: 480, slaPausedMinutes: 40, createdAt: minutesAgo(91) },
    { subject: 'resumed-due', status: 'open', responseSlaMinutes: 60, resolutionSlaMinutes: 480, slaPausedMinutes: 40, createdAt: minutesAgo(110) },
    { subject: 'responded-resolution-due', status: 'open', responseSlaMinutes: 30, resolutionSlaMinutes: 120, firstResponseAt: minutesAgo(100), createdAt: minutesAgo(130) },
    { subject: 'responded-resolution-at-risk', status: 'open', responseSlaMinutes: 30, resolutionSlaMinutes: 120, firstResponseAt: minutesAgo(100), createdAt: minutesAgo(100) },
    { subject: 'resolved', status: 'resolved', responseSlaMinutes: 30, resolutionSlaMinutes: 120, firstResponseAt: minutesAgo(200), resolvedAt: minutesAgo(10), createdAt: minutesAgo(300) },
    { subject: 'reopened', status: 'open', responseSlaMinutes: 30, resolutionSlaMinutes: 120, firstResponseAt: minutesAgo(200), resolvedAt: null, createdAt: minutesAgo(300) },
    { subject: 'fractional-at-risk', status: 'new', responseSlaMinutes: 7, resolutionSlaMinutes: 45, createdAt: minutesAgo(6) },
    { subject: 'fractional-on-track', status: 'new', responseSlaMinutes: 7, resolutionSlaMinutes: 45, createdAt: minutesAgo(5) },
    { subject: 'response-stamped-resolution-due', status: 'open', responseSlaMinutes: 30, resolutionSlaMinutes: 60, slaBreachedAt: minutesAgo(50), slaBreachReason: 'response', createdAt: minutesAgo(80) },
    { subject: 'both-stamped', status: 'open', responseSlaMinutes: 30, resolutionSlaMinutes: 60, slaBreachedAt: minutesAgo(50), slaBreachReason: 'response,resolution', createdAt: minutesAgo(200) },
    { subject: 'planned-work', status: 'open', workKind: 'deliverable', responseSlaMinutes: 30, resolutionSlaMinutes: 60, createdAt: minutesAgo(200) },
    { subject: 'response-only-target', status: 'open', responseSlaMinutes: 30, createdAt: minutesAgo(45) },
  ];
  const db = getTestDb();
  for (const row of rows) {
    await db.insert(tickets).values({ ...base, ticketNumber: `SLA-${crypto.randomUUID().slice(0, 8)}`, ...row });
  }
  return { partner, org, count: rows.length };
}

async function storedState(orgId: string) {
  const rows = await getTestDb().execute<Record<string, unknown>>(sql.raw(`
    SELECT subject, sla_paused_business_minutes,
           response_due_at::text, response_warn_at::text,
           resolution_due_at::text, resolution_warn_at::text
      FROM tickets WHERE org_id = '${orgId}' ORDER BY subject`));
  return [...rows];
}

async function resetStored(orgId: string) {
  await getTestDb().execute(sql.raw(`
    UPDATE tickets SET sla_paused_business_minutes = 0,
      response_due_at = NULL, response_warn_at = NULL,
      resolution_due_at = NULL, resolution_warn_at = NULL
    WHERE org_id = '${orgId}'`));
}

describe('ticket SLA deadline backfill (#8973 W3)', () => {
  runDb('backfill reproduces the pre-W3 breach and at-risk sets', async () => {
    const { org } = await seedFixtures();
    const before = await readSets('old', org.id);
    // The fixtures exercise every set; an empty set would make equality vacuous.
    expect(before.atRisk.length).toBeGreaterThan(0);
    expect(before.response.length).toBeGreaterThan(0);
    expect(before.resolution.length).toBeGreaterThan(0);
    expect(before.atRisk).toEqual(expect.arrayContaining(['fractional-at-risk', 'response-at-risk', 'responded-resolution-at-risk', 'resumed-not-due']));
    expect(before.atRisk).not.toContain('fractional-on-track');

    // Nothing stored yet: the new predicates see nothing.
    expect(await readSets('new', org.id)).toEqual({ atRisk: [], response: [], resolution: [] });

    for (const file of [DDL, BACKFILL, INDEXES]) await applyNoTransaction(file);

    expect(await readSets('new', org.id)).toEqual(before);
    expect(await readSets('old', org.id)).toEqual(before);

    const state = await storedState(org.id);
    const bySubject = new Map(state.map((r) => [r.subject as string, r]));
    expect(bySubject.get('null-targets')).toMatchObject({ response_due_at: null, resolution_due_at: null, response_warn_at: null, resolution_warn_at: null });
    expect(bySubject.get('null-targets-paused-history')).toMatchObject({ sla_paused_business_minutes: 25, response_due_at: null });
    expect(bySubject.get('response-only-target')).toMatchObject({ resolution_due_at: null, resolution_warn_at: null });
    expect(bySubject.get('response-only-target')!.response_due_at).not.toBeNull();
    expect(bySubject.get('resumed-due')).toMatchObject({ sla_paused_business_minutes: 40 });

    // Exact values, including the 0.8 fraction (7 min target → 5 min 36 s).
    const exact = await getTestDb().execute<{ subject: string; due: string; warn: string; rdue: string; rwarn: string }>(sql.raw(`
      SELECT subject, (response_due_at - created_at)::text AS due, (response_warn_at - created_at)::text AS warn,
             (resolution_due_at - created_at)::text AS rdue, (resolution_warn_at - created_at)::text AS rwarn
        FROM tickets WHERE org_id = '${org.id}' AND subject IN ('fractional-at-risk', 'resumed-due') ORDER BY subject`));
    expect([...exact]).toEqual([
      { subject: 'fractional-at-risk', due: '00:07:00', warn: '00:05:36', rdue: '00:45:00', rwarn: '00:36:00' },
      { subject: 'resumed-due', due: '01:40:00', warn: '01:28:00', rdue: '08:40:00', rwarn: '07:04:00' },
    ]);
  });

  runDb('backfill restamps the Partner API feed once per touched ticket (Gate B3)', async () => {
    const { org } = await seedFixtures();
    const db = getTestDb();
    const xids = async () => new Map([...await db.execute<{ subject: string; x: string }>(
      sql.raw(`SELECT subject, partner_feed_xid::text AS x FROM tickets WHERE org_id = '${org.id}'`),
    )].map((r) => [r.subject, r.x]));
    const before = await xids();
    await applyNoTransaction(BACKFILL);
    const after = await xids();
    expect(after.get('on-track')).not.toBe(before.get('on-track'));
    // A ticket with no target and no pause history is not rewritten.
    expect(after.get('null-targets')).toBe(before.get('null-targets'));
    // Re-running is a no-op: nothing matches, nothing is re-delivered again.
    await applyNoTransaction(BACKFILL);
    expect(await xids()).toEqual(after);
  });

  runDb('backfill is resumable', async () => {
    const { org, count } = await seedFixtures();
    const db = getTestDb();

    // Reference end state from one uninterrupted run.
    await applyNoTransaction(BACKFILL);
    const reference = await storedState(org.id);
    await resetStored(org.id);

    // Interrupted run, as the unprivileged runtime role under FORCE RLS: the
    // procedure must re-elect system scope after every COMMIT or batches after
    // the first silently match zero rows. A trigger aborts the third row
    // written, i.e. the first row of the second 2-row batch.
    const statements = splitSqlStatements(await migrationSql(BACKFILL));
    const createProcedure = statements.find((s) => /^CREATE OR REPLACE PROCEDURE/i.test(s));
    expect(createProcedure).toBeDefined();
    await db.execute(sql.raw(createProcedure!));
    // nextval is not transactional, so the count survives each batch COMMIT.
    await db.execute(sql.raw(`
      CREATE SEQUENCE IF NOT EXISTS public.w3_backfill_abort_seq;
      CREATE OR REPLACE FUNCTION public.w3_abort_after_two() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('public.w3_backfill_abort_seq') > 2 THEN RAISE EXCEPTION 'w3 test: simulated interruption'; END IF;
        RETURN NEW;
      END $$;
      GRANT USAGE ON SEQUENCE public.w3_backfill_abort_seq TO breeze_app;
      CREATE TRIGGER w3_abort_after_two BEFORE UPDATE ON public.tickets
        FOR EACH ROW EXECUTE FUNCTION public.w3_abort_after_two();`));
    try {
      const app = postgres(process.env.DATABASE_URL_APP!, { max: 1, onnotice: () => {} });
      try {
        await expect(app.unsafe('CALL public.breeze_backfill_ticket_sla_deadlines(2)')).rejects.toThrow(/simulated interruption/);
      } finally {
        await app.end();
      }
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS w3_abort_after_two ON public.tickets;
        DROP FUNCTION IF EXISTS public.w3_abort_after_two();
        DROP SEQUENCE IF EXISTS public.w3_backfill_abort_seq;`));
    }

    // Exactly the first batch committed.
    const partial = await db.execute<{ n: number }>(sql.raw(`
      SELECT count(*)::int AS n FROM tickets
       WHERE org_id = '${org.id}'
         AND (response_due_at IS NOT NULL OR resolution_due_at IS NOT NULL OR sla_paused_business_minutes > 0)`));
    expect([...partial][0]!.n).toBe(2);

    // Resume as breeze_app with a small batch: every remaining row is reached
    // across several COMMITs (proves the per-iteration scope election).
    const app = postgres(process.env.DATABASE_URL_APP!, { max: 1, onnotice: () => {} });
    try {
      await app.unsafe('CALL public.breeze_backfill_ticket_sla_deadlines(2)');
    } finally {
      await app.end();
    }
    expect(await storedState(org.id)).toEqual(reference);

    // Then the whole file (CREATE, CALL, DROP) re-runs as a no-op and leaves
    // no procedure behind.
    await applyNoTransaction(BACKFILL);
    expect(await storedState(org.id)).toEqual(reference);
    const leftover = await db.execute<{ n: number }>(sql.raw(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'breeze_backfill_ticket_sla_deadlines'`));
    expect([...leftover][0]!.n).toBe(0);
    expect(reference).toHaveLength(count);
  });

  runDb('the stored-deadline sweep uses the partial due-at indexes', async () => {
    await seedFixtures();
    await applyNoTransaction(INDEXES);
    const db = getTestDb();
    const plan = async (target: 'response' | 'resolution') => {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql.raw('SET LOCAL enable_seqscan = off'));
        await tx.execute(sql.raw('SET LOCAL enable_bitmapscan = off'));
        return tx.execute<{ 'QUERY PLAN': string }>(sql.raw(`
          EXPLAIN SELECT id FROM tickets
           WHERE ${newBreachDue(target)}
           ORDER BY ${target === 'response' ? 'response_due_at' : 'resolution_due_at'} ASC
           LIMIT 500`));
      });
      return [...rows].map((r) => r['QUERY PLAN']).join('\n');
    };
    expect(await plan('response')).toContain('tickets_sla_response_due_idx');
    expect(await plan('resolution')).toContain('tickets_sla_resolution_due_idx');

    const valid = await db.execute<{ relname: string; indisvalid: boolean }>(sql.raw(`
      SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname IN ('tickets_sla_response_due_idx', 'tickets_sla_resolution_due_idx', 'tickets_sla_sweep_idx')
       ORDER BY c.relname`));
    // Gate B7: the old created_at sweep index is kept through W3.
    expect([...valid]).toEqual([
      { relname: 'tickets_sla_resolution_due_idx', indisvalid: true },
      { relname: 'tickets_sla_response_due_idx', indisvalid: true },
      { relname: 'tickets_sla_sweep_idx', indisvalid: true },
    ]);
  });

  runDb('heals a ticket written without deadlines and then stamps its breach (Gate B12)', async () => {
    // A pre-W3 API instance still serving during the deploy inserts a ticket
    // with targets but no stored deadlines; the stored-deadline sweep alone
    // would never breach it.
    const { org } = await seedFixtures(); // all rows pre-W3-shaped: no stored deadlines
    const { withSystemDbAccessContext } = await import('../../db');
    const { healMissingDeadlines, sweepTicketSlaBreaches } = await import('../../jobs/ticketSlaWorker');

    // The worker runs the heal in its own system transaction, then the sweep.
    await withSystemDbAccessContext(() => healMissingDeadlines());
    const stamped = await withSystemDbAccessContext(() => sweepTicketSlaBreaches());

    const db = getTestDb();
    const stampedSubjects = async (target: 'response' | 'resolution') => [...await db.execute<{ subject: string }>(sql.raw(`
      SELECT subject FROM tickets
       WHERE org_id = '${org.id}' AND '${target}' = ANY(string_to_array(COALESCE(sla_breach_reason, ''), ','))
       ORDER BY subject`))].map((r) => r.subject);
    // Exactly the pre-W3 sweep's breach-due sets were stamped this tick; the
    // two fixtures that already carried a stamp keep it and are not re-stamped.
    expect(stamped.map((r) => `${r.target}:${r.subject}`).sort()).toEqual([
      'resolution:reopened',
      'resolution:responded-resolution-due',
      'resolution:response-stamped-resolution-due',
      'response:response-breach-due',
      'response:response-only-target',
      'response:resumed-due',
    ]);
    expect(await stampedSubjects('response')).toEqual([
      'both-stamped', 'response-breach-due', 'response-only-target', 'response-stamped-resolution-due', 'resumed-due',
    ]);
    expect(await stampedSubjects('resolution')).toEqual([
      'both-stamped', 'reopened', 'responded-resolution-due', 'response-stamped-resolution-due',
    ]);
    // Healed with the wall-clock formula: no ticket with a target is left without a deadline.
    const missing = await db.execute<{ n: number }>(sql.raw(`
      SELECT count(*)::int AS n FROM tickets
       WHERE org_id = '${org.id}'
         AND ((response_sla_minutes IS NOT NULL AND response_due_at IS NULL)
           OR (resolution_sla_minutes IS NOT NULL AND resolution_due_at IS NULL))`));
    expect([...missing][0]!.n).toBe(0);
    // A second tick stamps nothing more (one-shot rule).
    expect(await withSystemDbAccessContext(() => sweepTicketSlaBreaches())).toEqual([]);
  });

  runDb('heals a pause a pre-W3 instance folded into sla_paused_minutes only, so no false breach (Gate B12)', async () => {
    const partner = await createPartner({ name: 'SlaHeal-Partner' });
    const org = await createOrganization({ partnerId: partner.id, name: 'SlaHeal-Org' });
    const db = getTestDb();
    const base = { orgId: org.id, partnerId: partner.id, source: 'api' as const, priority: 'normal' as const, status: 'open' as const };
    const created = minutesAgo(70);
    const due = new Date(created.getTime() + 60 * 60_000);
    // Both written by the W3 code: deadlines stored, no pause yet.
    for (const [subject, extra] of [
      ['unanswered', {}],
      ['answered', { firstResponseAt: minutesAgo(65) }],
    ] as const) {
      await db.insert(tickets).values({
        ...base, ...extra, subject, ticketNumber: `HEAL-${crypto.randomUUID().slice(0, 8)}`, createdAt: created,
        responseSlaMinutes: 60, resolutionSlaMinutes: 480,
        responseDueAt: due, responseWarnAt: new Date(created.getTime() + 48 * 60_000),
        resolutionDueAt: new Date(created.getTime() + 480 * 60_000), resolutionWarnAt: new Date(created.getTime() + 384 * 60_000),
      });
    }
    // A pre-W3 instance ends a 30-minute pause: it folds sla_paused_minutes only.
    await db.execute(sql.raw(`UPDATE tickets SET sla_paused_minutes = 30 WHERE org_id = '${org.id}'`));

    const { withSystemDbAccessContext } = await import('../../db');
    const { healMissingDeadlines, sweepTicketSlaBreaches } = await import('../../jobs/ticketSlaWorker');
    expect(await withSystemDbAccessContext(() => healMissingDeadlines())).toBe(2);
    // 70 minutes in, 30 of them paused: the true response deadline is +90, not +60.
    expect(await withSystemDbAccessContext(() => sweepTicketSlaBreaches())).toEqual([]);

    const rows = new Map([...await db.execute<{ subject: string; b: number; rdue: string; resdue: string }>(sql.raw(`
      SELECT subject, sla_paused_business_minutes AS b,
             (response_due_at - created_at)::text AS rdue, (resolution_due_at - created_at)::text AS resdue
        FROM tickets WHERE org_id = '${org.id}'`))].map((r) => [r.subject, r]));
    expect(rows.get('unanswered')).toMatchObject({ b: 30, rdue: '01:30:00', resdue: '08:30:00' });
    // A frozen arm keeps its deadline; only the unfrozen resolution arm moves.
    expect(rows.get('answered')).toMatchObject({ b: 30, rdue: '01:00:00', resdue: '08:30:00' });
    // Healed rows leave the heal predicate: a second tick touches nothing.
    expect(await withSystemDbAccessContext(() => healMissingDeadlines())).toBe(0);
  });

  // #8973 W4 rebuilt the index (2027-01-03-160100) with
  // `sla_calendar_revision_id IS NULL` ANDed onto the whole predicate, matching
  // healMissingDeadlines(); re-applying that file is a drop + rebuild.
  runDb('the heal pass probes the partial missing-deadline index', async () => {
    await seedFixtures();
    await applyNoTransaction(INDEXES);
    await applyNoTransaction(CALENDAR_REVISION);
    const db = getTestDb();
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw('SET LOCAL enable_seqscan = off'));
      return tx.execute<{ 'QUERY PLAN': string }>(sql.raw(`
        EXPLAIN SELECT id FROM tickets
         WHERE sla_calendar_revision_id IS NULL
           AND ((response_sla_minutes IS NOT NULL AND response_due_at IS NULL)
             OR (resolution_sla_minutes IS NOT NULL AND resolution_due_at IS NULL)
             OR sla_paused_business_minutes < COALESCE(sla_paused_minutes, 0))
         ORDER BY created_at ASC LIMIT 500`));
    });
    expect([...rows].map((r) => r['QUERY PLAN']).join('\n')).toContain('tickets_sla_deadlines_missing_idx');
  });

  // #8973 W4 hand-off: a ticket on a business calendar accrues business pause
  // minutes that legitimately differ from sla_paused_minutes; its deadlines
  // belong to the calendar-aware writers, so the wall-clock heal skips it.
  runDb('the heal is a no-op on a calendar ticket whose business minutes differ from sla_paused_minutes', async () => {
    const partner = await createPartner({ name: 'SlaHealCal-Partner' });
    const org = await createOrganization({ partnerId: partner.id, name: 'SlaHealCal-Org' });
    const db = getTestDb();
    const [cal] = [...await db.execute<{ id: string }>(sql`
      INSERT INTO business_calendars (partner_id, name) VALUES (${partner.id}, 'Heal IT') RETURNING id`)];
    const [rev] = [...await db.execute<{ id: string }>(sql`
      INSERT INTO business_calendar_revisions (calendar_id, partner_id, revision, timezone)
      VALUES (${cal!.id}, ${partner.id}, 1, 'UTC') RETURNING id`)];
    const created = minutesAgo(600);
    const responseDueAt = new Date(created.getTime() + 900 * 60_000);
    await db.insert(tickets).values({
      orgId: org.id, partnerId: partner.id, source: 'api', priority: 'normal', status: 'open',
      subject: 'calendar-ticket', ticketNumber: `HEALCAL-${crypto.randomUUID().slice(0, 8)}`, createdAt: created,
      slaCalendarRevisionId: rev!.id,
      responseSlaMinutes: 60, resolutionSlaMinutes: 480,
      // 120 wall-clock paused minutes, of which only 10 fell in business hours.
      slaPausedMinutes: 120, slaPausedBusinessMinutes: 10,
      responseDueAt, responseWarnAt: new Date(created.getTime() + 840 * 60_000),
      resolutionDueAt: null, resolutionWarnAt: null,
    });
    const before = await storedState(org.id);

    const { withSystemDbAccessContext } = await import('../../db');
    const { healMissingDeadlines } = await import('../../jobs/ticketSlaWorker');
    expect(await withSystemDbAccessContext(() => healMissingDeadlines())).toBe(0);
    expect(await storedState(org.id)).toEqual(before);
    expect(before[0]).toMatchObject({ sla_paused_business_minutes: 10, resolution_due_at: null });
  });

  runDb('the backfill reaches rows only under system scope (FORCE RLS binds breeze_app)', async () => {
    const { org } = await seedFixtures();
    // Control: without the election a breeze_app UPDATE sees no ticket at all.
    const app = getAppDb();
    const visible = await app.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM tickets WHERE org_id = '${org.id}'`));
    expect([...visible][0]!.n).toBe(0);
  });
});
