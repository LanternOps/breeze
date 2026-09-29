/**
 * Multi-org report series W02 — tenancy proof (spec §5 W02).
 *
 * Migrations under test: 2026-11-09-110000-report-series.sql and
 * 2026-11-09-110100-reports-series-children.sql.
 *
 * report_series is partner-axis (shape 3): breeze_has_partner_access only, so
 * an ORG token of the same partner reads nothing. report_series_org_targets is
 * shape 1 (breeze_has_org_access). The same-partner constraint triggers are
 * the only thing standing between a target/child row and another partner's
 * series — FK checks bypass RLS — so each is forged here, and each is proven
 * DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL DEFERRED).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { cascadeDeletePartner } from '../../services/tenantCascade';

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

/** An org token DOES carry its partner in currentPartnerId — that is the trap. */
function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId,
    userId: null,
  };
}

function system<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemDbAccessContext(fn);
}

async function rows<T>(ctx: DbAccessContext | null, query: SQL): Promise<T[]> {
  const run = () => db.execute(query) as unknown as Promise<T[]>;
  return ctx ? withDbAccessContext(ctx, run) : system(run);
}

/** SQLSTATE of a driver error, whether or not Drizzle wrapped it. */
function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}
function constraintOf(err: unknown): string | undefined {
  const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
  return e?.cause?.constraint_name ?? e?.constraint_name;
}
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the statement to fail');
}

async function seedTenancy() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  return {
    partnerA: partnerA.id,
    partnerB: partnerB.id,
    orgA1: orgA1.id,
    orgA2: orgA2.id,
    orgB1: orgB1.id,
  };
}

async function insertSeries(partnerId: string, ctx: DbAccessContext | null = null): Promise<string> {
  const id = randomUUID();
  await rows(ctx, sql`
    INSERT INTO report_series (id, partner_id, name, type, schedule)
    VALUES (${id}, ${partnerId}, 'Monthly summary', 'executive_summary', 'monthly')
  `);
  return id;
}

async function insertChild(orgId: string, seriesId: string | null, archived = false): Promise<string> {
  const id = randomUUID();
  await rows(null, sql`
    INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision, archived_at)
    VALUES (${id}, ${orgId}, 'Monthly summary', 'executive_summary', 'monthly',
            ${seriesId}, ${seriesId ? 1 : null}, ${archived ? sql`now()` : null})
  `);
  return id;
}

describe('report_series (shape 3, partner axis)', () => {
  it('ENABLE and FORCE row level security are on for both new tables', async () => {
    const flags = await rows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(null, sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('report_series', 'report_series_org_targets') ORDER BY relname
    `);
    expect(flags).toEqual([
      { relname: 'report_series', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'report_series_org_targets', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('a partner context inserts and reads its own series', async () => {
    const t = await seedTenancy();
    const id = await insertSeries(t.partnerA, partnerContext(t.partnerA, [t.orgA1, t.orgA2]));
    const read = await rows<{ id: string }>(partnerContext(t.partnerA, []), sql`SELECT id FROM report_series WHERE id = ${id}`);
    expect(read).toEqual([{ id }]);
  });

  it('FORGE: partner B cannot insert a series attributed to partner A (42501)', async () => {
    const t = await seedTenancy();
    const err = await failure(insertSeries(t.partnerA, partnerContext(t.partnerB, [t.orgB1])));
    expect(sqlState(err)).toBe('42501');
  });

  it('FORGE: partner B reads zero rows of partner A (with a system control)', async () => {
    const t = await seedTenancy();
    const id = await insertSeries(t.partnerA);
    expect(await rows(null, sql`SELECT id FROM report_series WHERE id = ${id}`)).toHaveLength(1);
    expect(await rows(partnerContext(t.partnerB, [t.orgB1]), sql`SELECT id FROM report_series WHERE id = ${id}`)).toHaveLength(0);
  });

  it('FORGE: an ORG token of the same partner cannot read report_series', async () => {
    const t = await seedTenancy();
    const id = await insertSeries(t.partnerA);
    expect(await rows(partnerContext(t.partnerA, []), sql`SELECT id FROM report_series WHERE id = ${id}`)).toHaveLength(1);
    expect(await rows(orgContext(t.orgA1, t.partnerA), sql`SELECT id FROM report_series WHERE partner_id = ${t.partnerA}`)).toHaveLength(0);
  });

  it('partner_id is immutable (report_series_partner_immutable)', async () => {
    const t = await seedTenancy();
    const id = await insertSeries(t.partnerA);
    const err = await failure(rows(null, sql`UPDATE report_series SET partner_id = ${t.partnerB} WHERE id = ${id}`));
    expect(sqlState(err)).toBe('23514');
    expect(constraintOf(err)).toBe('report_series_partner_immutable');
  });

  it('refuses a one_time schedule and an unknown target mode', async () => {
    const t = await seedTenancy();
    const oneTime = await failure(rows(null, sql`
      INSERT INTO report_series (partner_id, name, type, schedule)
      VALUES (${t.partnerA}, 'x', 'executive_summary', 'one_time')`));
    expect(constraintOf(oneTime)).toBe('report_series_schedule_recurring_chk');
    const mode = await failure(rows(null, sql`
      INSERT INTO report_series (partner_id, name, type, schedule, target_mode)
      VALUES (${t.partnerA}, 'x', 'executive_summary', 'monthly', 'some')`));
    expect(constraintOf(mode)).toBe('report_series_target_mode_chk');
  });
});

describe('report_series_org_targets (shape 1) and the same-partner trigger', () => {
  it('FORGE: partner B cannot insert a target row for partner A\'s org (42501)', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(rows(partnerContext(t.partnerB, [t.orgB1]), sql`
      INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgA1})`));
    expect(sqlState(err)).toBe('42501');
  });

  it('FORGE: a target naming another partner\'s org is rejected by the trigger (23514), even in system context', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(rows(null, sql`
      INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgB1})`));
    expect(sqlState(err)).toBe('23514');
    expect(constraintOf(err)).toBe('report_series_org_targets_same_partner');
  });

  it('the trigger is deferrable: a cross-partner target fails at COMMIT, not at the INSERT, under SET CONSTRAINTS ALL DEFERRED', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    let insertReturned = false;
    const err = await failure(system(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgB1})`);
      insertReturned = true;
    }));
    expect(insertReturned).toBe(true);
    expect(sqlState(err)).toBe('23514');
  });

  it('every new constraint trigger is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const triggers = await rows<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(null, sql`
      SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger
       WHERE tgname IN ('report_series_org_targets_same_partner', 'reports_series_child_same_partner',
                        'report_series_partner_immutable', 'organizations_partner_report_series_guard')
       ORDER BY tgname`);
    expect(triggers).toEqual([
      { tgname: 'organizations_partner_report_series_guard', tgdeferrable: true, tginitdeferred: false },
      { tgname: 'report_series_org_targets_same_partner', tgdeferrable: true, tginitdeferred: false },
      { tgname: 'report_series_partner_immutable', tgdeferrable: true, tginitdeferred: false },
      { tgname: 'reports_series_child_same_partner', tgdeferrable: true, tginitdeferred: false },
    ]);
  });

  it('an org cannot move to another partner while a series of its old partner targets it', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    await rows(null, sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgA1})`);
    const err = await failure(rows(null, sql`UPDATE organizations SET partner_id = ${t.partnerB} WHERE id = ${t.orgA1}`));
    expect(constraintOf(err)).toBe('organizations_partner_report_series_guard');
  });
});

describe('reports series columns', () => {
  it('FORGE: a child whose org belongs to another partner is rejected (reports_series_child_same_partner)', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(insertChild(t.orgB1, series));
    expect(sqlState(err)).toBe('23514');
    expect(constraintOf(err)).toBe('reports_series_child_same_partner');
  });

  it('a partner-owned (org_id NULL) row can never carry series_id', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(rows(null, sql`
      INSERT INTO reports (partner_id, org_id, name, type, schedule, series_id, series_revision)
      VALUES (${t.partnerA}, NULL, 'Aggregate', 'ar_aging', 'monthly', ${series}, 1)`));
    expect(constraintOf(err)).toBe('reports_series_child_shape_chk');
  });

  it('a series child can never be the portal self-service definition', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(rows(null, sql`
      INSERT INTO reports (org_id, name, type, schedule, series_id, series_revision, portal_self_service)
      VALUES (${t.orgA1}, 'x', 'executive_summary', 'monthly', ${series}, 1, true)`));
    expect(constraintOf(err)).toBe('reports_series_child_shape_chk');
  });

  it('one ACTIVE child per (org, series); archived siblings are allowed', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    await insertChild(t.orgA1, series, true);
    await insertChild(t.orgA1, series);
    const err = await failure(insertChild(t.orgA1, series));
    expect(sqlState(err)).toBe('23505');
    expect(constraintOf(err)).toBe('reports_series_active_child_uniq');
  });

  it('series_revision 0 (never-reconciled sentinel) is allowed; NULL on a child and negatives are not', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    await rows(null, sql`
      INSERT INTO reports (org_id, name, type, schedule, series_id, series_revision)
      VALUES (${t.orgA1}, 'x', 'executive_summary', 'monthly', ${series}, 0)`);
    const missing = await failure(rows(null, sql`
      INSERT INTO reports (org_id, name, type, schedule, series_id, series_revision)
      VALUES (${t.orgA2}, 'x', 'executive_summary', 'monthly', ${series}, NULL)`));
    expect(constraintOf(missing)).toBe('reports_series_revision_present_chk');
  });

  it('report_schedule_recipients.mode defaults to add and refuses anything but add/remove', async () => {
    const cols = await rows<{ column_default: string; is_nullable: string }>(null, sql`
      SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'report_schedule_recipients' AND column_name = 'mode'`);
    expect(cols).toEqual([{ column_default: "'add'::text", is_nullable: 'NO' }]);
    const check = await rows<{ def: string }>(null, sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'report_schedule_recipients_mode_chk'`);
    expect(check[0]?.def).toMatch(/'add'.*'remove'/);
  });

  it('an ORG token reads its own child and that child\'s runs, but not the series', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const child = await insertChild(t.orgA1, series);
    const runId = randomUUID();
    await rows(null, sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runId}, ${child}, 'completed')`);
    const org = orgContext(t.orgA1, t.partnerA);
    expect(await rows(org, sql`SELECT id FROM reports WHERE id = ${child}`)).toEqual([{ id: child }]);
    expect(await rows(org, sql`SELECT id FROM report_runs WHERE id = ${runId}`)).toEqual([{ id: runId }]);
    expect(await rows(org, sql`SELECT id FROM report_series WHERE id = ${series}`)).toHaveLength(0);
  });

  // Review Focus 3.
  it('deleting a series archives children the caller cannot see (out-of-service org) and SET NULLs series_id', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const visible = await insertChild(t.orgA1, series);
    const hidden = await insertChild(t.orgA2, series);
    const runId = randomUUID();
    await rows(null, sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runId}, ${hidden}, 'completed')`);
    await rows(null, sql`UPDATE organizations SET status = 'suspended' WHERE id = ${t.orgA2}`);

    // The partner request context only sees active/trial orgs (orgA2 is absent).
    const ctx = partnerContext(t.partnerA, [t.orgA1]);
    expect(await rows(ctx, sql`SELECT id FROM reports WHERE id = ${hidden}`)).toHaveLength(0);
    await rows(ctx, sql`DELETE FROM report_series WHERE id = ${series}`);

    const after = await rows<{ id: string; series_id: string | null; archived: boolean }>(null, sql`
      SELECT id, series_id, archived_at IS NOT NULL AS archived FROM reports
       WHERE id IN (${visible}, ${hidden}) ORDER BY id`);
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.series_id).toBeNull();
      expect(row.archived).toBe(true);
    }
    expect(await rows(null, sql`SELECT id FROM report_runs WHERE id = ${runId}`)).toHaveLength(1);
  });
});

describe('erasure', () => {
  it('cascadeDeletePartner erases a partner holding a series, a target and a child', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    await rows(null, sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgA1})`);
    const child = await insertChild(t.orgA2, series);

    await expect(cascadeDeletePartner(t.partnerA, randomUUID())).resolves.toBeDefined();

    expect(await rows(null, sql`SELECT id FROM report_series WHERE id = ${series}`)).toHaveLength(0);
    expect(await rows(null, sql`SELECT id FROM report_series_org_targets WHERE series_id = ${series}`)).toHaveLength(0);
    expect(await rows(null, sql`SELECT id FROM reports WHERE id = ${child}`)).toHaveLength(0);
  });
});
