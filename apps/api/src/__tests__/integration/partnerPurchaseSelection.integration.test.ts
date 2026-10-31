import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { LEGACY_LAUNCH_CAPACITIES } from '@breeze/shared';
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
    }).returning({ id: partners.id, selection: partners.purchaseSelection, plan: partners.plan, maxDevices: partners.maxDevices });
  });
}

describe('partners.purchase_selection database boundary', () => {
  it('keeps legacy partners nullable without granting plan or capacity', async () => {
    expect(await insertSelection(undefined, true)).toEqual([{ id: expect.any(String), selection: null, plan: 'free', maxDevices: null }]);
  });

  it('accepts each approved tuple and preserves it without granting entitlements', async () => {
    for (const billingPeriod of ['monthly', 'annual'] as const) {
      for (const capacity of LEGACY_LAUNCH_CAPACITIES[billingPeriod]) {
        const selection = { catalogVersion, capacity, billingPeriod };
        expect(await insertSelection(selection)).toEqual([{ id: expect.any(String), selection, plan: 'free', maxDevices: null }]);
      }
    }
  });

  it.each([
    { intent: 'cloud' }, { intent: 'cloud', offer: 'founding' },
    { intent: 'wisp' }, { intent: 'wisp', offer: 'founding' },
  ])('accepts the intent shape and preserves it: %j', async (value) => {
    expect(await insertSelection(value)).toEqual([{ id: expect.any(String), selection: value, plan: 'free', maxDevices: null }]);
  });

  it.each([
    { intent: 'hosting' }, { intent: 'cloud', offer: 'Founding' }, { intent: 'cloud', offer: 7 },
    { intent: 'cloud', offer: null }, { intent: 'cloud', capacity: 250 }, { intent: null }, { offer: 'founding' },
    { intent: 'cloud', offer: '' }, { intent: 'cloud', offer: 'a'.repeat(33) }, { intent: 'cloud', offer: 'founding\n' },
  ])('rejects a malformed intent shape: %j', async (value) => {
    await expect(insertSelection(value)).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'partners_purchase_selection_valid' } });
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

  it('replays the intent migration and the legacy one without altering stored rows', async () => {
    const [launch] = await insertSelection(selected);
    const [intent] = await insertSelection({ intent: 'cloud' });
    expect(launch?.selection).toEqual(selected);
    await replayMigration('2027-01-18-140000-partner-purchase-selection-intent.sql');
    await replayMigration('2027-01-18-140000-partner-purchase-selection-intent.sql');
    // The intent row is the real proof here: if the legacy file re-added its narrower
    // CHECK, that ADD would fail to validate this row. replayMigration re-applies later
    // files afterwards, so the rejects below pass either way.
    await replayMigration('2026-12-18-110000-partner-purchase-selection.sql');
    const rows = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      return tx.execute(sql`SELECT purchase_selection FROM partners WHERE id IN (${launch!.id}, ${intent!.id})`);
    });
    expect(rows.map((r: any) => r.purchase_selection)).toEqual(expect.arrayContaining([selected, { intent: 'cloud' }]));
    await expect(insertSelection({ ...selected, capacity: 150 })).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(insertSelection({ intent: 'hosting' })).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
