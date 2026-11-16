import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { replayMigration } from './replayMigration';
import { partners } from '../../db/schema/orgs';

const expiresAt = new Date('2030-01-01T00:00:00Z');
const violation = { cause: { code: '23514', constraint_name: 'partners_billing_admission_valid' } };

async function insertAllowance(input: {
  maxDevices: number | null;
  limit: number | null;
  expiresAt: Date | null;
}) {
  return getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
    return tx.insert(partners).values({
      name: 'Billing admission bound test', slug: `admission-${randomUUID()}`,
      maxDevices: input.maxDevices,
      billingAdmissionLimit: input.limit,
      billingAdmissionExpiresAt: input.expiresAt,
    }).returning({ id: partners.id, limit: partners.billingAdmissionLimit });
  });
}

describe('partners.billing_admission_limit database bound', () => {
  it('accepts an allowance up to 2 x max_devices for a large commitment', async () => {
    expect(await insertAllowance({ maxDevices: 2000, limit: 2500, expiresAt }))
      .toEqual([{ id: expect.any(String), limit: 2500 }]);
    expect(await insertAllowance({ maxDevices: 2000, limit: 4000, expiresAt }))
      .toEqual([{ id: expect.any(String), limit: 4000 }]);
  });

  it('evaluates the bound without integer overflow for a huge max_devices', async () => {
    // 2 * 2,000,000,000 exceeds int4; the CHECK must compute it in bigint, not raise 22003.
    expect(await insertAllowance({ maxDevices: 2_000_000_000, limit: 2_100_000_000, expiresAt }))
      .toEqual([{ id: expect.any(String), limit: 2_100_000_000 }]);
  });

  it('rejects an allowance above 2 x max_devices', async () => {
    await expect(insertAllowance({ maxDevices: 2000, limit: 4001, expiresAt })).rejects.toMatchObject(violation);
  });

  it('keeps the 1,100 floor for small or absent max_devices', async () => {
    expect(await insertAllowance({ maxDevices: 110, limit: 1100, expiresAt }))
      .toEqual([{ id: expect.any(String), limit: 1100 }]);
    await expect(insertAllowance({ maxDevices: 110, limit: 1101, expiresAt })).rejects.toMatchObject(violation);
    expect(await insertAllowance({ maxDevices: null, limit: 1100, expiresAt }))
      .toEqual([{ id: expect.any(String), limit: 1100 }]);
    await expect(insertAllowance({ maxDevices: null, limit: 1101, expiresAt })).rejects.toMatchObject(violation);
  });

  it('still requires an expiry with a limit and a positive limit', async () => {
    await expect(insertAllowance({ maxDevices: 2000, limit: 2500, expiresAt: null })).rejects.toMatchObject(violation);
    await expect(insertAllowance({ maxDevices: 2000, limit: 0, expiresAt })).rejects.toMatchObject(violation);
    expect(await insertAllowance({ maxDevices: 2000, limit: null, expiresAt: null }))
      .toEqual([{ id: expect.any(String), limit: null }]);
  });

  it('replays the bound migration and the original one without narrowing the bound', async () => {
    const [wide] = await insertAllowance({ maxDevices: 2000, limit: 2500, expiresAt });
    await replayMigration('2027-01-27-120000-partner-billing-admission-bound.sql');
    await replayMigration('2027-01-27-120000-partner-billing-admission-bound.sql');
    // The stored 2,500 row is the real proof: if the original file re-added its
    // 1..1100 CHECK, that ADD would fail to validate this row.
    await replayMigration('2026-12-18-120000-partner-billing-admission.sql');
    const rows = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      return tx.select({ limit: partners.billingAdmissionLimit }).from(partners).where(eq(partners.id, wide!.id));
    });
    expect(rows).toEqual([{ limit: 2500 }]);
    await expect(insertAllowance({ maxDevices: 2000, limit: 4001, expiresAt })).rejects.toMatchObject(violation);
  });
});
