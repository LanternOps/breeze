/**
 * Functional forge proof for accounting_connections.
 *
 * The table is partner-axis (RLS shape 3) and must be protected by the flat
 * public.breeze_has_partner_access(partner_id) policies. These tests run
 * through the real driver as the unprivileged app role under the integration
 * config; do not run them with plain unit-test Vitest config.
 *
 * Fixtures are deliberately re-seeded per test. The integration setup truncates
 * tenant data between tests, so a memoized fixture would be stale and vacuous.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { accountingConnections } from '../../db/schema';
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

async function seedTwoPartners() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    return { partnerA, partnerB, partnerAContext: partnerCtx(partnerA.id) };
  });
}

async function captureCause(fn: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } }).cause;
  }
}

describe('accounting_connections RLS — partner-axis forge (breeze_app role)', () => {
  // Non-vacuity guard: if the code-under-test pool is ever a BYPASSRLS role
  // (e.g. a worktree missing its .env.test symlink), every forge assertion
  // below passes even with broken policies. Fail loudly here first.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const { partnerAContext } = await seedTwoPartners();
    const rows = await withDbAccessContext(partnerAContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  runDb('allows a legitimate partner-A accounting connection insert', async () => {
    const { partnerA, partnerAContext } = await seedTwoPartners();

    const [row] = await withDbAccessContext(partnerAContext, () =>
      db
        .insert(accountingConnections)
        .values({
          partnerId: partnerA.id,
          provider: 'quickbooks',
          environment: 'production',
        })
        .returning({ id: accountingConnections.id })
    );

    expect(row?.id).toBeDefined();
  });

  runDb('hides a partner-B accounting connection from partner-A SELECT', async () => {
    const { partnerB, partnerAContext } = await seedTwoPartners();

    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(accountingConnections)
        .values({
          partnerId: partnerB.id,
          provider: 'quickbooks',
          environment: 'production',
        })
        .returning({ id: accountingConnections.id })
    );
    expect(seeded?.id).toBeDefined();
    if (!seeded) throw new Error('seed insert returned no row');

    const systemProbe = await withSystemDbAccessContext(() =>
      db
        .select({ id: accountingConnections.id })
        .from(accountingConnections)
        .where(eq(accountingConnections.id, seeded.id))
    );
    expect(systemProbe).toHaveLength(1);

    const rows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: accountingConnections.id })
        .from(accountingConnections)
        .where(eq(accountingConnections.id, seeded.id))
    );

    expect(rows).toEqual([]);
  });

  runDb('rejects a forged cross-partner accounting connection insert', async () => {
    const { partnerB, partnerAContext } = await seedTwoPartners();

    const cause = await captureCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(accountingConnections).values({
          partnerId: partnerB.id,
          provider: 'quickbooks',
          environment: 'production',
        })
      )
    );

    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/row-level security/i);
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "accounting_connections"/
    );
  });
});
