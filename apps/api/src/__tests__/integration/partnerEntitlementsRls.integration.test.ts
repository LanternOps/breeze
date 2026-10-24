/**
 * partner_entitlements — real-Postgres contract (Partner Entitlements W1,
 * Wisp W01 #9907).
 *
 * Shape 3 (partner-axis): partner_id only, NO org_id. Registered in
 * PARTNER_TENANT_TABLES only; partner purge reaches it through
 * cascadeDeletePartner's information_schema sweep, proven below.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { cascadeDeletePartner } from '../../services/tenantCascade';
import {
  __resetEntitlementCacheForTests,
  getEntitlements,
  revokeEntitlementRow,
  upsertEntitlementRow,
} from '../../services/entitlements';

const partnerA = randomUUID();
const partnerB = randomUUID();
const orgA = randomUUID();

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId, userId: null,
  };
}

const orgContext: DbAccessContext = {
  scope: 'organization', orgId: orgA, accessibleOrgIds: [orgA],
  accessiblePartnerIds: [], currentPartnerId: partnerA, userId: null,
};

const countRows = async (partnerId: string): Promise<number> => {
  const rows = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT count(*)::int AS n FROM partner_entitlements WHERE partner_id = ${partnerId}`))) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
};

describe('partner_entitlements — partner-axis RLS', () => {
  // Shared setup truncates partners before each test, so every case reseeds.
  beforeEach(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code, plan) VALUES
        (${partnerA}, 'Ent A', ${`ent-a-${partnerA}`}, 'USD', 'free'),
        (${partnerB}, 'Ent B', ${`ent-b-${partnerB}`}, 'USD', 'pro')`);
      await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, status, currency_code) VALUES
        (${orgA}, ${partnerA}, 'Ent Org A', ${`ent-org-a-${orgA}`}, 'active', 'USD')`);
      await db.execute(sql`INSERT INTO partner_entitlements (partner_id, feature_key, state, source, reason)
        VALUES (${partnerA}, 'wisp', 'disabled', 'manual', 'seeded manual row for partner A')`);
    });
  });

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM partner_entitlements WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM organizations WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`);
    });
  });

  it('ENABLE + FORCE RLS', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'partner_entitlements'`));
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('partner B cannot INSERT a partner A row (42501)', async () => {
    await expect(withDbAccessContext(partnerContext(partnerB), () => db.execute(sql`
      INSERT INTO partner_entitlements (partner_id, feature_key, state, source)
      VALUES (${partnerA}, 'wisp', 'enabled', 'billing')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await countRows(partnerA)).toBe(1);
  });

  it('partner B cannot UPDATE a partner A row (0 rows)', async () => {
    const updated = await withDbAccessContext(partnerContext(partnerB), () => db.execute(sql`
      UPDATE partner_entitlements SET state = 'enabled' WHERE partner_id = ${partnerA} RETURNING id`));
    expect(updated).toHaveLength(0);
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT state FROM partner_entitlements WHERE partner_id = ${partnerA}`));
    expect(rows).toEqual([{ state: 'disabled' }]);
  });

  it('partner A reads its own row; partner B reads none of A', async () => {
    const stmt = sql`SELECT feature_key FROM partner_entitlements WHERE partner_id = ${partnerA}`;
    expect(await withDbAccessContext(partnerContext(partnerA), () => db.execute(stmt))).toHaveLength(1);
    expect(await withDbAccessContext(partnerContext(partnerB), () => db.execute(stmt))).toHaveLength(0);
  });

  // ---- no self-grant: partner-axis READ, system-only WRITE --------------------
  // A partner can never write its OWN entitlement rows, even though
  // breeze_has_partner_access(partner_id) is true for them. Every grant goes
  // through services/entitlements.ts, which elects system scope.

  it('policies: one SELECT-only partner read policy and one system-only write policy', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT policyname, cmd, permissive, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'partner_entitlements' ORDER BY policyname`)) as unknown as
      Array<{ policyname: string; cmd: string; permissive: string; qual: string | null; with_check: string | null }>;
    expect(rows.map((r) => [r.policyname, r.cmd, r.permissive])).toEqual([
      ['partner_entitlements_partner_read', 'SELECT', 'PERMISSIVE'],
      ['partner_entitlements_system_write', 'ALL', 'PERMISSIVE'],
    ]);
    // The write policy's predicates are a conjunction that requires system scope.
    const write = rows.find((r) => r.policyname === 'partner_entitlements_system_write')!;
    for (const expr of [write.qual, write.with_check]) {
      expect(expr).toMatch(/breeze_current_scope\(\) = 'system'::text\) AND (public\.)?breeze_has_partner_access\(partner_id\)/);
      expect(expr).not.toMatch(/\bOR\b/);
    }
  });

  it('partner A cannot INSERT its OWN row (42501)', async () => {
    await expect(withDbAccessContext(partnerContext(partnerA), () => db.execute(sql`
      INSERT INTO partner_entitlements (partner_id, feature_key, state, source)
      VALUES (${partnerA}, 'wisp', 'enabled', 'billing')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await countRows(partnerA)).toBe(1);
  });

  it('partner A cannot upsert (INSERT … ON CONFLICT DO UPDATE) its OWN row (42501)', async () => {
    await expect(withDbAccessContext(partnerContext(partnerA), () => db.execute(sql`
      INSERT INTO partner_entitlements (partner_id, feature_key, state, source, reason)
      VALUES (${partnerA}, 'wisp', 'enabled', 'manual', 'self-grant attempt')
      ON CONFLICT (partner_id, feature_key, source) DO UPDATE SET state = 'enabled'`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT state FROM partner_entitlements WHERE partner_id = ${partnerA}`));
    expect(rows).toEqual([{ state: 'disabled' }]);
  });

  it('partner A cannot UPDATE its OWN row (0 rows), yet still SELECTs it', async () => {
    const { updated, visible } = await withDbAccessContext(partnerContext(partnerA), async () => ({
      updated: await db.execute(sql`
        UPDATE partner_entitlements SET state = 'enabled' WHERE partner_id = ${partnerA} RETURNING id`),
      visible: await db.execute(sql`SELECT state FROM partner_entitlements WHERE partner_id = ${partnerA}`),
    }));
    // CONTROL: the same context sees the row, so 0 updated is the write policy, not invisibility.
    expect(visible).toEqual([{ state: 'disabled' }]);
    expect(updated).toHaveLength(0);
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT state FROM partner_entitlements WHERE partner_id = ${partnerA}`));
    expect(rows).toEqual([{ state: 'disabled' }]);
  });

  it('partner A cannot DELETE its OWN row (0 rows), yet still SELECTs it', async () => {
    const { deleted, visible } = await withDbAccessContext(partnerContext(partnerA), async () => ({
      deleted: await db.execute(sql`
        DELETE FROM partner_entitlements WHERE partner_id = ${partnerA} RETURNING id`),
      visible: await db.execute(sql`SELECT id FROM partner_entitlements WHERE partner_id = ${partnerA}`),
    }));
    expect(visible).toHaveLength(1);
    expect(deleted).toHaveLength(0);
    expect(await countRows(partnerA)).toBe(1);
  });

  it.each([
    ['state', sql`('x', 'manual', 'reason long enough')`, 'partner_entitlements_state_chk'],
    ['source', sql`('enabled', 'plan', 'reason long enough')`, 'partner_entitlements_source_chk'],
    ['manual reason', sql`('enabled', 'manual', NULL)`, 'partner_entitlements_manual_reason_chk'],
  ] as const)('CHECK %s fails 23514', async (_name, tail, constraint) => {
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_entitlements (partner_id, feature_key, state, source, reason)
      SELECT ${partnerB}, 'verified_library', v.state, v.source, v.reason
      FROM (VALUES ${tail}) AS v(state, source, reason)`)))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: constraint } });
  });

  it('unique (partner_id, feature_key, source) conflicts 23505', async () => {
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_entitlements (partner_id, feature_key, state, source, reason)
      VALUES (${partnerA}, 'wisp', 'enabled', 'manual', 'a second manual row')`)))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'partner_entitlements_partner_key_source_uq' } });
  });

  it('two sources for one key coexist as two rows', async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_entitlements (partner_id, feature_key, state, source)
      VALUES (${partnerA}, 'wisp', 'enabled', 'billing')`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT source FROM partner_entitlements WHERE partner_id = ${partnerA} AND feature_key = 'wisp' ORDER BY source`));
    expect(rows).toEqual([{ source: 'billing' }, { source: 'manual' }]);
  });

  it('org-scoped context reads ZERO rows directly', async () => {
    const rows = await withDbAccessContext(orgContext, () => db.execute(sql`
      SELECT id FROM partner_entitlements WHERE partner_id = ${partnerA}`));
    expect(rows).toHaveLength(0);
  });

  // ---- service path (Task 4) ------------------------------------------------

  it('org-scoped context resolves the CORRECT rows through getEntitlements (#2822 class)', async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_entitlements SET state = 'enabled' WHERE partner_id = ${partnerA} AND source = 'manual'`));
    __resetEntitlementCacheForTests();
    const { resolved, bare } = await withDbAccessContext(orgContext, async () => ({
      resolved: await getEntitlements(partnerA),
      bare: await db.execute(sql`SELECT id FROM partner_entitlements WHERE partner_id = ${partnerA}`),
    }));
    // Control: the bare read in the same context is blind, so 'manual' can only
    // have come through the partner-axis escape.
    expect(bare).toHaveLength(0);
    expect(resolved.plan).toBe('free');
    expect(resolved.entitlements.wisp).toMatchObject({ state: 'enabled', source: 'manual' });
  });

  it('concurrent billing and manual upserts for one key land as two rows, neither clobbering the other', async () => {
    await Promise.all([
      upsertEntitlementRow({ partnerId: partnerB, featureKey: 'wisp', source: 'billing', state: 'enabled', limits: null, expiresAt: null, reason: null, updatedBy: null }),
      upsertEntitlementRow({ partnerId: partnerB, featureKey: 'wisp', source: 'manual', state: 'disabled', limits: null, expiresAt: null, reason: 'abuse hold pending review', updatedBy: null }),
    ]);
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT source, state FROM partner_entitlements WHERE partner_id = ${partnerB} ORDER BY source`));
    expect(rows).toEqual([{ source: 'billing', state: 'enabled' }, { source: 'manual', state: 'disabled' }]);
    __resetEntitlementCacheForTests();
    const resolved = await getEntitlements(partnerB);
    expect(resolved.plan).toBe('pro');
    expect(resolved.entitlements.wisp).toMatchObject({ state: 'disabled', source: 'manual' });
  });

  it('revoke keeps the grant reason when none is given; upsert after revoke re-grants the same row (revoked_at cleared)', async () => {
    expect(await revokeEntitlementRow({ partnerId: partnerA, featureKey: 'wisp', source: 'manual', reason: null })).toBe(true);
    expect(await revokeEntitlementRow({ partnerId: partnerA, featureKey: 'wisp', source: 'manual', reason: null })).toBe(false);
    const revoked = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT id, revoked_at, reason FROM partner_entitlements WHERE partner_id = ${partnerA}`))) as unknown as Array<{ id: string; revoked_at: Date | null; reason: string }>;
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.revoked_at).not.toBeNull();
    expect(revoked[0]!.reason).toBe('seeded manual row for partner A');

    await upsertEntitlementRow({ partnerId: partnerA, featureKey: 'wisp', source: 'manual', state: 'enabled', limits: { maxGrants: 2, budgetCentsPerDayCeiling: 100, minFloorTickMinutes: 30 }, expiresAt: null, reason: 're-granted after review', updatedBy: null });
    const regranted = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT id, revoked_at, state, reason, limits FROM partner_entitlements WHERE partner_id = ${partnerA}`))) as unknown as Array<Record<string, unknown>>;
    expect(regranted).toHaveLength(1);
    expect(regranted[0]).toMatchObject({ id: revoked[0]!.id, revoked_at: null, state: 'enabled', reason: 're-granted after review' });
    expect(regranted[0]!.limits).toEqual({ maxGrants: 2, budgetCentsPerDayCeiling: 100, minFloorTickMinutes: 30 });
  });

  // Review focus 5: a platform admin whose own request context is partner A
  // writes partner B. Without the runOutsideDbContext escape the nested
  // system context would keep A's GUCs and the write would fail 42501.
  it('upsert and revoke for partner B succeed from inside a partner-A request context', async () => {
    // CONTROL: partner A's context cannot write B directly.
    await expect(withDbAccessContext(partnerContext(partnerA), () => db.execute(sql`
      INSERT INTO partner_entitlements (partner_id, feature_key, state, source)
      VALUES (${partnerB}, 'wisp', 'enabled', 'billing')`))).rejects.toMatchObject({ cause: { code: '42501' } });

    await withDbAccessContext(partnerContext(partnerA), () =>
      upsertEntitlementRow({ partnerId: partnerB, featureKey: 'verified_library', source: 'manual', state: 'disabled', limits: null, expiresAt: null, reason: 'cross-partner admin write', updatedBy: null }));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT feature_key, state FROM partner_entitlements WHERE partner_id = ${partnerB}`));
    expect(rows).toEqual([{ feature_key: 'verified_library', state: 'disabled' }]);

    const revoked = await withDbAccessContext(partnerContext(partnerA), () =>
      revokeEntitlementRow({ partnerId: partnerB, featureKey: 'verified_library', source: 'manual', reason: 'cross-partner revoke' }));
    expect(revoked).toBe(true);
  });

  it('revoke returns false for a row already past its grace window', async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_entitlements SET expires_at = now() - interval '20 days'
      WHERE partner_id = ${partnerA} AND source = 'manual'`));
    expect(await revokeEntitlementRow({ partnerId: partnerA, featureKey: 'wisp', source: 'manual', reason: null })).toBe(false);
    // Still within grace (13 days past expiry) → live → revocable.
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_entitlements SET expires_at = now() - interval '13 days'
      WHERE partner_id = ${partnerA} AND source = 'manual'`));
    expect(await revokeEntitlementRow({ partnerId: partnerA, featureKey: 'wisp', source: 'manual', reason: null })).toBe(true);
  });

  it('cascadeDeletePartner removes the rows with no hand registration', async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_entitlements (partner_id, feature_key, state, source)
      VALUES (${partnerA}, 'wisp', 'enabled', 'billing')`));
    // CONTROL: rows exist, so a zero afterwards is evidence about the sweep.
    expect(await countRows(partnerA)).toBe(2);
    await expect(cascadeDeletePartner(partnerA, randomUUID())).resolves.toBeDefined();
    expect(await countRows(partnerA)).toBe(0);
  });
});
