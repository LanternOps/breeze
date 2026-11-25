/**
 * partner_deploy_keys — cross-partner forge proof (breeze_app role).
 * Migration under test: 2027-01-31-100000-partner-deploy-keys.sql.
 * Shape 3 (partner-axis): system OR breeze_has_partner_access(partner_id),
 * narrowed by a RESTRICTIVE system-only policy: every read and write goes
 * through system scope (services/deployKeys/*), never a partner request
 * context.
 * Proves: partner-scope INSERT refused for any partner (42501), the other
 * partner's included; partner-scope SELECT, UPDATE and DELETE see nothing,
 * own partner included; system scope reads, updates and deletes; the CHECKs
 * hold the ceilings and the revocation shape; the partner erasure sweep still
 * works; the FKs have the declared delete actions.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/partnerDeployKeysRls.integration.test.ts
 */
import './setup';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partnerDeployKeys } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

async function cause(fn: () => Promise<unknown>) {
  try { await fn(); return undefined; } catch (err) {
    return (err as { cause?: { code?: string; message?: string } }).cause;
  }
}

async function seedTwoPartners() {
  const a = await createPartner();
  const orgA = await createOrganization({ partnerId: a.id });
  const b = await createPartner();
  const ctxA: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [a.id] };
  return { a, b, ctxA };
}

const keyRow = (partnerId: string) => ({
  partnerId,
  name: 'Front desk',
  imageLabel: 'win11',
  keyHash: randomBytes(32).toString('hex'),
  expiresAt: sql`now() + interval '30 days'`,
  maxUsage: 10,
  maxParked: 5,
});

const insertSystem = (partnerId: string) => withSystemDbAccessContext(() =>
  db.insert(partnerDeployKeys).values(keyRow(partnerId)).returning({ id: partnerDeployKeys.id }));

describe('partner_deploy_keys RLS (breeze_app)', () => {
  it('refuses a cross-partner INSERT', async () => {
    const { b, ctxA } = await seedTwoPartners();
    const c = await cause(() => withDbAccessContext(ctxA, () => db.insert(partnerDeployKeys).values(keyRow(b.id))));
    expect(c?.code).toBe('42501');
    expect(c?.message).toMatch(/row-level security policy for table "partner_deploy_keys"/);
  });

  it('refuses an own-partner INSERT from a partner request context', async () => {
    const { a, ctxA } = await seedTwoPartners();
    const c = await cause(() => withDbAccessContext(ctxA, () => db.insert(partnerDeployKeys).values(keyRow(a.id))));
    expect(c?.code).toBe('42501');
    expect(c?.message).toMatch(/row-level security policy "partner_deploy_keys_system_only" for table "partner_deploy_keys"/);
  });

  it('hides every key from a partner request context, own partner included; system scope sees them', async () => {
    const { a, b, ctxA } = await seedTwoPartners();
    const [rowA] = await insertSystem(a.id);
    const [rowB] = await insertSystem(b.id);
    const read = (id: string) => db.select({ id: partnerDeployKeys.id }).from(partnerDeployKeys).where(eq(partnerDeployKeys.id, id));
    expect(await withDbAccessContext(ctxA, () => read(rowA!.id))).toEqual([]);
    expect(await withDbAccessContext(ctxA, () => read(rowB!.id))).toEqual([]);
    expect(await withSystemDbAccessContext(() => read(rowA!.id))).toHaveLength(1);
    expect(await withSystemDbAccessContext(() => read(rowB!.id))).toHaveLength(1);
  });

  it('a partner request context cannot UPDATE or DELETE a key, own partner included', async () => {
    const { a, b, ctxA } = await seedTwoPartners();
    const [own] = await insertSystem(a.id);
    const [other] = await insertSystem(b.id);
    for (const row of [own!, other!]) {
      const updated = await withDbAccessContext(ctxA, () => db.update(partnerDeployKeys)
        .set({ maxUsage: 1000 }).where(eq(partnerDeployKeys.id, row.id)).returning({ id: partnerDeployKeys.id }));
      expect(updated).toEqual([]);
      const deleted = await withDbAccessContext(ctxA, () => db.delete(partnerDeployKeys)
        .where(eq(partnerDeployKeys.id, row.id)).returning({ id: partnerDeployKeys.id }));
      expect(deleted).toEqual([]);
      const [still] = await getTestDb().select({ maxUsage: partnerDeployKeys.maxUsage }).from(partnerDeployKeys).where(eq(partnerDeployKeys.id, row.id));
      expect(still!.maxUsage).toBe(10);
    }
  });

  it('a partner request context cannot re-home a key into its own partner', async () => {
    const { a, b, ctxA } = await seedTwoPartners();
    const [other] = await insertSystem(b.id);
    const moved = await withDbAccessContext(ctxA, () => db.update(partnerDeployKeys)
      .set({ partnerId: a.id }).where(eq(partnerDeployKeys.id, other!.id)).returning({ id: partnerDeployKeys.id }));
    expect(moved).toEqual([]);
  });

  it('system scope updates and deletes; the partner erasure sweep removes the keys', async () => {
    const { a } = await seedTwoPartners();
    const [row] = await insertSystem(a.id);
    const revoked = await withSystemDbAccessContext(() => db.update(partnerDeployKeys)
      .set({ status: 'revoked', revokedAt: new Date() }).where(eq(partnerDeployKeys.id, row!.id)).returning({ id: partnerDeployKeys.id }));
    expect(revoked).toHaveLength(1);
    await insertSystem(a.id);
    // Same statement shape as cascadeDeletePartner's dynamic partner_id sweep.
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM partner_deploy_keys WHERE partner_id = ${a.id}::uuid`));
    const left = await getTestDb().select({ id: partnerDeployKeys.id }).from(partnerDeployKeys).where(eq(partnerDeployKeys.partnerId, a.id));
    expect(left).toEqual([]);
  });

  it.each([
    ['max_usage above 1000', { maxUsage: 1001 }],
    ['max_usage 0', { maxUsage: 0 }],
    ['max_parked above 20', { maxParked: 21 }],
    ['max_parked 0', { maxParked: 0 }],
    ['negative usage_count', { usageCount: -1 }],
    ['usage_count above max_usage', { usageCount: 11 }],
    ['a lifetime above 365 days', { expiresAt: sql`now() + interval '366 days'` }],
    ['an expiry before creation', { expiresAt: sql`now() - interval '1 second'` }],
    ['an unknown status', { status: 'paused' }],
    ['revoked without revoked_at', { status: 'revoked' }],
    ['active with revoked_at', { revokedAt: new Date() }],
    ['a blank name', { name: '   ' }],
    ['a blank image label', { imageLabel: ' ' }],
    ['an empty source list', { sourceCidrs: sql`ARRAY[]::cidr[]` }],
  ])('rejects %s (23514)', async (_label, patch) => {
    const { a } = await seedTwoPartners();
    const c = await cause(() => withSystemDbAccessContext(() =>
      db.insert(partnerDeployKeys).values({ ...keyRow(a.id), ...(patch as object) } as any)));
    expect(c?.code).toBe('23514');
  });

  it('accepts exactly 365 days and the ceilings', async () => {
    const { a } = await seedTwoPartners();
    const rows = await withSystemDbAccessContext(() => db.insert(partnerDeployKeys).values({
      ...keyRow(a.id), expiresAt: sql`now() + interval '365 days'`, maxUsage: 1000, maxParked: 20, usageCount: 1000,
    }).returning({ id: partnerDeployKeys.id }));
    expect(rows).toHaveLength(1);
  });

  it('refuses a duplicate key hash (23505)', async () => {
    const { a, b } = await seedTwoPartners();
    const row = keyRow(a.id);
    await withSystemDbAccessContext(() => db.insert(partnerDeployKeys).values(row));
    const c = await cause(() => withSystemDbAccessContext(() => db.insert(partnerDeployKeys).values({ ...keyRow(b.id), keyHash: row.keyHash })));
    expect(c?.code).toBe('23505');
  });

  it('declares the FK delete actions: partner cascade, users and rotation lineage set null', async () => {
    const fks = await getTestDb().execute(sql`
      SELECT a.attname AS column, c.confdeltype AS action, c.confrelid::regclass::text AS target
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.conrelid = 'partner_deploy_keys'::regclass AND c.contype = 'f'
       ORDER BY a.attname`) as unknown as Array<{ column: string; action: string; target: string }>;
    expect(fks).toEqual([
      { column: 'created_by', action: 'n', target: 'users' },
      { column: 'partner_id', action: 'c', target: 'partners' },
      { column: 'revoked_by', action: 'n', target: 'users' },
      { column: 'rotated_from_id', action: 'n', target: 'partner_deploy_keys' },
    ]);
  });

  it('the holding-area ledger keeps no FK to the keys (snapshot record)', async () => {
    const fks = await getTestDb().execute(sql`
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'device_pool_assignment_events'::regclass AND contype = 'f'
         AND confrelid = 'partner_deploy_keys'::regclass`) as unknown as unknown[];
    expect(fks).toEqual([]);
  });
});
