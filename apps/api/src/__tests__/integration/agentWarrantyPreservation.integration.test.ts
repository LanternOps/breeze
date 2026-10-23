/**
 * Real-PostgreSQL proof that an AGENT-OWNED warranty row survives the
 * server-side warranty machinery (#5511 W01).
 *
 * Both properties proven here are invisible to the mocked unit suites:
 *
 *  - `syncWarrantyForDevice` reads the STORED row and branches on its
 *    `data_source`. Every unit test mocks `../db`, so that branch runs against
 *    a canned value rather than against the row the previous statement wrote.
 *  - `getDevicesNeedingWarrantySync`'s exclusion is a SQL predicate. The
 *    chainable select mock returns whatever rows it is handed regardless of the
 *    WHERE clause, so a unit test literally cannot fail when it is wrong.
 *
 * On unmodified code the first test is RED: the preservation branch is keyed to
 * the literal 'agent_plist' (`warrantySync.ts:153`), so an `agent_cmsl` row
 * falls through to the unknown-result upsert, which nulls both dates, empties
 * `entitlements` and flips `data_source` back to 'provider'. That is silent
 * data loss, not a cosmetic mislabel.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import {
  getDevicesNeedingWarrantySync,
  syncWarrantyForDevice,
  upsertAgentWarranty,
} from '../../services/warrantySync';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { org, site };
}

/** `is_virtual` and `is_ephemeral` default to false, so this row passes the sweep's exclusions. */
async function seedDevice(orgId: string, siteId: string, agentId: string): Promise<string> {
  const [row] = (await getTestDb().execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${orgId}, ${siteId}, ${agentId}, ${'hp-host-' + agentId}, 'windows', '11', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

/** The sweep requires a NON-NULL serial AND manufacturer on device_hardware. */
async function seedHardware(deviceId: string, orgId: string, manufacturer: string, serial: string): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO device_hardware (device_id, org_id, manufacturer, serial_number)
    VALUES (${deviceId}, ${orgId}, ${manufacturer}, ${serial})
  `);
}

interface StoredWarranty {
  data_source: string | null;
  start_date: string | null;
  end_date: string | null;
  entitlement_count: number;
  entitlement_provider: string | null;
  last_sync_at: string | null;
  next_sync_at: string | null;
}

async function readWarranty(deviceId: string): Promise<StoredWarranty[]> {
  return (await getTestDb().execute(sql`
    SELECT data_source,
           warranty_start_date::text        AS start_date,
           warranty_end_date::text          AS end_date,
           jsonb_array_length(entitlements) AS entitlement_count,
           entitlements #>> '{0,provider}'  AS entitlement_provider,
           last_sync_at::text               AS last_sync_at,
           next_sync_at::text               AS next_sync_at
    FROM device_warranty
    WHERE device_id = ${deviceId}
  `)) as unknown as StoredWarranty[];
}

describe('agent-owned warranty rows survive a server sync (#5511 W01, defect 2)', () => {
  runDb('an agent_cmsl row is preserved, not overwritten with an unknown provider result', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `hp-cmsl-${suffix}`);
    await seedHardware(deviceId, org.id, 'HP', `SN-HP-${suffix}`);

    await withSystemDbAccessContext(() =>
      upsertAgentWarranty(deviceId, org.id, {
        source: 'agent_cmsl',
        manufacturer: 'HP',
        serialNumber: `SN-HP-${suffix}`,
        coverageStartDate: '2024-03-01',
        coverageEndDate: '2099-03-01',
        coverageType: 'HP 3y Next Business Day Onsite',
        coverageKind: 'fixed',
      }),
    );

    // Precondition, asserted rather than assumed: without it a green result
    // below could mean the agent write never landed.
    const before = await readWarranty(deviceId);
    expect(before).toHaveLength(1);
    expect(before[0]!.data_source).toBe('agent_cmsl');

    // EXACTLY what the 7-day sweep does with a selected device subject, and
    // what a manual refresh queues.
    await withSystemDbAccessContext(() => syncWarrantyForDevice(deviceId));

    const after = await readWarranty(deviceId);
    expect(after).toHaveLength(1);
    // Nothing was fetched, so the preserve branch must not stamp lastSyncAt (the
    // device card polls it to decide a manual refresh completed).
    expect(after[0]!.last_sync_at).toBe(before[0]!.last_sync_at);
    expect(
      after[0]!.data_source,
      'a server sweep must never take ownership of an agent-collected row',
    ).toBe('agent_cmsl');
    expect(after[0]!.end_date, 'the agent-reported coverage end date must survive').toBe('2099-03-01');
    expect(after[0]!.start_date).toBe('2024-03-01');
    expect(after[0]!.entitlement_count, 'entitlements must not be emptied').toBe(1);
    expect(after[0]!.entitlement_provider).toBe('hp');
  });

  runDb('an agent_plist row is preserved too — the generalisation did not narrow it', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `apple-plist-${suffix}`);
    await seedHardware(deviceId, org.id, 'Apple Inc.', `SN-APPLE-${suffix}`);

    await withSystemDbAccessContext(() =>
      upsertAgentWarranty(deviceId, org.id, {
        source: 'agent_plist',
        manufacturer: 'Apple Inc.',
        serialNumber: `SN-APPLE-${suffix}`,
        coverageStartDate: '2024-01-01',
        coverageEndDate: '2098-01-01',
        coverageType: 'AppleCare+',
        coverageKind: 'fixed',
      }),
    );

    await withSystemDbAccessContext(() => syncWarrantyForDevice(deviceId));

    const after = await readWarranty(deviceId);
    expect(after).toHaveLength(1);
    expect(after[0]!.data_source).toBe('agent_plist');
    expect(after[0]!.end_date).toBe('2098-01-01');
    expect(after[0]!.entitlement_provider).toBe('apple');
  });

  runDb('a device no agent has claimed still gets the provider-owned unknown row — the preservation branch did not swallow everyone', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `whitebox-${suffix}`);
    await seedHardware(deviceId, org.id, 'Acme Whitebox', `SN-ACME-${suffix}`);

    // POSITIVE CONTROL. No provider is registered for this manufacturer, so the
    // sync takes the `!provider` fall-through and writes an `unknown` row with
    // data_source 'provider' — which is the CORRECT behaviour for a device no
    // agent has claimed, and must keep working after the fix.
    await withSystemDbAccessContext(() => syncWarrantyForDevice(deviceId));

    const after = await readWarranty(deviceId);
    expect(after).toHaveLength(1);
    expect(after[0]!.data_source).toBe('provider');
  });
});
describe('the fleet sweep excludes agent-owned rows (#5511 W01, D9)', () => {
  runDb('selects a device a vendor can answer for, skips one an agent owns', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const agentDeviceId = await seedDevice(org.id, site.id, `hp-owned-${suffix}`);
    await seedHardware(agentDeviceId, org.id, 'HP', `SN-HP-${suffix}`);

    const providerDeviceId = await seedDevice(org.id, site.id, `dell-provider-${suffix}`);
    await seedHardware(providerDeviceId, org.id, 'Dell Inc.', `SN-DELL-${suffix}`);

    await withSystemDbAccessContext(() =>
      upsertAgentWarranty(agentDeviceId, org.id, {
        source: 'agent_cmsl',
        manufacturer: 'HP',
        serialNumber: `SN-HP-${suffix}`,
        coverageStartDate: '2024-03-01',
        coverageEndDate: '2099-03-01',
        coverageType: 'HP 3y Next Business Day Onsite',
        coverageKind: 'fixed',
      }),
    );

    // upsertAgentWarranty stamped next_sync_at 7 days out. Make the row OVERDUE
    // so it would genuinely be a candidate on unmodified code — otherwise the
    // exclusion assertion below passes for the wrong reason.
    await getTestDb().execute(sql`
      UPDATE device_warranty SET next_sync_at = now() - interval '1 day'
      WHERE device_id = ${agentDeviceId}
    `);

    // The Dell device has no warranty row at all, which is the most overdue
    // state there is (the NULLS FIRST ordering exists for exactly that).
    const subjects = await withSystemDbAccessContext(() => getDevicesNeedingWarrantySync(100));
    const deviceIds = subjects.filter((s) => s.kind === 'device').map((s) => s.deviceId);

    // POSITIVE CONTROL FIRST. setup.ts TRUNCATEs `devices` on every beforeEach,
    // so these two are the only devices in the database — if the sweep returns
    // neither, the exclusion assertion below is vacuous.
    expect(
      deviceIds,
      'the sweep must still pick up a device a registered vendor provider can answer for',
    ).toContain(providerDeviceId);

    expect(
      deviceIds,
      'an agent-owned row must not be re-selected — it can only be overwritten, and it starves the page',
    ).not.toContain(agentDeviceId);
  });

  runDb('a device with NO warranty row is still selected (the NULL data_source arm)', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `never-synced-${suffix}`);
    await seedHardware(deviceId, org.id, 'Dell Inc.', `SN-NEW-${suffix}`);

    const subjects = await withSystemDbAccessContext(() => getDevicesNeedingWarrantySync(100));
    const deviceIds = subjects.filter((s) => s.kind === 'device').map((s) => s.deviceId);

    // `NULL NOT IN (...)` is NULL, not TRUE. Without the explicit isNull arm
    // this device would be silently dropped from the sweep forever.
    expect(deviceIds, 'a never-synced device is the most overdue subject there is').toContain(deviceId);
  });
});
