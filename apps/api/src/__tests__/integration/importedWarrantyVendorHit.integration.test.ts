/**
 * Real-PostgreSQL proof of the #9862 rule for a vendor HIT on an imported
 * warranty row: the hit replaces the import only when that loses no coverage.
 *
 * Invisible to the mocked unit suite: the hit's upsert carries a `setWhere`
 * with a `warranty_end_date <= $vendorEnd` arm. Only a real database proves it
 * compiles against a `date` column AND still lets a later vendor date through
 * (a wrong guard fails closed, silently keeping the import forever).
 *
 * The vendor is mocked — CI has no OEM API keys — but only at the provider
 * boundary; everything from the advisory read to the upsert is the real code.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const vendorAnswer = vi.hoisted(() => ({
  current: null as null | {
    found: boolean;
    entitlements: Array<Record<string, string>>;
    warrantyStartDate: string | null;
    warrantyEndDate: string | null;
  },
}));

vi.mock('../../services/warrantyProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/warrantyProviders')>();
  return {
    ...actual,
    getProviderForManufacturer: (manufacturer: string) =>
      actual.normalizeManufacturer(manufacturer) === 'dell'
        ? {
            name: 'dell',
            supports: () => true,
            isConfigured: () => true,
            lookup: async (serials: string[]) => new Map(serials.map((s) => [s, vendorAnswer.current!])),
          }
        : null,
  };
});

import { withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { syncWarrantyForDevice } from '../../services/warrantySync';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const VENDOR_BASE = {
  provider: 'dell',
  serviceLevelDescription: 'Basic Hardware Service',
  entitlementType: 'INITIAL',
  startDate: '2023-03-31',
  endDate: '2026-03-31',
};

async function seedImportedDevice(importedEndDate: string): Promise<string> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [device] = (await getTestDb().execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${org.id}, ${site.id}, ${'dell-' + suffix}, ${'dell-host-' + suffix}, 'windows', '11', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const deviceId = device!.id;
  await getTestDb().execute(sql`
    INSERT INTO device_hardware (device_id, org_id, manufacturer, serial_number)
    VALUES (${deviceId}, ${org.id}, 'Dell Inc.', ${'SN-' + suffix})
  `);
  // The row the custom-field importer writes (`warrantyTarget.ts`).
  await getTestDb().execute(sql`
    INSERT INTO device_warranty (device_id, org_id, manufacturer, serial_number, status,
                                 warranty_start_date, warranty_end_date, data_source)
    VALUES (${deviceId}, ${org.id}, 'dell', ${'SN-' + suffix}, 'active',
            '2023-03-31', ${importedEndDate}, 'import')
  `);
  return deviceId;
}

async function readWarranty(deviceId: string) {
  const rows = (await getTestDb().execute(sql`
    SELECT data_source,
           warranty_end_date::text          AS end_date,
           jsonb_array_length(entitlements) AS entitlement_count,
           entitlements #>> '{0,endDate}'   AS entitlement_end,
           last_sync_at
    FROM device_warranty WHERE device_id = ${deviceId}
  `)) as unknown as Array<{
    data_source: string | null;
    end_date: string | null;
    entitlement_count: number;
    entitlement_end: string | null;
    last_sync_at: unknown;
  }>;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('a vendor hit never shortens imported warranty coverage (#9862)', () => {
  runDb('import ending 2028 + vendor hit ending 2026: the import is kept, the vendor answer recorded', async () => {
    const deviceId = await seedImportedDevice('2028-06-30');
    vendorAnswer.current = {
      found: true, entitlements: [VENDOR_BASE], warrantyStartDate: '2023-03-31', warrantyEndDate: '2026-03-31',
    };

    await withSystemDbAccessContext(() => syncWarrantyForDevice(deviceId, { force: true }));

    const after = await readWarranty(deviceId);
    expect(after.data_source, 'the import keeps ownership').toBe('import');
    expect(after.end_date, 'the imported (longer) coverage survives').toBe('2028-06-30');
    expect(after.entitlement_count, "the vendor's answer is recorded beside it").toBe(1);
    expect(after.entitlement_end).toBe('2026-03-31');
    expect(after.last_sync_at, 'a vendor was asked, so the check is stamped').not.toBeNull();
  });

  runDb('import ending 2028 + vendor hit ending 2030: the vendor wins through the SQL guard', async () => {
    const deviceId = await seedImportedDevice('2028-06-30');
    vendorAnswer.current = {
      found: true,
      entitlements: [{ ...VENDOR_BASE, endDate: '2030-01-31' }],
      warrantyStartDate: '2023-03-31',
      warrantyEndDate: '2030-01-31',
    };

    await withSystemDbAccessContext(() => syncWarrantyForDevice(deviceId, { force: true }));

    const after = await readWarranty(deviceId);
    expect(after.data_source).toBe('provider');
    expect(after.end_date).toBe('2030-01-31');
  });
});
