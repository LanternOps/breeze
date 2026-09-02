import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  type DbAccessContext,
} from '../../db';
import { exchangeRates } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

// exchange_rates is GLOBAL reporting reference data (multi-currency spec §8):
// no org_id / partner_id / device_id. Forced RLS with a permissive SELECT
// (rates are public facts every tenant context may read) and system-only
// writes. This suite is the CI-enforced proof of that contract — the
// INTENTIONAL_UNSCOPED entry in rls-coverage.integration.test.ts is
// documentation only (auto-discovery keys on the presence of an org_id column).
function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

const KEY = { rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD' } as const;

async function systemDelete() {
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.delete(exchangeRates).where(
        and(
          eq(exchangeRates.rateDate, KEY.rateDate),
          eq(exchangeRates.baseCode, KEY.baseCode),
          eq(exchangeRates.quoteCode, KEY.quoteCode),
        ),
      ),
    ),
  );
}

describe('exchange_rates tenancy contract', () => {
  beforeEach(systemDelete);

  it('system context can INSERT, SELECT, UPDATE and DELETE', async () => {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const inserted = await db
          .insert(exchangeRates)
          .values({ ...KEY, rate: '1.09000000', source: 'ecb' })
          .returning({ rate: exchangeRates.rate });
        expect(inserted).toHaveLength(1);

        const updated = await db
          .update(exchangeRates)
          .set({ rate: '1.10000000', source: 'manual' })
          .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode)))
          .returning({ source: exchangeRates.source });
        expect(updated).toEqual([{ source: 'manual' }]);

        const deleted = await db
          .delete(exchangeRates)
          .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode)))
          .returning({ rate: exchangeRates.rate });
        expect(deleted).toHaveLength(1);
      }),
    );
  });

  it('tenant context can SELECT (rates are public reference data)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.insert(exchangeRates).values({ ...KEY, rate: '1.09000000', source: 'ecb' }),
      ),
    );

    const rows = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ rate: exchangeRates.rate }).from(exchangeRates)
        .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode))),
    );
    expect(rows).toEqual([{ rate: '1.09000000' }]);
  });

  it('tenant context cannot INSERT (RLS 42501)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(
      withDbAccessContext(orgContext(org.id), () =>
        db.insert(exchangeRates).values({ ...KEY, rate: '9.99000000', source: 'manual' }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('tenant context cannot UPDATE or DELETE (RLS 42501 / zero rows)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.insert(exchangeRates).values({ ...KEY, rate: '1.09000000', source: 'manual' }),
      ),
    );

    // FORCE + a system-only FOR ALL policy: the tenant sees the row through the
    // permissive SELECT policy but the UPDATE/DELETE USING clause excludes it,
    // so the write either raises 42501 or silently affects zero rows. Both are
    // acceptable; a MUTATED row is not.
    await withDbAccessContext(orgContext(org.id), async () => {
      await db.update(exchangeRates).set({ rate: '99.00000000' })
        .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode)))
        .catch((err: unknown) => { expect(err).toMatchObject({ cause: { code: '42501' } }); });
      await db.delete(exchangeRates)
        .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode)))
        .catch((err: unknown) => { expect(err).toMatchObject({ cause: { code: '42501' } }); });
    });

    const [row] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.select({ rate: exchangeRates.rate }).from(exchangeRates)
          .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode))),
      ),
    );
    expect(row).toEqual({ rate: '1.09000000' });
  });

  // The behavioural cases above prove the OBSERVED effect. These prove the
  // CONTRACT itself: rls-coverage.integration.test.ts discovers tenant tables
  // by their org_id column and from the explicit tenant-shape sets, so a
  // GLOBAL table is invisible to it — enabled/forced and the exact policy pair
  // are asserted nowhere else in the repo. supported_currencies (wave 1) is
  // asserted here too: it carries the identical contract and had the same gap.
  it.each(['exchange_rates', 'supported_currencies'])('%s has RLS ENABLED and FORCED', async (table) => {
    const [row] = (await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
      SELECT c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ${table}
    `)))) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each(['exchange_rates', 'supported_currencies'])('%s exposes exactly one public SELECT policy and one system-only ALL policy', async (table) => {
    const rows = (await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
      SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr,
             pg_get_expr(polwithcheck, polrelid) AS check_expr, polpermissive
      FROM pg_policy WHERE polrelid = ${table}::regclass ORDER BY polname
    `)))) as unknown as Array<{ polname: string; polcmd: string; using_expr: string | null; check_expr: string | null; polpermissive: boolean }>;

    // polcmd: 'r' = SELECT, '*' = ALL. NO unexpected extras — an added
    // permissive INSERT/UPDATE policy would silently open tenant writes.
    expect(rows).toHaveLength(2);
    const read = rows.find((r) => r.polcmd === 'r')!;
    const all = rows.find((r) => r.polcmd === '*')!;
    expect(read).toBeDefined();
    expect(read.polpermissive).toBe(true);
    expect(read.using_expr).toBe('true');
    expect(read.check_expr).toBeNull();
    expect(all).toBeDefined();
    for (const expr of [all.using_expr, all.check_expr]) {
      expect(expr).toContain("current_setting('breeze.scope'");
      expect(expr).toContain("'system'");
    }
  });

  it.each([
    ['unknown source', { ...KEY, rate: '1.00000000', source: 'oracle' }, '23514'],
    ['non-positive rate', { ...KEY, rate: '0.00000000', source: 'ecb' }, '23514'],
    ['base equals quote', { rateDate: KEY.rateDate, baseCode: 'EUR', quoteCode: 'EUR', rate: '1.00000000', source: 'ecb' }, '23514'],
    ['unsupported currency', { rateDate: KEY.rateDate, baseCode: 'EUR', quoteCode: 'ZZZ', rate: '1.00000000', source: 'ecb' }, '23503'],
  ])('rejects %s under system context (%s)', async (_label, values, code) => {
    await expect(
      runOutsideDbContext(() =>
        withSystemDbAccessContext(() => db.insert(exchangeRates).values(values as never)),
      ),
    ).rejects.toMatchObject({ cause: { code } });
  });
});
