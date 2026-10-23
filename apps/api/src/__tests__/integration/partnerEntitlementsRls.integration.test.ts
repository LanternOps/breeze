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

  it('partner B cannot UPDATE a partner A row (42501 or 0 rows)', async () => {
    let affected: number | null = null;
    try {
      const res = await withDbAccessContext(partnerContext(partnerB), () => db.execute(sql`
        UPDATE partner_entitlements SET state = 'enabled' WHERE partner_id = ${partnerA} RETURNING id`));
      affected = (res as unknown as unknown[]).length;
    } catch (err) {
      expect(err).toMatchObject({ cause: { code: '42501' } });
    }
    if (affected !== null) expect(affected).toBe(0);
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT state FROM partner_entitlements WHERE partner_id = ${partnerA}`));
    expect(rows).toEqual([{ state: 'disabled' }]);
  });

  it('partner A reads its own row; partner B reads none of A', async () => {
    const stmt = sql`SELECT feature_key FROM partner_entitlements WHERE partner_id = ${partnerA}`;
    expect(await withDbAccessContext(partnerContext(partnerA), () => db.execute(stmt))).toHaveLength(1);
    expect(await withDbAccessContext(partnerContext(partnerB), () => db.execute(stmt))).toHaveLength(0);
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
