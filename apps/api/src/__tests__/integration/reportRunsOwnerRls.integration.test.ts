/**
 * #4247 — report_runs direct dual-axis tenancy, proven against real Postgres
 * as the forced-RLS `breeze_app` role.
 *
 * Migrations under test: 2026-12-17-160000 … 2026-12-17-160300.
 *
 * report_runs follows its parent definition: a run of an org-owned report
 * carries `org_id` (partner_id NULL), a run of a partner-owned report carries
 * `partner_id` (org_id NULL) — never both (`report_runs_one_owner_chk`), and
 * always the parent's actual owner (composite DEFERRABLE FKs
 * `(report_id, org_id) → reports(id, org_id)` and
 * `(report_id, partner_id) → reports(id, partner_id)`).
 *
 * RLS is one direct FOR ALL owner policy plus the SELECT-only report-history
 * branch. Like `reports`, there is deliberately NO org-readable partner-wide
 * SELECT branch: a run of a partner-owned aggregate must never be legible to
 * an org-scope session of the same partner.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { reports } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import {
  partnerWideScope,
  persistedSiteScopeValues,
  siteScopeFingerprint,
} from '../../services/siteScope';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

const MIGRATIONS_DIR = resolve(__dirname, '../../../migrations');
const BACKFILL_SQL = readFileSync(resolve(MIGRATIONS_DIR, '2026-12-17-160100-report-runs-owner-backfill.sql'), 'utf8');
const CONSTRAINTS_SQL = readFileSync(resolve(MIGRATIONS_DIR, '2026-12-17-160200-report-runs-owner-constraints.sql'), 'utf8');

class Rollback extends Error {}

function partnerContext(partnerId: string, orgIds: string[] = []): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** An org token carries its OWN partner as currentPartnerId (see reportsPartnerRls). */
function orgContext(orgId: string, currentPartnerId: string | null = null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

function historyContext(partnerId: string, historyOrgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
    reportHistoryOrgIds: historyOrgIds,
  };
}

/** postgres.js wraps the server error; the SQLSTATE lives on the cause chain. */
function sqlState(err: unknown): string | undefined {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function expectSqlState(p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(sqlState(caught)).toBe(code);
}

function email(label: string): string {
  return `rr-owner-${label}-${randomUUID()}@example.com`;
}

async function seedOrgReport(orgId: string, userId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(reports)
    .values({ orgId, name: 'Inventory', type: 'device_inventory', createdBy: userId })
    .returning({ id: reports.id });
  return row!.id;
}

async function seedPartnerReport(partnerId: string, userId: string): Promise<string> {
  const scope = partnerWideScope(partnerId);
  const [row] = await getTestDb()
    .insert(reports)
    .values({
      partnerId,
      orgId: null,
      name: 'Partner AR aging',
      type: 'ar_aging',
      createdBy: userId,
      ...persistedSiteScopeValues({
        principalKind: 'user',
        scope,
        principalUserId: userId,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(scope),
      }),
    })
    .returning({ id: reports.id });
  return row!.id;
}

/** Owner-role insert with explicit owner columns (bypasses RLS; FK/CHECK still apply). */
async function ownerInsertRun(reportId: string, orgId: string | null, partnerId: string | null): Promise<string> {
  const rows = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO report_runs (report_id, org_id, partner_id, status)
    VALUES (${reportId}, ${orgId}, ${partnerId}, 'completed')
    RETURNING id
  `);
  return rows[0]!.id;
}

async function ownerOf(runId: string): Promise<{ org_id: string | null; partner_id: string | null }> {
  const rows = await getTestDb().execute<{ org_id: string | null; partner_id: string | null }>(sql`
    SELECT org_id, partner_id FROM report_runs WHERE id = ${runId}
  `);
  return rows[0]!;
}

async function visibleRuns(context: DbAccessContext, ids: string[]): Promise<string[]> {
  const rows = await withDbAccessContext(context, () =>
    db.execute<{ id: string }>(sql`
      SELECT id FROM report_runs WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `),
  );
  return Array.from(rows as Iterable<{ id: string }>).map((r) => r.id).sort();
}

async function seedWorld() {
  const partner = await createPartner();
  const otherPartner = await createPartner();
  const user = await createUser({ partnerId: partner.id, email: email('u') });
  const otherUser = await createUser({ partnerId: otherPartner.id, email: email('o') });
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const reportA = await seedOrgReport(orgA.id, user.id);
  const reportB = await seedOrgReport(orgB.id, user.id);
  const partnerReport = await seedPartnerReport(partner.id, user.id);
  const otherPartnerReport = await seedPartnerReport(otherPartner.id, otherUser.id);
  return { partner, otherPartner, user, orgA, orgB, reportA, reportB, partnerReport, otherPartnerReport };
}

describe('report_runs direct dual-axis tenancy (#4247)', () => {
  runDb('schema: nullable org_id + partner_id, XOR check, two DEFERRABLE composite FKs, nonpartial reports(id, partner_id) key', async () => {
    const cols = await getTestDb().execute<{ column_name: string; is_nullable: string }>(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'report_runs' AND column_name IN ('org_id', 'partner_id')
       ORDER BY column_name
    `);
    expect(Array.from(cols)).toEqual([
      { column_name: 'org_id', is_nullable: 'YES' },
      { column_name: 'partner_id', is_nullable: 'YES' },
    ]);

    const fks = await getTestDb().execute<{ conname: string; deferrable: boolean; deferred: boolean; validated: boolean; def: string }>(sql`
      SELECT conname, condeferrable AS deferrable, condeferred AS deferred, convalidated AS validated,
             pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'public.report_runs'::regclass
         AND conname IN ('report_runs_report_org_fk', 'report_runs_report_partner_fk', 'report_runs_one_owner_chk')
       ORDER BY conname
    `);
    const byName = Object.fromEntries(Array.from(fks).map((r) => [r.conname, r]));
    expect(Object.keys(byName).sort()).toEqual([
      'report_runs_one_owner_chk',
      'report_runs_report_org_fk',
      'report_runs_report_partner_fk',
    ]);
    for (const name of ['report_runs_report_org_fk', 'report_runs_report_partner_fk']) {
      expect(byName[name]!.deferrable, name).toBe(true);
      expect(byName[name]!.deferred, `${name} must be INITIALLY IMMEDIATE`).toBe(false);
      expect(byName[name]!.validated, name).toBe(true);
    }
    expect(byName.report_runs_report_org_fk!.def).toContain('REFERENCES reports(id, org_id)');
    expect(byName.report_runs_report_partner_fk!.def).toContain('REFERENCES reports(id, partner_id)');
    expect(byName.report_runs_one_owner_chk!.validated).toBe(true);

    const idx = await getTestDb().execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'reports_id_partner_id_uniq'
    `);
    expect(Array.from(idx)).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain('UNIQUE');
    expect(idx[0]!.indexdef).not.toContain('WHERE');
  });

  runDb('policies: one FOR ALL owner policy + the SELECT-only history branch, no parent EXISTS join, no org-readable partner-wide branch', async () => {
    const rows = await getTestDb().execute<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }>(sql`
      SELECT policyname, cmd, qual, with_check FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'report_runs'
       ORDER BY policyname
    `);
    const list = Array.from(rows);
    expect(list.map((r) => `${r.policyname}:${r.cmd}`)).toEqual([
      'report_runs_owner_isolation:ALL',
      'report_runs_report_history_select:SELECT',
    ]);
    for (const r of list) {
      const text = `${r.qual ?? ''} ${r.with_check ?? ''}`;
      expect(text, r.policyname).not.toMatch(/FROM\s+reports/i);
      expect(text, r.policyname).not.toContain('breeze_current_partner_id');
    }
    const owner = list.find((r) => r.policyname === 'report_runs_owner_isolation')!;
    for (const predicate of [owner.qual ?? '', owner.with_check ?? '']) {
      expect(predicate).toContain('breeze_has_org_access(org_id)');
      expect(predicate).toContain('breeze_has_partner_access(partner_id)');
    }
    const history = list.find((r) => r.policyname === 'report_runs_report_history_select')!;
    expect(history.qual ?? '').toContain('breeze_has_report_history_access(org_id)');
  });

  runDb('a run created without owner columns inherits its parent owner (org and partner axis)', async () => {
    const w = await seedWorld();
    const [orgRun] = await getTestDb().execute<{ id: string }>(sql`
      INSERT INTO report_runs (report_id, status) VALUES (${w.reportA}, 'completed') RETURNING id
    `);
    const [partnerRun] = await getTestDb().execute<{ id: string }>(sql`
      INSERT INTO report_runs (report_id, status) VALUES (${w.partnerReport}, 'completed') RETURNING id
    `);
    expect(await ownerOf(orgRun!.id)).toEqual({ org_id: w.orgA.id, partner_id: null });
    expect(await ownerOf(partnerRun!.id)).toEqual({ org_id: null, partner_id: w.partner.id });
  });

  runDb('the owner fill runs as the inserting breeze_app session: a visible parent fills, an invisible one cannot leak', async () => {
    const w = await seedWorld();
    // The rolling-deploy path: an old writer omits both owner columns.
    const orgRows = await withDbAccessContext(orgContext(w.orgA.id, w.partner.id), () =>
      db.execute<{ org_id: string | null; partner_id: string | null }>(sql`
        INSERT INTO report_runs (report_id, status) VALUES (${w.reportA}, 'running') RETURNING org_id, partner_id
      `),
    );
    expect(orgRows[0]).toEqual({ org_id: w.orgA.id, partner_id: null });
    const partnerRows = await withDbAccessContext(partnerContext(w.partner.id), () =>
      db.execute<{ org_id: string | null; partner_id: string | null }>(sql`
        INSERT INTO report_runs (report_id, status) VALUES (${w.partnerReport}, 'running') RETURNING org_id, partner_id
      `),
    );
    expect(partnerRows[0]).toEqual({ org_id: null, partner_id: w.partner.id });

    // A SECURITY DEFINER fill would read org B's parent and copy its owner into
    // a row org A then writes; the invoker fill sees nothing and the row is refused.
    await expectSqlState(
      withDbAccessContext(orgContext(w.orgA.id, w.partner.id), () =>
        db.execute(sql`INSERT INTO report_runs (report_id, status) VALUES (${w.reportB}, 'running')`),
      ),
      '42501',
    );
    const leaked = await getTestDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM report_runs WHERE report_id = ${w.reportB}
    `);
    expect(leaked[0]!.n).toBe(0);
  });

  runDb('rejects both-axes (23514) and an owner that is not the parent owner (23503), even as the table owner', async () => {
    const w = await seedWorld();
    await expectSqlState(ownerInsertRun(w.reportA, w.orgA.id, w.partner.id), '23514');
    await expectSqlState(ownerInsertRun(w.reportA, w.orgB.id, null), '23503');
    await expectSqlState(ownerInsertRun(w.reportA, null, w.partner.id), '23503');
    await expectSqlState(ownerInsertRun(w.partnerReport, null, w.otherPartner.id), '23503');
    await expectSqlState(ownerInsertRun(w.partnerReport, w.orgA.id, null), '23503');
  });

  runDb('org isolation: org A reads/writes its own runs only; cross-org forge is refused (42501)', async () => {
    const w = await seedWorld();
    const runA = await ownerInsertRun(w.reportA, w.orgA.id, null);
    const runB = await ownerInsertRun(w.reportB, w.orgB.id, null);

    expect(await visibleRuns(orgContext(w.orgA.id, w.partner.id), [runA, runB])).toEqual([runA]);

    // A session of org A cannot write a run of org B's report, with or without
    // naming org B.
    await expectSqlState(
      withDbAccessContext(orgContext(w.orgA.id, w.partner.id), () =>
        db.execute(sql`INSERT INTO report_runs (report_id, org_id, status) VALUES (${w.reportB}, ${w.orgB.id}, 'completed')`),
      ),
      '42501',
    );
    await expectSqlState(
      withDbAccessContext(orgContext(w.orgA.id, w.partner.id), () =>
        db.execute(sql`INSERT INTO report_runs (report_id, status) VALUES (${w.reportB}, 'completed')`),
      ),
      // The parent is invisible to org A, so the owner fill finds nothing and
      // the ownerless row fails the policy's WITH CHECK (evaluated before
      // ordinary constraints).
      '42501',
    );

    // Its own insert succeeds and lands on its own axis.
    const rows = await withDbAccessContext(orgContext(w.orgA.id, w.partner.id), () =>
      db.execute<{ id: string; org_id: string; partner_id: string | null }>(sql`
        INSERT INTO report_runs (report_id, org_id, status) VALUES (${w.reportA}, ${w.orgA.id}, 'running')
        RETURNING id, org_id, partner_id
      `),
    );
    expect(rows[0]!.org_id).toBe(w.orgA.id);
    expect(rows[0]!.partner_id).toBeNull();

    // UPDATE / DELETE of another org's run match no row.
    const upd = await withDbAccessContext(orgContext(w.orgA.id, w.partner.id), () =>
      db.execute(sql`UPDATE report_runs SET status = 'failed' WHERE id = ${runB} RETURNING id`),
    );
    expect(Array.from(upd)).toHaveLength(0);
    const del = await withDbAccessContext(orgContext(w.orgA.id, w.partner.id), () =>
      db.execute(sql`DELETE FROM report_runs WHERE id = ${runB} RETURNING id`),
    );
    expect(Array.from(del)).toHaveLength(0);
  });

  runDb('partner axis: the owning partner sees its runs; an org token of the same partner and another partner see nothing', async () => {
    const w = await seedWorld();
    const pRun = await ownerInsertRun(w.partnerReport, null, w.partner.id);
    const otherRun = await ownerInsertRun(w.otherPartnerReport, null, w.otherPartner.id);

    expect(await visibleRuns(partnerContext(w.partner.id, [w.orgA.id, w.orgB.id]), [pRun, otherRun])).toEqual([pRun]);
    // No partner-wide SELECT branch: an org session of the SAME partner is blind.
    expect(await visibleRuns(orgContext(w.orgA.id, w.partner.id), [pRun])).toEqual([]);
    expect(await visibleRuns(partnerContext(w.otherPartner.id), [pRun])).toEqual([]);

    // Partner insert on its own report succeeds; a forged cross-partner insert is refused.
    const ok = await withDbAccessContext(partnerContext(w.partner.id), () =>
      db.execute<{ partner_id: string }>(sql`
        INSERT INTO report_runs (report_id, partner_id, status) VALUES (${w.partnerReport}, ${w.partner.id}, 'running')
        RETURNING partner_id
      `),
    );
    expect(ok[0]!.partner_id).toBe(w.partner.id);
    await expectSqlState(
      withDbAccessContext(partnerContext(w.partner.id), () =>
        db.execute(sql`
          INSERT INTO report_runs (report_id, partner_id, status)
          VALUES (${w.otherPartnerReport}, ${w.otherPartner.id}, 'running')
        `),
      ),
      '42501',
    );
    // Neither an org session of the same partner nor another partner can
    // change or delete the partner-owned run.
    for (const ctx of [orgContext(w.orgA.id, w.partner.id), partnerContext(w.otherPartner.id)]) {
      const upd = await withDbAccessContext(ctx, () =>
        db.execute(sql`UPDATE report_runs SET status = 'failed' WHERE id = ${pRun} RETURNING id`),
      );
      expect(Array.from(upd)).toHaveLength(0);
      const del = await withDbAccessContext(ctx, () =>
        db.execute(sql`DELETE FROM report_runs WHERE id = ${pRun} RETURNING id`),
      );
      expect(Array.from(del)).toHaveLength(0);
    }
    const intact = await getTestDb().execute<{ status: string }>(sql`SELECT status FROM report_runs WHERE id = ${pRun}`);
    expect(intact[0]!.status).toBe('completed');

    // An org session cannot create a run of the partner's report either.
    await expectSqlState(
      withDbAccessContext(orgContext(w.orgA.id, w.partner.id), () =>
        db.execute(sql`
          INSERT INTO report_runs (report_id, partner_id, status) VALUES (${w.partnerReport}, ${w.partner.id}, 'running')
        `),
      ),
      '42501',
    );
  });

  runDb('report-history branch: SELECT-only on the run’s own org_id; every write is refused or matches nothing', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, email: email('h') });
    const historyOrg = await createOrganization({ partnerId: partner.id, status: 'suspended' });
    const reportId = await seedOrgReport(historyOrg.id, user.id);
    const runId = await ownerInsertRun(reportId, historyOrg.id, null);
    const ctx = historyContext(partner.id, [historyOrg.id]);

    // Bound of the grant: a suspended org the GUC does not list stays invisible.
    const otherHistoryOrg = await createOrganization({ partnerId: partner.id, status: 'suspended' });
    const otherReportId = await seedOrgReport(otherHistoryOrg.id, user.id);
    const otherRunId = await ownerInsertRun(otherReportId, otherHistoryOrg.id, null);

    expect(await visibleRuns(ctx, [runId, otherRunId])).toEqual([runId]);
    // Without the opt-in GUC the plain partner context cannot see the suspended org's run.
    expect(await visibleRuns(partnerContext(partner.id), [runId])).toEqual([]);

    await expectSqlState(
      withDbAccessContext(ctx, () =>
        db.execute(sql`INSERT INTO report_runs (report_id, org_id, status) VALUES (${reportId}, ${historyOrg.id}, 'running')`),
      ),
      '42501',
    );
    const upd = await withDbAccessContext(ctx, () =>
      db.execute(sql`UPDATE report_runs SET status = 'failed' WHERE id = ${runId} RETURNING id`),
    );
    expect(Array.from(upd)).toHaveLength(0);
    const del = await withDbAccessContext(ctx, () =>
      db.execute(sql`DELETE FROM report_runs WHERE id = ${runId} RETURNING id`),
    );
    expect(Array.from(del)).toHaveLength(0);
    expect(await ownerOf(runId)).toEqual({ org_id: historyOrg.id, partner_id: null });
  });

  runDb('composite FKs are deferrable: parent and run may be re-pointed in separate statements under SET CONSTRAINTS ALL DEFERRED', async () => {
    const w = await seedWorld();
    const runId = await ownerInsertRun(w.reportA, w.orgA.id, null);

    // Re-pointing only the parent fails at commit when the run is left behind.
    await expectSqlState(
      getTestDb().transaction(async (tx) => {
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        await tx.execute(sql`UPDATE reports SET org_id = ${w.orgB.id} WHERE id = ${w.reportA}`);
      }),
      '23503',
    );

    // Re-pointing both (in either order) commits.
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`UPDATE report_runs SET org_id = ${w.orgB.id} WHERE id = ${runId}`);
      await tx.execute(sql`UPDATE reports SET org_id = ${w.orgB.id} WHERE id = ${w.reportA}`);
    });
    expect(await ownerOf(runId)).toEqual({ org_id: w.orgB.id, partner_id: null });
  });

  runDb('backfill + constraints replay: legacy ownerless runs take their parent owner, then validate', async () => {
    const w = await seedWorld();
    let observed: Array<{ id: string; org_id: string | null; partner_id: string | null }> = [];
    const ids = { org: randomUUID(), partner: randomUUID() };
    // Recreate the pre-#4247 state inside a transaction that is rolled back:
    // no owner constraints, no fill trigger, ownerless rows. Then replay the
    // two shipped migration files verbatim.
    await expect(
      getTestDb().transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE report_runs DROP CONSTRAINT report_runs_one_owner_chk`);
        await tx.execute(sql`ALTER TABLE report_runs DROP CONSTRAINT report_runs_report_org_fk`);
        await tx.execute(sql`ALTER TABLE report_runs DROP CONSTRAINT report_runs_report_partner_fk`);
        await tx.execute(sql`ALTER TABLE report_runs DISABLE TRIGGER report_runs_fill_owner`);
        await tx.execute(sql`
          INSERT INTO report_runs (id, report_id, status) VALUES
            (${ids.org}, ${w.reportA}, 'completed'),
            (${ids.partner}, ${w.partnerReport}, 'completed')
        `);
        const before = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM report_runs
           WHERE id IN (${ids.org}, ${ids.partner}) AND org_id IS NULL AND partner_id IS NULL
        `);
        expect(before[0]!.n).toBe(2);
        await tx.execute(sql`ALTER TABLE report_runs ENABLE TRIGGER report_runs_fill_owner`);

        await tx.execute(sql.raw(BACKFILL_SQL));
        await tx.execute(sql.raw(BACKFILL_SQL)); // idempotent re-apply
        await tx.execute(sql.raw(CONSTRAINTS_SQL));
        await tx.execute(sql.raw(CONSTRAINTS_SQL)); // idempotent re-apply

        observed = Array.from(
          await tx.execute<{ id: string; org_id: string | null; partner_id: string | null }>(sql`
            SELECT id, org_id, partner_id FROM report_runs WHERE id IN (${ids.org}, ${ids.partner})
          `),
        );
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(new Map(observed.map((r) => [r.id, [r.org_id, r.partner_id]]))).toEqual(new Map([
      [ids.org, [w.orgA.id, null]],
      [ids.partner, [null, w.partner.id]],
    ]));
  });

  runDb('deleting a definition (either axis) cascades its runs', async () => {
    const w = await seedWorld();
    const orgRun = await ownerInsertRun(w.reportA, w.orgA.id, null);
    const partnerRun = await ownerInsertRun(w.partnerReport, null, w.partner.id);
    await getTestDb().execute(sql`DELETE FROM reports WHERE id IN (${w.reportA}, ${w.partnerReport})`);
    const left = await getTestDb().execute<{ id: string }>(sql`
      SELECT id FROM report_runs WHERE id IN (${orgRun}, ${partnerRun})
    `);
    expect(Array.from(left)).toHaveLength(0);
  });
});
