/**
 * Functional forge proof for the service-deliverable family (#5573 W01):
 * service_deliverables, service_deliverable_occurrences,
 * service_deliverable_evidence and organization_key_dates.
 *
 * All four are RLS shape 1 (direct org_id, breeze_has_org_access). These tests
 * run through the real driver as the unprivileged app role under the
 * integration config; do not run them with the plain unit-test config.
 *
 * Beyond the forge, this file proves the two structural contracts the tables
 * depend on: the evidence ownership chain (a run of another org's report is
 * refused by the composite (report_id, org_id) FK, not by app code) and the
 * org-merge re-point shape (SET CONSTRAINTS ALL DEFERRED, parent and child
 * org_id moved in separate statements).
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests, so a memoized fixture would be stale and vacuous.
 */
import './setup';
import { getTestDb } from './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as unknown as Row[];

async function seedTwoOrgs() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    return { partner, orgA, orgB, ctxA: orgContext(orgA.id), ctxB: orgContext(orgB.id) };
  });
}

async function sqlstate(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

/** Insert a deliverable (+ one occurrence) for `orgId` under the given context. */
async function insertDeliverable(ctx: DbAccessContext, orgId: string, name = 'Sign-in log review') {
  const d = rows(
    await withDbAccessContext(ctx, () =>
      db.execute(sql`
        INSERT INTO service_deliverables (org_id, name, cadence, anchor_due_date, effective_from)
        VALUES (${orgId}::uuid, ${name}, 'monthly', '2026-10-31', '2026-10-01')
        RETURNING id`),
    ),
  )[0]!.id as string;
  const o = rows(
    await withDbAccessContext(ctx, () =>
      db.execute(sql`
        INSERT INTO service_deliverable_occurrences
          (org_id, deliverable_id, name_snapshot, period_start, period_end, due_at, original_due_at)
        VALUES (${orgId}::uuid, ${d}::uuid, ${name}, '2026-10-01', '2026-10-31', '2026-10-31', '2026-10-31')
        RETURNING id`),
    ),
  )[0]!.id as string;
  return { deliverableId: d, occurrenceId: o };
}

async function insertReportWithRun(orgId: string) {
  return withSystemDbAccessContext(async () => {
    const report = rows(
      await db.execute(sql`
        INSERT INTO reports (org_id, name, type) VALUES (${orgId}::uuid, 'Monthly summary', 'ai_org_narrative')
        RETURNING id`),
    )[0]!.id as string;
    const run = rows(
      await db.execute(sql`
        INSERT INTO report_runs (report_id, status) VALUES (${report}::uuid, 'completed') RETURNING id`),
    )[0]!.id as string;
    return { reportId: report, runId: run };
  });
}

describe('service deliverables + key dates RLS — org-axis forge (breeze_app role)', () => {
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const { ctxA } = await seedTwoOrgs();
    const r = rows(
      await withDbAccessContext(ctxA, () =>
        db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`),
      ),
    )[0]!;
    expect(r.who).toBe('breeze_app');
    expect(r.rolbypassrls).toBe(false);
  });

  runDb('positive control: org A inserts and reads back its own deliverable, occurrence, evidence and key date', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const { occurrenceId } = await insertDeliverable(ctxA, orgA.id);
    const { reportId, runId } = await insertReportWithRun(orgA.id);
    await withDbAccessContext(ctxA, () =>
      db.execute(sql`
        INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, report_id, report_run_id)
        VALUES (${orgA.id}::uuid, ${occurrenceId}::uuid, 'report_run', ${reportId}::uuid, ${runId}::uuid)`),
    );
    await withDbAccessContext(ctxA, () =>
      db.execute(sql`
        INSERT INTO organization_key_dates (org_id, label, kind, date)
        VALUES (${orgA.id}::uuid, 'Cyber insurance renewal', 'insurance_renewal', '2027-03-01')`),
    );
    const counts = rows(
      await withDbAccessContext(ctxA, () =>
        db.execute(sql`
          SELECT (SELECT count(*) FROM service_deliverables)::int AS d,
                 (SELECT count(*) FROM service_deliverable_occurrences)::int AS o,
                 (SELECT count(*) FROM service_deliverable_evidence)::int AS e,
                 (SELECT count(*) FROM organization_key_dates)::int AS k`),
      ),
    )[0]!;
    expect(counts).toMatchObject({ d: 1, o: 1, e: 1, k: 1 });
  });

  runDb('cross-org forge: org A context cannot insert rows carrying org B (42501) on any of the four tables', async () => {
    const { orgA, orgB, ctxA, ctxB } = await seedTwoOrgs();
    // Parent rows for the child forges live legitimately in org B.
    const b = await insertDeliverable(ctxB, orgB.id);
    const { reportId, runId } = await insertReportWithRun(orgB.id);

    expect(
      await sqlstate(() =>
        withDbAccessContext(ctxA, () =>
          db.execute(sql`
            INSERT INTO service_deliverables (org_id, name, cadence, anchor_due_date, effective_from)
            VALUES (${orgB.id}::uuid, 'forged', 'monthly', '2026-10-31', '2026-10-01')`),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlstate(() =>
        withDbAccessContext(ctxA, () =>
          db.execute(sql`
            INSERT INTO service_deliverable_occurrences
              (org_id, deliverable_id, name_snapshot, period_start, period_end, due_at, original_due_at)
            VALUES (${orgB.id}::uuid, ${b.deliverableId}::uuid, 'forged', '2026-11-01', '2026-11-30', '2026-11-30', '2026-11-30')`),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlstate(() =>
        withDbAccessContext(ctxA, () =>
          db.execute(sql`
            INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, report_id, report_run_id)
            VALUES (${orgB.id}::uuid, ${b.occurrenceId}::uuid, 'report_run', ${reportId}::uuid, ${runId}::uuid)`),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlstate(() =>
        withDbAccessContext(ctxA, () =>
          db.execute(sql`
            INSERT INTO organization_key_dates (org_id, label, date) VALUES (${orgB.id}::uuid, 'forged', '2027-01-01')`),
        ),
      ),
    ).toBe('42501');

    // Positive control inside the same test: org A can still write its own org.
    expect(await sqlstate(() => insertDeliverable(ctxA, orgA.id, 'own'))).toBeUndefined();
  });

  runDb('cross-org read: org B rows are invisible to org A on every table', async () => {
    const { orgB, ctxA, ctxB } = await seedTwoOrgs();
    await insertDeliverable(ctxB, orgB.id);
    await withDbAccessContext(ctxB, () =>
      db.execute(sql`INSERT INTO organization_key_dates (org_id, label, date) VALUES (${orgB.id}::uuid, 'B only', '2027-01-01')`),
    );
    const seen = rows(
      await withDbAccessContext(ctxA, () =>
        db.execute(sql`
          SELECT (SELECT count(*) FROM service_deliverables)::int AS d,
                 (SELECT count(*) FROM service_deliverable_occurrences)::int AS o,
                 (SELECT count(*) FROM organization_key_dates)::int AS k`),
      ),
    )[0]!;
    expect(seen).toMatchObject({ d: 0, o: 0, k: 0 });
    const seenByB = rows(
      await withDbAccessContext(ctxB, () => db.execute(sql`SELECT count(*)::int AS d FROM service_deliverables`)),
    )[0]!;
    expect(seenByB.d).toBe(1); // non-vacuity: the rows exist
  });

  runDb('evidence ownership chain: a run of another org\'s report is refused by the composite FK (23503) even under system scope', async () => {
    const { orgA, orgB, ctxA } = await seedTwoOrgs();
    const { occurrenceId } = await insertDeliverable(ctxA, orgA.id);
    const foreign = await insertReportWithRun(orgB.id);
    const own = await insertReportWithRun(orgA.id);

    expect(
      await sqlstate(() =>
        withSystemDbAccessContext(() =>
          db.execute(sql`
            INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, report_id, report_run_id)
            VALUES (${orgA.id}::uuid, ${occurrenceId}::uuid, 'report_run', ${foreign.reportId}::uuid, ${foreign.runId}::uuid)`),
        ),
      ),
    ).toBe('23503');

    // A run that belongs to a DIFFERENT report of the same org is refused by (report_run_id, report_id).
    const own2 = await insertReportWithRun(orgA.id);
    expect(
      await sqlstate(() =>
        withSystemDbAccessContext(() =>
          db.execute(sql`
            INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, report_id, report_run_id)
            VALUES (${orgA.id}::uuid, ${occurrenceId}::uuid, 'report_run', ${own.reportId}::uuid, ${own2.runId}::uuid)`),
        ),
      ),
    ).toBe('23503');

    // Positive control: the matching (report, run) pair of the same org is accepted.
    expect(
      await sqlstate(() =>
        withSystemDbAccessContext(() =>
          db.execute(sql`
            INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, report_id, report_run_id)
            VALUES (${orgA.id}::uuid, ${occurrenceId}::uuid, 'report_run', ${own.reportId}::uuid, ${own.runId}::uuid)`),
        ),
      ),
    ).toBeUndefined();
  });

  runDb('org-merge re-point: parent and child org_id move in separate statements under SET CONSTRAINTS ALL DEFERRED', async () => {
    const { orgA, orgB, ctxA, ctxB } = await seedTwoOrgs();
    const { deliverableId, occurrenceId } = await insertDeliverable(ctxA, orgA.id);
    const { reportId, runId } = await insertReportWithRun(orgA.id);
    await withDbAccessContext(ctxA, () =>
      db.execute(sql`
        INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, report_id, report_run_id)
        VALUES (${orgA.id}::uuid, ${occurrenceId}::uuid, 'report_run', ${reportId}::uuid, ${runId}::uuid)`),
    );

    // The merge shape (orgMerge.ts): with IMMEDIATE composite FKs the first UPDATE
    // would 23503 the moment service_deliverables moves out from under its
    // occurrences. Deferral makes the whole walk commit.
    const adminDb = getTestDb() as never as typeof db;
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`UPDATE service_deliverables SET org_id = ${orgB.id}::uuid WHERE id = ${deliverableId}::uuid`);
      await tx.execute(sql`UPDATE reports SET org_id = ${orgB.id}::uuid WHERE id = ${reportId}::uuid`);
      await tx.execute(sql`UPDATE service_deliverable_occurrences SET org_id = ${orgB.id}::uuid WHERE deliverable_id = ${deliverableId}::uuid`);
      await tx.execute(sql`UPDATE service_deliverable_evidence SET org_id = ${orgB.id}::uuid WHERE occurrence_id = ${occurrenceId}::uuid`);
    });

    const seenByB = rows(
      await withDbAccessContext(ctxB, () =>
        db.execute(sql`
          SELECT (SELECT count(*) FROM service_deliverables)::int AS d,
                 (SELECT count(*) FROM service_deliverable_occurrences)::int AS o,
                 (SELECT count(*) FROM service_deliverable_evidence)::int AS e`),
      ),
    )[0]!;
    expect(seenByB).toMatchObject({ d: 1, o: 1, e: 1 });
  });

  runDb('cascade: deleting a deliverable removes its occurrences and evidence', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const { deliverableId, occurrenceId } = await insertDeliverable(ctxA, orgA.id);
    const { reportId, runId } = await insertReportWithRun(orgA.id);
    await withDbAccessContext(ctxA, () =>
      db.execute(sql`
        INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, report_id, report_run_id)
        VALUES (${orgA.id}::uuid, ${occurrenceId}::uuid, 'report_run', ${reportId}::uuid, ${runId}::uuid)`),
    );
    await withDbAccessContext(ctxA, () =>
      db.execute(sql`DELETE FROM service_deliverables WHERE id = ${deliverableId}::uuid`),
    );
    const left = rows(
      await withDbAccessContext(ctxA, () =>
        db.execute(sql`
          SELECT (SELECT count(*) FROM service_deliverable_occurrences)::int AS o,
                 (SELECT count(*) FROM service_deliverable_evidence)::int AS e`),
      ),
    )[0]!;
    expect(left).toMatchObject({ o: 0, e: 0 });
  });

  runDb('evidence kind CHECK: a report_run row without report_id is refused (23514)', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const { occurrenceId } = await insertDeliverable(ctxA, orgA.id);
    const { runId } = await insertReportWithRun(orgA.id);
    expect(
      await sqlstate(() =>
        withDbAccessContext(ctxA, () =>
          db.execute(sql`
            INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, report_run_id)
            VALUES (${orgA.id}::uuid, ${occurrenceId}::uuid, 'report_run', ${runId}::uuid)`),
        ),
      ),
    ).toBe('23514');
  });
});
