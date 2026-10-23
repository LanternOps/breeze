import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { LAUNCH_MONTHLY_PRICES_USD, LAUNCH_ANNUAL_TOTALS_USD } from '@breeze/shared';
import { getTestDb } from './setup';
import { replayMigration } from './replayMigration';
import { partners } from '../../db/schema/orgs';

const catalogVersion = 'launch-2026-10';
const selected = { catalogVersion, capacity: 250, billingPeriod: 'annual' };

async function insertSelection(value: unknown, omitted = false) {
  return getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
    return tx.insert(partners).values({
      name: 'Purchase selection test', slug: `selection-${randomUUID()}`,
      ...(omitted ? {} : { purchaseSelection: sql`${JSON.stringify(value)}::jsonb` }),
    }).returning({ selection: partners.purchaseSelection, plan: partners.plan, maxDevices: partners.maxDevices });
  });
}

describe('partners.purchase_selection database boundary', () => {
  it('keeps legacy partners nullable without granting plan or capacity', async () => {
    expect(await insertSelection(undefined, true)).toEqual([{ selection: null, plan: 'free', maxDevices: null }]);
  });

  it('accepts each approved tuple and preserves it without granting entitlements', async () => {
    for (const [billingPeriod, prices] of [['monthly', LAUNCH_MONTHLY_PRICES_USD], ['annual', LAUNCH_ANNUAL_TOTALS_USD]] as const) {
      for (const capacity of Object.keys(prices).map(Number)) {
        const selection = { catalogVersion, capacity, billingPeriod };
        expect(await insertSelection(selection)).toEqual([{ selection, plan: 'free', maxDevices: null }]);
      }
    }
  });

  it.each([
    {}, { capacity: 250 }, { catalogVersion, capacity: 250 },
    { ...selected, catalogVersion: null }, { ...selected, capacity: null },
    { ...selected, billingPeriod: null }, { ...selected, capacity: '250' },
    { ...selected, capacity: true }, { ...selected, capacity: 250.5 },
    { ...selected, capacity: 150 }, { ...selected, capacity: 0 },
    { ...selected, catalogVersion: 'legacy' }, { ...selected, billingPeriod: 'yearly' },
    { ...selected, priceId: 'price_client' }, [], [selected], null, 'selected', 250,
  ])('rejects malformed JSON or an unavailable tuple: %j', async (value) => {
    // Explicit JSON null is invalid; SQL NULL above remains the legacy default.
    await expect(insertSelection(value)).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'partners_purchase_selection_valid' } });
  });

  it('can replay the new migration without altering a stored selection', async () => {
    const [row] = await insertSelection(selected);
    expect(row?.selection).toEqual(selected);
    await replayMigration('2026-12-18-110000-partner-purchase-selection.sql');
    await replayMigration('2026-12-18-110000-partner-purchase-selection.sql');
    await expect(insertSelection({ ...selected, capacity: 150 })).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
