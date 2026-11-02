/**
 * Real-PostgreSQL proof that the warranty fleet sweep respects the partner
 * export lock hierarchy (#10403).
 *
 * Every `device_warranty` write fires the partner-export material triggers,
 * which take `breeze_partner_export_lock_orgs_exclusive` for the row's org —
 * and that takes a SHARED lock on the org's partner first. Inside ONE
 * transaction the lock functions enforce:
 *   - no new partner lock once any org lock is held, and
 *   - org locks in ascending UUID order.
 * The sweep ran all 50 subjects in a single `withSystemDbAccessContext`
 * transaction, so the second subject whose org sat under a different partner
 * (or under a lower org UUID) raised P0001, aborted the transaction, failed
 * every later statement and rolled back every earlier write. On US prod
 * (2026-10-28) the batch therefore wrote nothing at all.
 *
 * The mocked unit suites cannot see this: the locks live in plpgsql triggers.
 *
 * Manufacturer 'Acme Whitebox' has no registered provider, so the sync takes
 * the no-provider branch and upserts an `unknown` row — no vendor HTTP call.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { processWarrantyJob } from '../../services/warrantyWorker';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MANUFACTURER = 'Acme Whitebox';

async function seedDevice(orgId: string, siteId: string, tag: string): Promise<string> {
  const suffix = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [row] = (await getTestDb().execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${orgId}, ${siteId}, ${'agent-' + suffix}, ${'host-' + suffix}, 'windows', '11', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const deviceId = row!.id;
  await getTestDb().execute(sql`
    INSERT INTO device_hardware (device_id, org_id, manufacturer, serial_number)
    VALUES (${deviceId}, ${orgId}, ${MANUFACTURER}, ${'SN-' + suffix})
  `);
  return deviceId;
}

async function seedOrgDevice(partnerId: string, tag: string) {
  const org = await createOrganization({ partnerId });
  const site = await createSite({ orgId: org.id });
  const deviceId = await seedDevice(org.id, site.id, tag);
  return { orgId: org.id as string, deviceId };
}

async function readWarranty(deviceIds: string[]) {
  return (await getTestDb().execute(sql`
    SELECT device_id::text AS device_id, status, data_source
    FROM device_warranty
    WHERE device_id IN (${sql.join(deviceIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY device_id
  `)) as unknown as Array<{ device_id: string; status: string; data_source: string | null }>;
}

describe('warranty fleet sweep vs the partner export lock hierarchy (#10403)', () => {
  runDb('syncs subjects whose orgs sit under different partners', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const a = await seedOrgDevice(partnerA.id, 'a');
    const b = await seedOrgDevice(partnerB.id, 'b');

    const result = await processWarrantyJob({ type: 'sync-batch' });

    expect(result).toMatchObject({ synced: 2, failed: 0 });
    const rows = await readWarranty([a.deviceId, b.deviceId]);
    expect(rows.map((r) => r.device_id).sort()).toEqual([a.deviceId, b.deviceId].sort());
    for (const row of rows) {
      expect(row.status).toBe('unknown');
      expect(row.data_source).toBe('provider');
    }
  });

  runDb('syncs same-partner orgs even when the sweep visits the higher org UUID first', async () => {
    const partner = await createPartner();
    const first = await seedOrgDevice(partner.id, 'x');
    const second = await seedOrgDevice(partner.id, 'y');
    const [high, low] = first.orgId > second.orgId ? [first, second] : [second, first];

    // Pin the sweep order: it sorts by next_sync_at ASC, so the HIGHER org's
    // row (more overdue) is visited first. A material column (status/end date)
    // differs from what the unknown upsert writes, so both UPDATEs lock.
    for (const [subject, overdueDays] of [[high, 2], [low, 1]] as const) {
      await getTestDb().execute(sql`
        INSERT INTO device_warranty (device_id, org_id, manufacturer, serial_number, status,
                                     warranty_end_date, data_source, next_sync_at)
        VALUES (${subject.deviceId}, ${subject.orgId}, 'acme whitebox', 'SN', 'active',
                '2099-01-01', 'provider', now() - make_interval(days => ${overdueDays}))
      `);
    }

    const result = await processWarrantyJob({ type: 'sync-batch' });

    expect(result).toMatchObject({ synced: 2, failed: 0 });
    const rows = await readWarranty([high.deviceId, low.deviceId]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status, 'the sweep must have rewritten the overdue row').toBe('unknown');
    }
  });
});
