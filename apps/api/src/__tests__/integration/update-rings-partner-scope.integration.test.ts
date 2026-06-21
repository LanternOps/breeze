/**
 * Real-driver cross-tenant forge tests for partner-axis patch tables.
 *
 * Runs under vitest.integration.config.ts — connects as the unprivileged
 * `breeze_app` role (rolbypassrls=f), so RLS is genuinely enforced. If
 * .env.test is missing the symlink, these tests pass vacuously on a
 * BYPASSRLS admin connection (see memory: worktree_env_test_rls_vacuous) —
 * the forged-insert assertions guard against that.
 *
 * Coverage:
 *   - patch_policies (partner-axis, RLS shape 3):
 *       partner B context reading partner A's ring → 0 rows (isolation)
 *       forged cross-partner INSERT (partner B context, partnerId=partnerA)
 *         rejected with RLS violation (42501)
 *       system scope CAN read the seeded ring (existence probe — non-vacuous)
 *
 * Drizzle wraps the driver error: the original Postgres 42501
 * ("new row violates row-level security policy for table …") surfaces on
 * `err.cause.code`. We assert on `cause.code` to match the verified sibling
 * pattern (stripe-payments-rls / catalog-rls).
 *
 * Why NO memoization: setup.ts cleanupDatabase() TRUNCATEs partners/
 * organizations in beforeEach — module-scope fixtures would be wiped before
 * the second test, making the RLS assertions vacuous (see memory:
 * rls-forge-test-memoized-fixture-vacuous). Each runDb() re-seeds fresh.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { patchPolicies } from '../../db/schema/patches';
import { createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    const [ringA] = await db
      .insert(patchPolicies)
      .values({
        partnerId: partnerA.id,
        kind: 'ring',
        name: `forge-ring-A-${Date.now()}`,
      })
      .returning();
    if (!ringA) throw new Error('failed to seed ring A');

    return { partnerA, partnerB, ringA };
  });
}

describe('patch_policies RLS — partner isolation forge (breeze_app)', () => {
  runDb('partner B cannot read partner A ring (0-row isolation)', async () => {
    const { partnerB, ringA } = await seed();
    const rows = await withDbAccessContext(partnerCtx(partnerB.id), () =>
      db.select({ id: patchPolicies.id }).from(patchPolicies).where(eq(patchPolicies.id, ringA.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('forged cross-partner INSERT is rejected by WITH CHECK (42501)', async () => {
    const { partnerA, partnerB } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(patchPolicies).values({
          partnerId: partnerA.id, // forged — RLS WITH CHECK must reject
          kind: 'ring',
          name: `forge-x-${Date.now()}`,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('system scope can read seeded ring (existence probe — non-vacuous)', async () => {
    const { ringA } = await seed();
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: patchPolicies.id }).from(patchPolicies).where(eq(patchPolicies.id, ringA.id))
    );
    expect(rows).toHaveLength(1);
  });
});
